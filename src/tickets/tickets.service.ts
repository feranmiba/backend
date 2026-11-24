import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toBuffer } from 'qrcode';
import {
  EventStatus,
  Prisma,
  ResaleListing,
  ResaleListingStatus,
  Ticket,
  TicketStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UNASSIGNED_SEAT } from '../common/constants/seat.constant';
import { REVOKE_BATCH_CHUNK_SIZE } from '../common/constants/revoke-batch.constant';
import {
  ListingInactiveError,
  TicketTypeSoldOutError,
} from '../common/errors/domain.error';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  OnChainTicket,
  SignedInvocation,
  StellarService,
} from '../stellar/stellar.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notifications.service';
import { OfflineTokenService } from './offline-token.service';
import { QrTokenService } from './qr-token.service';
import { PromoCodesService } from '../promo-codes/promo-codes.service';
import { GatesService } from '../gates/gates.service';
import { FeatureFlagsService } from '../config/feature-flags.service';

/** How long an offline-verifiable token stays valid before a scanner must re-verify online. */
const OFFLINE_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/** Plain JSON for `ProcessedTx.response`: BigInts become strings, as they do in HTTP responses. */
function toStoredResponse(value: unknown): Prisma.InputJsonValue {
  if (value === undefined || value === null) {
    return Prisma.JsonNull as unknown as Prisma.InputJsonValue;
  }
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    ),
  ) as Prisma.InputJsonValue;
}

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
    private readonly stellar: StellarService,
    @Optional() private readonly notifications?: NotificationService,
    @Optional() private readonly offlineTokens?: OfflineTokenService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly promoCodes?: PromoCodesService,
    @Optional() private readonly gates?: GatesService,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly featureFlags?: FeatureFlagsService,
    @Optional() private readonly qrTokens?: QrTokenService,
  ) {}

  // ---- Organizer-authorized issuance (off-chain payment already settled) ----

  async buildIssueTx(
    userId: string,
    ticketTypeId: string,
    toUserId: string,
    toPublicKey: string,
    seat?: string,
  ) {
    const { ticketType, event } =
      await this.getTicketTypeWithEvent(ticketTypeId);
    await this.organizations.assertMember(event.organizationId, userId);
    this.assertHasCapacity(ticketType.quantityIssued, ticketType.quantityTotal);
    this.assertSaleWindow(ticketType.saleStartsAt, ticketType.saleEndsAt);
    if (event.status !== EventStatus.PUBLISHED || event.chainEventId === null) {
      throw new BadRequestException(
        event.status === EventStatus.CANCELLED
          ? 'Event has been cancelled'
          : 'Event has not been published on-chain yet',
      );
    }

    const toUser = await this.getUserWithWallet(toUserId);
    this.assertRecipientPublicKey(toUser.stellarPublicKey, toPublicKey);
    const unsignedXdr = await this.stellar.buildIssueTicketTx({
      organizerPublicKey: event.organization.stellarAccount,
      chainEventId: event.chainEventId,
      toPublicKey: toUser.stellarPublicKey!,
      tier: ticketType.name,
      seat: seat ?? UNASSIGNED_SEAT,
      price: ticketType.price,
    });
    return { unsignedXdr };
  }

  async confirmIssue(
    userId: string,
    ticketTypeId: string,
    toUserId: string,
    toPublicKey: string,
    seat: string | undefined,
    signedXdr: string,
  ) {
    const { ticketType, event } =
      await this.getTicketTypeWithEvent(ticketTypeId);
    await this.organizations.assertMember(event.organizationId, userId);
    const replay = await this.findProcessedTx<Ticket>(signedXdr);
    if (replay) return replay.value;
    const toUser = await this.getUserWithWallet(toUserId);
    this.assertRecipientPublicKey(toUser.stellarPublicKey, toPublicKey);
    // #377 — the DB row must describe the ticket the chain will mint.
    this.assertSignedInvocation(signedXdr, 'issue_ticket', [
      ['organizer', 0, event.organization.stellarAccount],
      ['event', 1, event.chainEventId],
      ['recipient', 2, toUser.stellarPublicKey],
      ['tier', 3, ticketType.name],
      ['seat', 4, seat ?? UNASSIGNED_SEAT],
    ]);
    // #211 — fail fast on duplicate assigned seats before touching the chain.
    await this.assertSeatAvailable(event.id, seat);

    const { result, txHash } =
      await this.stellar.submitSignedTransaction(signedXdr);
    const chainTicketId = result as bigint;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // #217 — serialize concurrent issuances: lock the TicketType row and
        // re-check capacity FROM the locked row. The pre-transaction
        // assertHasCapacity only sees a possibly-stale read.
        const locked = await tx.$queryRaw<
          { quantityIssued: number; quantityTotal: number }[]
        >`SELECT "quantityIssued", "quantityTotal" FROM "TicketType" WHERE "id" = ${ticketTypeId} FOR UPDATE`;
        const row = locked[0];
        if (!row) {
          throw new BadRequestException('Ticket type not found');
        }
        this.assertHasCapacity(row.quantityIssued, row.quantityTotal);

        return this.recordIssuedTicket(tx, {
          eventId: event.id,
          ticketTypeId,
          ownerId: toUserId,
          chainTicketId,
          seat,
          issuedTxHash: txHash,
          signedXdr,
          operation: 'issue',
        });
      });
    } catch (err) {
      this.throwOnSeatConflict(err);
      throw err;
    }
  }

  // ---- Batch organizer-authorized issuance ----

  /**
   * #133 — Builds one `issue_ticket` transaction envelope per recipient in
   * `recipients`, up to `ISSUE_BATCH_MAX_SIZE` at once (default 50).
   *
   * The batch is processed optimistically: each recipient is attempted
   * independently, so a failure for one (e.g. seat conflict, user not found)
   * is collected and returned alongside the successful payloads rather than
   * aborting the whole request. Callers iterate `results` and re-drive any
   * `status: "error"` entries individually.
   *
   * Only the build step is batched here. Each recipient still calls
   * `POST /tickets/confirm-issue` individually so the Stellar transaction
   * submission and DB writes remain atomic per ticket.
   */
  async buildIssueBatch(
    userId: string,
    ticketTypeId: string,
    recipients: Array<{ toUserId: string; toPublicKey: string; seat?: string }>,
  ) {
    const maxBatchSize = this.config?.get<number>('ISSUE_BATCH_MAX_SIZE') ?? 50;
    if (recipients.length > maxBatchSize) {
      throw new BadRequestException(
        `Batch size exceeds the maximum of ${maxBatchSize} recipients`,
      );
    }

    const { ticketType, event } =
      await this.getTicketTypeWithEvent(ticketTypeId);
    await this.organizations.assertMember(event.organizationId, userId);

    if (event.status !== EventStatus.PUBLISHED || event.chainEventId === null) {
      throw new BadRequestException(
        event.status === EventStatus.CANCELLED
          ? 'Event has been cancelled'
          : 'Event has not been published on-chain yet',
      );
    }

    const results = await Promise.all(
      recipients.map(async ({ toUserId, toPublicKey, seat }) => {
        try {
          const toUser = await this.prisma.user.findUnique({
            where: { id: toUserId },
          });
          if (!toUser) {
            return {
              toUserId,
              status: 'error' as const,
              error: 'User not found',
            };
          }
          if (!toUser.stellarPublicKey) {
            return {
              toUserId,
              status: 'error' as const,
              error:
                'Connect a Stellar wallet to your account before continuing',
            };
          }
          if (toUser.stellarPublicKey !== toPublicKey) {
            return {
              toUserId,
              status: 'error' as const,
              error: 'Recipient public key does not match target user',
            };
          }

          const unsignedXdr = await this.stellar.buildIssueTicketTx({
            organizerPublicKey: event.organization.stellarAccount,
            chainEventId: event.chainEventId!,
            toPublicKey: toUser.stellarPublicKey,
            tier: ticketType.name,
            seat: seat ?? UNASSIGNED_SEAT,
            price: ticketType.price,
          });

          return { toUserId, status: 'ok' as const, unsignedXdr };
        } catch (err) {
          return {
            toUserId,
            status: 'error' as const,
            error: (err as Error).message ?? 'Unknown error',
          };
        }
      }),
    );

    return {
      ticketTypeId,
      total: recipients.length,
      succeeded: results.filter((r) => r.status === 'ok').length,
      failed: results.filter((r) => r.status === 'error').length,
      results,
    };
  }

  // ---- Fully on-chain primary sale ----

  async buildPurchaseTx(
    buyerId: string,
    ticketTypeId: string,
    seat?: string,
    promoCode?: string,
  ) {
    const { ticketType, event } =
      await this.getTicketTypeWithEvent(ticketTypeId);
    this.assertHasCapacity(ticketType.quantityIssued, ticketType.quantityTotal);
    if (event.status !== EventStatus.PUBLISHED || event.chainEventId === null) {
      throw new BadRequestException(
        event.status === EventStatus.CANCELLED
          ? 'Event has been cancelled'
          : 'Event has not been published on-chain yet',
      );
    }
    const buyer = await this.getUserWithWallet(buyerId);
    // The on-chain tier price is the contract's source of truth after #127;
    // still validate a promo code here so an invalid one fails at build time.
    if (promoCode) {
      await this.promoCodes!.validate(
        event.id,
        buyerId,
        promoCode,
        ticketType.price,
      );
    }

    const unsignedXdr = await this.stellar.buildPurchasePrimaryTx({
      buyerPublicKey: buyer.stellarPublicKey!,
      chainEventId: event.chainEventId,
      tier: ticketType.name,
      seat: seat ?? UNASSIGNED_SEAT,
    });
    return { unsignedXdr };
  }

  async confirmPurchase(
    buyerId: string,
    ticketTypeId: string,
    seat: string | undefined,
    signedXdr: string,
    promoCode?: string,
  ) {
    const { ticketType, event } =
      await this.getTicketTypeWithEvent(ticketTypeId);
    const replay = await this.findProcessedTx<Ticket>(signedXdr);
    if (replay) return replay.value;
    const buyer = await this.getUserWithWallet(buyerId);
    // #377 — the DB row must describe the ticket the chain will mint.
    this.assertSignedInvocation(signedXdr, 'purchase_primary', [
      ['buyer', 0, buyer.stellarPublicKey],
      ['event', 1, event.chainEventId],
      ['tier', 2, ticketType.name],
      ['seat', 3, seat ?? UNASSIGNED_SEAT],
    ]);
    // #211 — fail fast on duplicate assigned seats before touching the chain.
    await this.assertSeatAvailable(event.id, seat);
    const { result, txHash } = await this.stellar.submitSignedTransaction(
      signedXdr,
      this.attendeeSubmitOptions(),
    );
    const chainTicketId = result as bigint;

    let ticket;
    try {
      ticket = await this.prisma.$transaction(async (tx) => {
        // #217 — serialize concurrent purchases: lock the TicketType row and
        // re-check capacity FROM the locked row, so concurrent buyers cannot
        // both pass the pre-transaction capacity check and oversell
        // quantityTotal.
        const locked = await tx.$queryRaw<
          { quantityIssued: number; quantityTotal: number }[]
        >`SELECT "quantityIssued", "quantityTotal" FROM "TicketType" WHERE "id" = ${ticketTypeId} FOR UPDATE`;
        const row = locked[0];
        if (!row) {
          throw new BadRequestException('Ticket type not found');
        }
        this.assertHasCapacity(row.quantityIssued, row.quantityTotal);

        return this.recordIssuedTicket(tx, {
          eventId: event.id,
          ticketTypeId,
          ownerId: buyerId,
          chainTicketId,
          seat,
          issuedTxHash: txHash,
          signedXdr,
          operation: 'purchase',
        });
      });
    } catch (err) {
      this.throwOnSeatConflict(err);
      throw err;
    }
    if (promoCode) {
      await this.promoCodes!.redeem(event.id, buyerId, promoCode, ticket.id);
    }
    if (this.notifications) {
      await this.notifications.sendTicketReceipt({
        to: buyer.email,
        buyerName: buyer.name,
        eventName: event.name,
        ticketType: ticketType.name,
        seat: seat ?? UNASSIGNED_SEAT,
      });
    }
    return ticket;
  }

  // ---- Direct transfer ----

  async buildTransferTx(
    userId: string,
    ticketId: string,
    toUserId: string,
    toPublicKey: string,
  ) {
    const ticket = await this.getOwnedTicket(ticketId, userId);
    const owner = await this.getUserWithWallet(userId);
    const toUser = await this.getUserWithWallet(toUserId);
    this.assertRecipientPublicKey(toUser.stellarPublicKey, toPublicKey);

    const unsignedXdr = await this.stellar.buildTransferTicketTx({
      fromPublicKey: owner.stellarPublicKey!,
      chainTicketId: ticket.chainTicketId,
      toPublicKey: toUser.stellarPublicKey!,
    });
    return { unsignedXdr };
  }

  async confirmTransfer(
    userId: string,
    ticketId: string,
    toUserId: string,
    toPublicKey: string,
    signedXdr: string,
  ) {
    const ticket = await this.getOwnedTicket(ticketId, userId);
    const replay = await this.findProcessedTx<Ticket>(signedXdr);
    if (replay) return replay.value;
    const toUser = await this.getUserWithWallet(toUserId);
    this.assertRecipientPublicKey(toUser.stellarPublicKey, toPublicKey);
    // #375 — reject a transfer signed to a different wallet than toUserId's
    // before it ever reaches the chain.
    this.assertSignedInvocation(signedXdr, 'transfer_ticket', [
      ['ticket', 1, ticket.chainTicketId],
      ['recipient', 2, toUser.stellarPublicKey],
    ]);
    await this.stellar.submitSignedTransaction(
      signedXdr,
      this.attendeeSubmitOptions(),
    );

    // #375 — the chain is the source of truth for ownership: only record
    // toUserId once the on-chain owner is confirmed to be their wallet.
    // `stellarPublicKey` is unique, so this is the user that wallet maps to.
    const onChain = await this.stellar.verifyTicket(ticket.chainTicketId);
    if (onChain.owner !== toUser.stellarPublicKey) {
      throw new ConflictException(
        'On-chain owner does not match the requested recipient',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // #378 — the contract clears a listing when a listed ticket is
      // transferred; mirror that so the marketplace stops showing it.
      await tx.resaleListing.updateMany({
        where: { ticketId, status: ResaleListingStatus.ACTIVE },
        data: { status: ResaleListingStatus.CANCELLED },
      });
      const transferred = await tx.ticket.update({
        where: { id: ticketId },
        data: { ownerId: toUserId, status: TicketStatus.VALID },
      });
      await this.recordProcessedTx(tx, signedXdr, 'transfer', transferred);
      return transferred;
    });
  }

  // ---- Verification (read-only, organizer/gate staff) ----

  async verify(userId: string, qrSecret: string) {
    // #129 — a rotating token carries the ticket id instead of the static
    // secret; it is checked (signature, then expiry) before any lookup.
    const ticket = await this.loadTicketForOrganizer(
      userId,
      QrTokenService.isToken(qrSecret)
        ? { id: this.qrTokens!.verify(qrSecret) }
        : { qrSecret },
    );

    // #321 — Graceful degradation: if the Soroban RPC is unavailable, serve
    // the cached DB data with a `stale: true` marker rather than throwing.
    let onChain: OnChainTicket | null = null;
    try {
      onChain = await this.stellar.verifyTicket(ticket.chainTicketId);
    } catch (err) {
      this.logger.warn(
        `Soroban RPC unavailable during verify (ticketId=${ticket.id}): ${(err as Error).message}. Serving cached data.`,
      );
    }

    let reconciledStatus: TicketStatus = ticket.status;
    let ownerName = ticket.owner.name;
    // #380 — the DB owner is only the real holder while their wallet is the
    // on-chain owner; staff must be warned when the two disagree.
    let ownerMismatch = false;

    if (onChain) {
      reconciledStatus = onChain.status.toUpperCase() as TicketStatus;
      ownerMismatch = ticket.owner.stellarPublicKey !== onChain.owner;
      // `stellarPublicKey` is unique, so this is a single index lookup. An
      // on-chain owner with no account here leaves `ownerId` as it is.
      const chainOwner = ownerMismatch
        ? await this.prisma.user.findUnique({
            where: { stellarPublicKey: onChain.owner },
            select: { id: true, name: true },
          })
        : null;
      if (chainOwner) {
        ownerName = chainOwner.name;
      }

      if (reconciledStatus !== ticket.status || chainOwner) {
        await this.prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            ...(reconciledStatus !== ticket.status && {
              status: reconciledStatus,
            }),
            ...(chainOwner && { ownerId: chainOwner.id }),
          },
        });
      }
    }

    return {
      ticketId: ticket.id,
      eventName: ticket.event.name,
      tier: ticket.ticketType.name,
      seat: ticket.seat,
      ownerName,
      status: reconciledStatus,
      onChainOwner: onChain?.owner ?? null,
      ownerMismatch,
      stale: onChain === null,
    };
  }

  // ---- Offline gate verification (see docs/OFFLINE_VERIFICATION.md) ----

  getOfflinePublicKeys() {
    return this.offlineTokens!.getPublicKeys();
  }

  async getOfflineToken(userId: string, ticketId: string) {
    const ticket = await this.getTicketWithOrg(ticketId);
    await this.organizations.assertMember(ticket.event.organizationId, userId);

    return this.offlineTokens!.sign({
      ticketId: ticket.id,
      chainTicketId: ticket.chainTicketId.toString(),
      eventId: ticket.eventId,
      status: ticket.status,
      exp: Math.floor(Date.now() / 1000) + OFFLINE_TOKEN_TTL_SECONDS,
    });
  }

  // ---- Check-in ----

  async buildCheckInTx(userId: string, ticketId: string) {
    const ticket = await this.loadTicketForOrganizer(userId, { id: ticketId });

    const unsignedXdr = await this.stellar.buildCheckInTx({
      organizerPublicKey: ticket.event.organization.stellarAccount,
      chainTicketId: ticket.chainTicketId,
    });
    return { unsignedXdr };
  }

  async confirmCheckIn(
    userId: string,
    ticketId: string,
    signedXdr: string,
    gateId?: string,
    reason?: string,
  ) {
    const ticket = await this.loadTicketForOrganizer(userId, { id: ticketId });
    const replay = await this.findProcessedTx<Ticket>(signedXdr);
    if (replay) return replay.value;
    this.assertSignedInvocation(signedXdr, 'check_in', [
      ['organizer', 0, ticket.event.organization.stellarAccount],
      ['ticket', 1, ticket.chainTicketId],
    ]);
    if (gateId) {
      await this.gates!.assertBelongsToEvent(gateId, ticket.eventId);
    }
    await this.stellar.submitSignedTransaction(signedXdr);
    return this.prisma.$transaction(async (tx) => {
      const checkedIn = await tx.ticket.update({
        where: { id: ticketId },
        data: {
          status: TicketStatus.USED,
          checkedInAt: new Date(),
          checkedInGateId: gateId ?? null,
          checkInReason: reason ?? null,
        },
      });
      await this.recordProcessedTx(tx, signedXdr, 'check-in', checkedIn);
      return checkedIn;
    });
  }

  /**
   * Check-in via a `ScannerDevice` token (see `ScannerDeviceGuard`) instead
   * of a staff JWT. The guard already confirmed the device is live and
   * scoped to this ticket's event, so no `organizations.assertMember` call
   * is needed here.
   */
  async confirmCheckInByDevice(
    ticketId: string,
    signedXdr: string,
    gateId?: string,
    reason?: string,
  ) {
    const ticket = await this.getTicketWithOrg(ticketId);
    const replay = await this.findProcessedTx<Ticket>(signedXdr);
    if (replay) return replay.value;
    this.assertSignedInvocation(signedXdr, 'check_in', [
      ['organizer', 0, ticket.event.organization.stellarAccount],
      ['ticket', 1, ticket.chainTicketId],
    ]);
    if (gateId) {
      await this.gates!.assertBelongsToEvent(gateId, ticket.eventId);
    }
    await this.stellar.submitSignedTransaction(signedXdr);
    return this.prisma.$transaction(async (tx) => {
      const checkedIn = await tx.ticket.update({
        where: { id: ticketId },
        data: {
          status: TicketStatus.USED,
          checkedInAt: new Date(),
          checkedInGateId: gateId ?? null,
          checkInReason: reason ?? null,
        },
      });
      await this.recordProcessedTx(tx, signedXdr, 'check-in', checkedIn);
      return checkedIn;
    });
  }

  // ---- Revocation (fraud prevention) ----

  async buildRevokeTx(userId: string, ticketId: string) {
    const ticket = await this.loadTicketForOrganizer(userId, { id: ticketId });

    const unsignedXdr = await this.stellar.buildRevokeTicketTx({
      organizerPublicKey: ticket.event.organization.stellarAccount,
      chainTicketId: ticket.chainTicketId,
    });
    return { unsignedXdr };
  }

  async confirmRevoke(userId: string, ticketId: string, signedXdr: string) {
    const ticket = await this.loadTicketForOrganizer(userId, { id: ticketId });
    const replay = await this.findProcessedTx<Ticket>(signedXdr);
    if (replay) return replay.value;
    this.assertSignedInvocation(signedXdr, 'revoke_ticket', [
      ['organizer', 0, ticket.event.organization.stellarAccount],
      ['ticket', 1, ticket.chainTicketId],
    ]);
    await this.stellar.submitSignedTransaction(signedXdr);
    const revoked = await this.prisma.$transaction(async (tx) => {
      const row = await tx.ticket.update({
        where: { id: ticketId },
        data: { status: TicketStatus.REVOKED },
      });
      // #500 — a revoked ticket must not keep a live resale listing.
      await this.cancelActiveListings(tx, [ticketId]);
      await this.recordProcessedTx(tx, signedXdr, 'revoke', row);
      return row;
    });
    // #209 — audit ticket revocation.
    await this.audit?.record(userId, 'ticket.revoke', 'Ticket', ticketId, {
      eventId: ticket.eventId,
    });
    return revoked;
  }

  /**
   * #499 — step 1 of batch revocation. Returns one unsigned `revoke_batch`
   * envelope per 35-ticket chunk, in the same order as the chunks the confirm
   * step validates.
   */
  async buildRevokeBatch(userId: string, eventId: string, ticketIds: string[]) {
    const { event, tickets } = await this.loadBatchForOrganizer(
      userId,
      eventId,
      ticketIds,
    );
    const chunks = this.revokeChunks(
      tickets.map((ticket) => ticket.chainTicketId),
    );
    const unsignedXdrs: string[] = [];
    for (const chunk of chunks) {
      unsignedXdrs.push(
        await this.stellar.buildRevokeBatchTx({
          organizerPublicKey: event.organization.stellarAccount,
          chainTicketIds: chunk,
        }),
      );
    }
    return {
      unsignedXdrs,
      chunkSize: REVOKE_BATCH_CHUNK_SIZE,
    };
  }

  /**
   * #499/#500 — step 2 of batch revocation. Validates every signed envelope
   * against its expected chunk, submits all of them before touching the DB,
   * then revokes tickets and cancels their ACTIVE resale listings atomically.
   */
  async confirmRevokeBatch(
    userId: string,
    eventId: string,
    ticketIds: string[],
    signedXdrs: string[],
  ) {
    const { event, tickets } = await this.loadBatchForOrganizer(
      userId,
      eventId,
      ticketIds,
    );
    const chunks = this.revokeChunks(
      tickets.map((ticket) => ticket.chainTicketId),
    );
    if (signedXdrs.length !== chunks.length) {
      throw new BadRequestException(
        `Expected ${chunks.length} signed revoke_batch transaction(s), got ${signedXdrs.length}`,
      );
    }

    const processed = await Promise.all(
      signedXdrs.map((xdr) => this.findProcessedTx<{ count: number }>(xdr)),
    );
    if (processed.every((entry) => entry !== null)) {
      return processed[0].value;
    }
    if (processed.some((entry) => entry !== null)) {
      throw new ConflictException(
        'Batch revocation has already been partially confirmed',
      );
    }

    // Validate the entire batch before any network call: a mismatched chunk
    // must never revoke tickets the organizer did not ask to revoke.
    signedXdrs.forEach((signedXdr, index) => {
      const invocation = this.assertSignedInvocation(
        signedXdr,
        'revoke_batch',
        [['organizer', 0, event.organization.stellarAccount]],
      );
      const signedIds = invocation.args[1];
      if (
        !Array.isArray(signedIds) ||
        signedIds.length !== chunks[index].length ||
        signedIds.some((id, i) => id !== chunks[index][i])
      ) {
        throw new BadRequestException(
          `Signed transaction revoke_batch chunk ${index + 1} does not match the request`,
        );
      }
    });

    for (const signedXdr of signedXdrs) {
      await this.stellar.submitSignedTransaction(signedXdr);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.ticket.updateMany({
        where: { id: { in: ticketIds }, eventId },
        data: { status: TicketStatus.REVOKED },
      });
      await this.cancelActiveListings(tx, ticketIds);
      for (const signedXdr of signedXdrs) {
        await this.recordProcessedTx(tx, signedXdr, 'revoke-batch', {
          count: updated.count,
        });
      }
      return updated;
    });

    // #209 — audit batch revocation (one entry per batch).
    await this.audit?.record(userId, 'ticket.revoke_batch', 'Event', eventId, {
      ticketIds,
      count: result.count,
    });
    return result;
  }

  /** Splits chain ticket ids into contract-sized `revoke_batch` chunks. */
  private revokeChunks(ticketIds: bigint[]): bigint[][] {
    const chunks: bigint[][] = [];
    for (let i = 0; i < ticketIds.length; i += REVOKE_BATCH_CHUNK_SIZE) {
      chunks.push(ticketIds.slice(i, i + REVOKE_BATCH_CHUNK_SIZE));
    }
    return chunks;
  }

  /** #500 — shared by single and batch revoke confirmations. */
  private cancelActiveListings(
    tx: Prisma.TransactionClient,
    ticketIds: string[],
  ) {
    return tx.resaleListing.updateMany({
      where: {
        ticketId: ticketIds.length === 1 ? ticketIds[0] : { in: ticketIds },
        status: ResaleListingStatus.ACTIVE,
      },
      data: { status: ResaleListingStatus.CANCELLED },
    });
  }

  /** Loads and validates the tickets for an organizer's batch revocation. */
  private async loadBatchForOrganizer(
    userId: string,
    eventId: string,
    ticketIds: string[],
  ) {
    const MAX_BATCH_SIZE = 100;
    if (ticketIds.length === 0 || ticketIds.length > MAX_BATCH_SIZE) {
      throw new BadRequestException(
        `Revoke between 1 and ${MAX_BATCH_SIZE} tickets at once`,
      );
    }

    const event = await this.getEventWithOrg(eventId);
    await this.organizations.assertMember(event.organizationId, userId);
    if (event.status !== EventStatus.PUBLISHED || event.chainEventId === null) {
      throw new BadRequestException(
        'Event has not been published on-chain yet',
      );
    }

    const tickets = await this.prisma.ticket.findMany({
      where: { id: { in: ticketIds }, eventId },
    });
    if (tickets.length !== ticketIds.length) {
      throw new BadRequestException(
        'Some tickets were not found or do not belong to this event',
      );
    }
    return { event, tickets };
  }

  private async assertWithinResaleLimit(userId: string) {
    const maxLimit =
      this.config?.get<number>('MAX_ACTIVE_RESALE_LISTINGS_PER_USER') ?? 5;
    const activeCount = await this.prisma.resaleListing.count({
      where: {
        sellerId: userId,
        status: ResaleListingStatus.ACTIVE,
      },
    });
    if (activeCount >= maxLimit) {
      throw new ConflictException(
        'Maximum active resale listings limit reached',
      );
    }
  }

  // ---- Resale marketplace ----

  /**
   * #319 — Mirrors the contract's resale price cap arithmetic.
   *
   * cap = floor(originalPrice * maxResaleMultiplierBps / 10_000)
   *
   * Using BigInt division keeps the rounding identical to Rust's integer
   * division (truncation toward zero), which is what the Soroban contract uses.
   */
  static computeResalePriceCap(
    originalPrice: bigint,
    maxResaleMultiplierBps: number,
  ): bigint {
    return (originalPrice * BigInt(maxResaleMultiplierBps)) / 10_000n;
  }

  private assertResalePriceCap(
    price: bigint,
    originalPrice: bigint,
    maxResaleMultiplierBps: number,
  ) {
    const cap = TicketsService.computeResalePriceCap(
      originalPrice,
      maxResaleMultiplierBps,
    );
    if (price > cap) {
      throw new BadRequestException(
        `Resale price exceeds the event's anti-scalping cap of ${cap.toString()}`,
      );
    }
  }

  async buildListForResaleTx(userId: string, ticketId: string, price: string) {
    await this.assertWithinResaleLimit(userId);
    const ticket = await this.getOwnedTicketWithPricingInfo(ticketId, userId);
    const owner = await this.getUserWithWallet(userId);

    // #319 — validate price cap before building the transaction
    this.assertResalePriceCap(
      BigInt(price),
      ticket.ticketType.price,
      ticket.event.maxResaleMultiplierBps,
    );

    const unsignedXdr = await this.stellar.buildListForResaleTx({
      ownerPublicKey: owner.stellarPublicKey!,
      chainTicketId: ticket.chainTicketId,
      price: BigInt(price),
    });
    return { unsignedXdr };
  }

  async confirmListForResale(
    userId: string,
    ticketId: string,
    price: string,
    signedXdr: string,
    expiresAt?: string,
  ) {
    const replay = await this.findProcessedTx<ResaleListing>(signedXdr);
    if (replay) return replay.value;
    await this.assertWithinResaleLimit(userId);
    // #216 — fail fast when the ticket is already listed before touching the
    // chain. The DB-level partial unique index remains the source of truth.
    await this.assertNoActiveResaleListing(ticketId);
    const ticket = await this.getOwnedTicketWithPricingInfo(ticketId, userId);

    // #319 — validate price cap at confirm step too (guards against replays)
    this.assertResalePriceCap(
      BigInt(price),
      ticket.ticketType.price,
      ticket.event.maxResaleMultiplierBps,
    );

    // #376 — the listing price is whatever the signed envelope sets, so the
    // body price must agree with it before anything is submitted.
    this.assertSignedInvocation(signedXdr, 'list_for_resale', [
      ['ticket', 1, ticket.chainTicketId],
      ['price', 2, BigInt(price)],
    ]);

    const { txHash } = await this.stellar.submitSignedTransaction(
      signedXdr,
      this.attendeeSubmitOptions(),
    );
    // #376 — store the price the chain actually recorded, not the body's.
    const { resalePrice } = await this.stellar.verifyTicket(
      ticket.chainTicketId,
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.ticket.update({
          where: { id: ticketId },
          data: { status: TicketStatus.RESALE },
        });
        const listing = await tx.resaleListing.create({
          data: {
            ticketId,
            sellerId: userId,
            price: resalePrice,
            txHash,
            expiresAt: expiresAt ? new Date(expiresAt) : null,
            priceHistory: {
              create: {
                price: resalePrice,
              },
            },
          },
        });
        await this.recordProcessedTx(tx, signedXdr, 'list-resale', listing);
        return listing;
      });
    } catch (err) {
      // #216 — a concurrent create raced us past the pre-check: the partial
      // unique index rejected it, surface it as a 409.
      this.throwOnResaleConflict(err);
      throw err;
    }
  }

  async updateResalePrice(userId: string, listingId: string, newPrice: string) {
    const listing = await this.prisma.resaleListing.findUnique({
      where: { id: listingId },
      include: {
        ticket: { include: { ticketType: true, event: true } },
      },
    });
    if (!listing) {
      throw new NotFoundException('Resale listing not found');
    }
    if (listing.sellerId !== userId) {
      throw new ForbiddenException('You do not own this resale listing');
    }
    if (listing.status !== ResaleListingStatus.ACTIVE) {
      throw new BadRequestException('Listing is not active');
    }

    // #319/#318 — validate new price against the event's anti-scalping cap
    this.assertResalePriceCap(
      BigInt(newPrice),
      listing.ticket.ticketType.price,
      listing.ticket.event.maxResaleMultiplierBps,
    );

    return this.prisma.$transaction(async (tx) => {
      await tx.resalePriceHistory.create({
        data: {
          resaleListingId: listingId,
          price: BigInt(newPrice),
        },
      });
      return tx.resaleListing.update({
        where: { id: listingId },
        data: { price: BigInt(newPrice) },
      });
    });
  }

  async getPriceHistory(listingId: string) {
    const listing = await this.prisma.resaleListing.findUnique({
      where: { id: listingId },
    });
    if (!listing) {
      throw new NotFoundException('Resale listing not found');
    }
    return this.prisma.resalePriceHistory.findMany({
      where: { resaleListingId: listingId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async cancelExpiredListings() {
    const now = new Date();
    const expiredListings = await this.prisma.resaleListing.findMany({
      where: {
        status: ResaleListingStatus.ACTIVE,
        expiresAt: { lte: now },
      },
    });

    if (expiredListings.length === 0) {
      return { cancelledCount: 0 };
    }

    const listingIds = expiredListings.map((l) => l.id);
    const ticketIds = expiredListings.map((l) => l.ticketId);

    await this.prisma.$transaction([
      this.prisma.resaleListing.updateMany({
        where: { id: { in: listingIds } },
        data: { status: ResaleListingStatus.CANCELLED },
      }),
      this.prisma.ticket.updateMany({
        where: { id: { in: ticketIds } },
        data: { status: TicketStatus.VALID },
      }),
    ]);

    return { cancelledCount: expiredListings.length };
  }

  async buildCancelResaleTx(userId: string, ticketId: string) {
    const ticket = await this.getOwnedTicket(ticketId, userId);
    const owner = await this.getUserWithWallet(userId);

    const unsignedXdr = await this.stellar.buildCancelResaleTx({
      ownerPublicKey: owner.stellarPublicKey!,
      chainTicketId: ticket.chainTicketId,
    });
    return { unsignedXdr };
  }

  async confirmCancelResale(
    userId: string,
    ticketId: string,
    signedXdr: string,
  ) {
    const ticket = await this.getOwnedTicket(ticketId, userId);
    if (await this.findProcessedTx<null>(signedXdr)) return;
    const owner = await this.getUserWithWallet(userId);
    this.assertSignedInvocation(signedXdr, 'cancel_resale', [
      ['owner', 0, owner.stellarPublicKey],
      ['ticket', 1, ticket.chainTicketId],
    ]);
    await this.stellar.submitSignedTransaction(
      signedXdr,
      this.attendeeSubmitOptions(),
    );

    return this.prisma.$transaction(async (tx) => {
      await tx.ticket.update({
        where: { id: ticketId },
        data: { status: TicketStatus.VALID },
      });
      await tx.resaleListing.updateMany({
        where: { ticketId, status: ResaleListingStatus.ACTIVE },
        data: { status: ResaleListingStatus.CANCELLED },
      });
      await this.recordProcessedTx(tx, signedXdr, 'cancel-resale', null);
    });
  }

  async buildBuyResaleTx(buyerId: string, ticketId: string) {
    const ticket = await this.getTicketWithOrg(ticketId);
    if (ticket.status !== TicketStatus.RESALE) {
      throw new ListingInactiveError();
    }
    const buyer = await this.getUserWithWallet(buyerId);

    const unsignedXdr = await this.stellar.buildBuyResaleTx({
      buyerPublicKey: buyer.stellarPublicKey!,
      chainTicketId: ticket.chainTicketId,
    });
    return { unsignedXdr };
  }

  async confirmBuyResale(buyerId: string, ticketId: string, signedXdr: string) {
    const ticket = await this.getTicketWithOrg(ticketId);
    const replay = await this.findProcessedTx<Ticket>(signedXdr);
    if (replay) return replay.value;
    const buyer = await this.getUserWithWallet(buyerId);
    this.assertSignedInvocation(signedXdr, 'buy_resale', [
      ['buyer', 0, buyer.stellarPublicKey],
      ['ticket', 1, ticket.chainTicketId],
    ]);
    await this.stellar.submitSignedTransaction(
      signedXdr,
      this.attendeeSubmitOptions(),
    );

    return this.prisma.$transaction(async (tx) => {
      await tx.resaleListing.updateMany({
        where: { ticketId, status: ResaleListingStatus.ACTIVE },
        data: { status: ResaleListingStatus.SOLD },
      });
      const bought = await tx.ticket.update({
        where: { id: ticketId },
        data: { ownerId: buyerId, status: TicketStatus.VALID },
      });
      await this.recordProcessedTx(tx, signedXdr, 'buy-resale', bought);
      return bought;
    });
  }

  async findActiveResaleListings(cursor?: string, limit = 20) {
    const take = Math.min(Math.max(limit, 1), 100);
    const cursorFilter = cursor ? this.resaleCursorWhere(cursor) : undefined;

    const rows = await this.prisma.resaleListing.findMany({
      where: {
        status: ResaleListingStatus.ACTIVE,
        ...(cursorFilter ?? {}),
      },
      // #374 — the marketplace is readable by any authenticated user, so the
      // query must project only the fields it renders. Never include the whole
      // Ticket: that would leak `qrSecret` (the gate code) and `ownerId`.
      select: {
        id: true,
        ticketId: true,
        price: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        ticket: {
          select: {
            id: true,
            seat: true,
            event: {
              select: {
                id: true,
                name: true,
                venue: true,
                startsAt: true,
                royaltyBps: true,
              },
            },
            ticketType: { select: { name: true, price: true } },
          },
        },
        seller: { select: { name: true } },
      },
      // createdAt + id keeps the order stable when timestamps collide.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last ? this.encodeResaleCursor(last.createdAt, last.id) : null;

    // #320 — Compute royalty fee and seller proceeds for each listing so
    // clients don't have to duplicate the contract math.
    // royaltyFee   = floor(price * royaltyBps / 10_000)
    // sellerProceeds = price - royaltyFee
    const enrichedItems = items.map((listing) => {
      const price = listing.price;
      const royaltyBps = listing.ticket.event.royaltyBps;
      const royaltyFee = (price * BigInt(royaltyBps)) / 10_000n;
      const sellerProceeds = price - royaltyFee;
      return {
        ...listing,
        royaltyFee,
        sellerProceeds,
      };
    });

    return { items: enrichedItems, nextCursor, limit: take };
  }

  findMine(userId: string, status?: TicketStatus) {
    // #213 — (ownerId, status) is covered by "Ticket_ownerId_status_idx".
    return this.prisma.ticket.findMany({
      where: { ownerId: userId, ...(status ? { status } : {}) },
      include: { event: true, ticketType: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * #121 — Fetches one ticket for its owner or for staff of the owning
   * event's organization; anyone else gets 403. The `qrSecret` is only
   * returned to the owner, since staff scan it rather than hold it.
   */
  async findOne(userId: string, ticketId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        event: { include: { organization: true } },
        ticketType: true,
      },
    });
    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }
    if (ticket.ownerId === userId) {
      return ticket;
    }

    await this.organizations.assertMember(ticket.event.organizationId, userId);
    return { ...ticket, qrSecret: undefined };
  }

  /** #125 — PNG of the ticket's QR code (its `qrSecret`). Owner only. */
  async getQrImage(userId: string, ticketId: string): Promise<Buffer> {
    const ticket = await this.getOwnedTicket(ticketId, userId);
    return toBuffer(ticket.qrSecret, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 512,
    });
  }

  /** #129 — Issues a short-lived signed token to render in place of the static `qrSecret`. Owner only. */
  async issueQrToken(userId: string, ticketId: string) {
    const ticket = await this.getOwnedTicket(ticketId, userId);
    return this.qrTokens!.issue(ticket.id);
  }

  /** Looks up a ticket by its on-chain id. Restricted to staff of the owning event's organization. */
  async findByChainTicketId(staffUserId: string, chainTicketId: bigint) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { chainTicketId },
      include: { event: { include: { organization: true } }, ticketType: true },
    });
    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }

    await this.organizations.assertMember(
      ticket.event.organizationId,
      staffUserId,
    );

    return ticket;
  }

  /**
   * Shared by `confirmIssue` and `confirmPurchase`: bumps the ticket type's
   * issued count and creates the ticket row, inside the caller's transaction.
   */
  private async recordIssuedTicket(
    tx: Prisma.TransactionClient,
    params: {
      eventId: string;
      ticketTypeId: string;
      ownerId: string;
      chainTicketId: bigint;
      seat?: string;
      issuedTxHash: string;
      signedXdr: string;
      operation: string;
    },
  ) {
    await tx.ticketType.update({
      where: { id: params.ticketTypeId },
      data: { quantityIssued: { increment: 1 } },
    });
    const ticket = await tx.ticket.create({
      data: {
        eventId: params.eventId,
        ticketTypeId: params.ticketTypeId,
        ownerId: params.ownerId,
        chainTicketId: params.chainTicketId,
        seat: params.seat ?? UNASSIGNED_SEAT,
        issuedTxHash: params.issuedTxHash,
      },
    });
    await this.recordProcessedTx(
      tx,
      params.signedXdr,
      params.operation,
      ticket,
    );
    return ticket;
  }

  /**
   * #161 — attendee actions are wrapped in a platform-paid fee bump when
   * `FEATURE_FEE_BUMP` is on, so attendees don't need XLM for gas.
   */
  private attendeeSubmitOptions(): { sponsorFee: boolean } {
    return { sponsorFee: this.featureFlags?.isEnabled('feeBump') ?? false };
  }

  /**
   * #159 — returns the response recorded for this envelope, if it was already
   * confirmed. Callers check it after the membership check and before any
   * validation: a replayed ticket or listing already exists, so the seat and
   * listing checks would otherwise 409 a request that already succeeded.
   */
  private async findProcessedTx<T>(
    signedXdr: string,
  ): Promise<{ value: T } | null> {
    const row = await this.prisma.processedTx.findUnique({
      where: { txHash: this.stellar.txHashOf(signedXdr) },
    });
    return row ? { value: row.response as T } : null;
  }

  /**
   * #159 — records the response inside the caller's transaction, so the
   * processed marker commits or rolls back together with the DB changes. A
   * concurrent duplicate hits the `txHash` primary key and fails the whole
   * transaction.
   */
  private recordProcessedTx(
    tx: Prisma.TransactionClient,
    signedXdr: string,
    operation: string,
    response: unknown,
  ) {
    return tx.processedTx.create({
      data: {
        txHash: this.stellar.txHashOf(signedXdr),
        operation,
        response: toStoredResponse(response),
      },
    });
  }

  // ---- shared helpers ----

  private async getTicketTypeWithEvent(ticketTypeId: string) {
    const ticketType = await this.prisma.ticketType.findUnique({
      where: { id: ticketTypeId },
      include: { event: { include: { organization: true } } },
    });
    if (!ticketType) {
      throw new NotFoundException('Ticket type not found');
    }
    return { ticketType, event: ticketType.event };
  }

  private async getEventWithOrg(eventId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: { organization: true },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }

  private async getTicketWithOrg(ticketId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { event: { include: { organization: true } } },
    });
    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }
    return ticket;
  }

  /**
   * Shared lookup for organizer-only ticket actions: loads the ticket with
   * its event, organization, owner and ticket type, then asserts the caller
   * is a member of the owning organization.
   */
  private async loadTicketForOrganizer(
    userId: string,
    where: Prisma.TicketWhereUniqueInput,
  ) {
    const ticket = await this.prisma.ticket.findUnique({
      where,
      include: {
        event: { include: { organization: true } },
        owner: true,
        ticketType: true,
      },
    });
    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }
    await this.organizations.assertMember(ticket.event.organizationId, userId);
    return ticket;
  }

  private async getOwnedTicket(ticketId: string, userId: string) {
    const ticket = await this.getTicketWithOrg(ticketId);
    if (ticket.ownerId !== userId) {
      throw new ForbiddenException('You do not own this ticket');
    }
    return ticket;
  }

  /**
   * Like `getOwnedTicket` but additionally includes `ticketType` and `event`
   * relations needed for resale price-cap validation (#319).
   */
  private async getOwnedTicketWithPricingInfo(
    ticketId: string,
    userId: string,
  ) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        event: { include: { organization: true } },
        ticketType: true,
      },
    });
    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }
    if (ticket.ownerId !== userId) {
      throw new ForbiddenException('You do not own this ticket');
    }
    return ticket;
  }

  private async getUserWithWallet(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (!user.stellarPublicKey) {
      throw new BadRequestException(
        'Connect a Stellar wallet to your account before continuing',
      );
    }
    return user;
  }

  private assertHasCapacity(issued: number, total: number) {
    if (issued >= total) {
      throw new TicketTypeSoldOutError();
    }
  }

  /**
   * #211 — application-level guard mirroring the partial unique index
   * `Ticket_eventId_seat_partial_key` (eventId, seat WHERE seat <> 'unassigned').
   * The DB remains the source of truth; this check only produces a nicer
   * 409 before the chain round-trip.
   *
   * #404 — `IsSeat` already rejects a real seat named "unassigned" (any
   * case), so this sentinel can never collide with a genuine seat; the
   * case-insensitive compare here just mirrors that at the service layer.
   */
  private async assertSeatAvailable(eventId: string, seat?: string) {
    const normalized = seat?.trim() ?? UNASSIGNED_SEAT;
    if (!normalized || normalized.toLowerCase() === UNASSIGNED_SEAT) return;
    const existing = await this.prisma.ticket.findFirst({
      where: { eventId, seat: normalized },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'That seat has already been issued for this event',
      );
    }
  }

  /** Translates a partial-index violation into a 409. */
  private throwOnSeatConflict(err: unknown): void {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const target = (err.meta as { target?: unknown } | undefined)?.target;
      const targets = Array.isArray(target)
        ? target.join(',')
        : typeof target === 'string'
          ? target
          : '';
      if (targets.includes('seat') || targets.includes('Ticket_eventId_seat')) {
        throw new ConflictException(
          'That seat has already been issued for this event',
        );
      }
    }
  }

  /**
   * #216 — application-level guard mirroring the partial unique index
   * `ResaleListing_ticketId_active_key` (ticketId WHERE status = 'ACTIVE').
   * The DB remains the source of truth; this check only produces a nicer
   * 409 before the chain round-trip.
   */
  private async assertNoActiveResaleListing(ticketId: string) {
    const existing = await this.prisma.resaleListing.findFirst({
      where: { ticketId, status: ResaleListingStatus.ACTIVE },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'This ticket already has an active resale listing',
      );
    }
  }

  /** Translates the active-listing partial-index violation into a 409. */
  private throwOnResaleConflict(err: unknown): void {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const target = (err.meta as { target?: unknown } | undefined)?.target;
      const targets = Array.isArray(target)
        ? target.join(',')
        : typeof target === 'string'
          ? target
          : '';
      if (targets.includes('ResaleListing_ticketId_active')) {
        throw new ConflictException(
          'This ticket already has an active resale listing',
        );
      }
    }
  }

  private assertSaleWindow(startsAt: Date | null, endsAt: Date | null) {
    const now = new Date();
    if (startsAt && now < startsAt)
      throw new BadRequestException('Ticket sales have not started');
    if (endsAt && now > endsAt)
      throw new BadRequestException('Ticket sales have ended');
  }

  private assertRecipientPublicKey(
    userPublicKey: string | null | undefined,
    providedPublicKey: string,
  ) {
    if (userPublicKey !== providedPublicKey) {
      throw new BadRequestException(
        'Recipient public key does not match target user',
      );
    }
  }

  /**
   * #375/#376/#377 — decodes the signed envelope and checks it calls `fn`
   * with the values this request is about to record. Each `expected` entry
   * is a label, the argument's position in the contract call, and the value
   * it must hold. A mismatch is a 400: the client signed something other
   * than what it asked us to record.
   */
  private assertSignedInvocation(
    signedXdr: string,
    fn: string,
    expected: Array<[label: string, index: number, value: unknown]>,
  ): SignedInvocation {
    let invocation: SignedInvocation;
    try {
      invocation = this.stellar.decodeSignedInvocation(signedXdr);
    } catch (err) {
      throw new BadRequestException(
        `Signed transaction could not be decoded: ${(err as Error).message}`,
      );
    }
    if (invocation.functionName !== fn) {
      throw new BadRequestException(
        `Signed transaction calls ${invocation.functionName}, expected ${fn}`,
      );
    }
    for (const [label, index, value] of expected) {
      if (invocation.args[index] !== value) {
        throw new BadRequestException(
          `Signed transaction ${label} does not match the request`,
        );
      }
    }
    return invocation;
  }

  private encodeResaleCursor(createdAt: Date, id: string): string {
    return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString(
      'base64url',
    );
  }

  private resaleCursorWhere(cursor: string) {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const [dateStr, id] = decoded.split('|');
      if (!dateStr || !id) {
        throw new BadRequestException('Invalid cursor');
      }
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        throw new BadRequestException('Invalid cursor');
      }
      return {
        OR: [{ createdAt: { lt: date } }, { createdAt: date, id: { lt: id } }],
      };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('Invalid cursor');
    }
  }
}
