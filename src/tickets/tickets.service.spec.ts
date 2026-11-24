import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

// TicketsService only needs StellarService's shape here (it's fully mocked
// below); avoid touching the real @stellar/stellar-sdk import chain, which
// ships ESM-only transitive deps (@noble/hashes, uint8array-extras) that
// Jest can't parse without a much heavier transform config.
jest.mock('../stellar/stellar.service', () => ({ StellarService: jest.fn() }));

import {
  ListingInactiveError,
  TicketTypeSoldOutError,
} from '../common/errors/domain.error';
import { UNASSIGNED_SEAT } from '../common/constants/seat.constant';
import { Prisma } from '@prisma/client';
import { TicketsService } from './tickets.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { OrganizationsService } from '../organizations/organizations.service';
import type { StellarService } from '../stellar/stellar.service';
import type { OfflineTokenService } from './offline-token.service';
import type { QrTokenService } from './qr-token.service';
import type { ConfigService } from '@nestjs/config';
import type { WaitlistService } from '../waitlist/waitlist.service';
import {
  createEvent,
  createOrganization,
  createTicket,
  createTicketType,
  createUser,
} from '../../test/factories';

function buildTicketType(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ...createTicketType({
      id: 'tt-1',
      name: 'GA',
      price: 1_000n,
      quantityIssued: 0,
      quantityTotal: 100,
    }),
    event: {
      ...createEvent({
        id: 'event-1',
        organizationId: 'org-1',
        chainEventId: 42n,
        status: 'PUBLISHED',
      }),
      organization: createOrganization({ stellarAccount: 'GORGANIZER' }),
    },
    ...overrides,
  };
}

describe('TicketsService', () => {
  let service: TicketsService;
  let prisma: {
    $queryRaw: jest.Mock;
    ticketType: { findUnique: jest.Mock; update: jest.Mock };
    ticket: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
    };
    event: { findUnique: jest.Mock };
    resaleListing: {
      create: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    resalePriceHistory: {
      create: jest.Mock;
      findMany: jest.Mock;
    };
    processedTx: { findUnique: jest.Mock; create: jest.Mock };
    user: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let organizations: { assertMember: jest.Mock };
  let stellar: Record<string, jest.Mock>;
  let offlineTokens: { sign: jest.Mock; getPublicKeys: jest.Mock };
  let qrTokens: { issue: jest.Mock; verify: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(() => {
    prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ quantityIssued: 0, quantityTotal: 100 }]),
      ticketType: { findUnique: jest.fn(), update: jest.fn() },
      ticket: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
      event: { findUnique: jest.fn() },
      resaleListing: {
        create: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      resalePriceHistory: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      processedTx: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      user: { findUnique: jest.fn() },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
        Array.isArray(cb) ? Promise.all(cb) : cb(prisma),
      ),
    };
    organizations = { assertMember: jest.fn().mockResolvedValue(undefined) };
    stellar = {
      buildIssueTicketTx: jest.fn().mockResolvedValue('unsigned-xdr'),
      buildPurchasePrimaryTx: jest.fn().mockResolvedValue('unsigned-xdr'),
      buildTransferTicketTx: jest.fn().mockResolvedValue('unsigned-xdr'),
      buildCheckInTx: jest.fn().mockResolvedValue('unsigned-xdr'),
      buildRevokeTicketTx: jest.fn().mockResolvedValue('unsigned-xdr'),
      buildRevokeBatchTx: jest.fn().mockResolvedValue('unsigned-xdr'),
      buildListForResaleTx: jest.fn().mockResolvedValue('unsigned-xdr'),
      buildCancelResaleTx: jest.fn().mockResolvedValue('unsigned-xdr'),
      buildBuyResaleTx: jest.fn().mockResolvedValue('unsigned-xdr'),
      submitSignedTransaction: jest
        .fn()
        .mockResolvedValue({ result: 7n, txHash: '0xabc' }),
      verifyTicket: jest.fn(),
      decodeSignedInvocation: jest.fn(),
      txHashOf: jest.fn().mockReturnValue('hash-1'),
    };
    offlineTokens = {
      sign: jest.fn().mockReturnValue({
        payload: {
          ticketId: 'ticket-1',
          chainTicketId: '7',
          eventId: 'event-1',
          status: 'VALID',
          exp: 9_999_999_999,
        },
        kid: 'test-key',
        signature: 'sig',
      }),
      getPublicKeys: jest.fn().mockReturnValue({ 'test-key': 'pem' }),
    };
    qrTokens = { issue: jest.fn(), verify: jest.fn() };
    config = { get: jest.fn().mockReturnValue(5) };

    service = new TicketsService(
      prisma as unknown as PrismaService,
      organizations as unknown as OrganizationsService,
      stellar as unknown as StellarService,
      undefined,
      offlineTokens as unknown as OfflineTokenService,
      config as unknown as ConfigService,
      undefined,
      undefined,
      undefined,
      undefined,
      qrTokens as unknown as QrTokenService,
    );
  });

  /** Makes the signed envelope decode to `functionName(...args)` (#375-#377). */
  function mockSignedCall(functionName: string, args: unknown[]) {
    stellar.decodeSignedInvocation.mockReturnValue({ functionName, args });
  }

  describe('buildIssueTx', () => {
    it('rejects once a ticket type is sold out', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(
        buildTicketType({ quantityIssued: 100, quantityTotal: 100 }),
      );

      await expect(
        service.buildIssueTx('organizer-1', 'tt-1', 'buyer-1', 'GBUYER'),
      ).rejects.toBeInstanceOf(TicketTypeSoldOutError);
      expect(stellar.buildIssueTicketTx).not.toHaveBeenCalled();
    });

    it('rejects issuing against an unpublished event in DRAFT status (400) (#383)', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(
        buildTicketType({
          event: {
            ...buildTicketType().event,
            status: 'DRAFT',
            chainEventId: null,
          },
        }),
      );

      await expect(
        service.buildIssueTx('organizer-1', 'tt-1', 'buyer-1', 'GBUYER'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects issuing against a CANCELLED event even if it has a chainEventId (400) (#383)', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(
        buildTicketType({
          event: {
            ...buildTicketType().event,
            status: 'CANCELLED',
            chainEventId: 42n,
          },
        }),
      );

      await expect(
        service.buildIssueTx('organizer-1', 'tt-1', 'buyer-1', 'GBUYER'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires the recipient to have a connected wallet', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(buildTicketType());
      prisma.user.findUnique.mockResolvedValue(
        createUser({ id: 'buyer-1', stellarPublicKey: null }),
      );

      await expect(
        service.buildIssueTx('organizer-1', 'tt-1', 'buyer-1', 'GBUYER'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('builds an issue_ticket transaction against the organizer account', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(buildTicketType());
      prisma.user.findUnique.mockResolvedValue(
        createUser({ id: 'buyer-1', stellarPublicKey: 'GBUYER' }),
      );

      const { unsignedXdr } = await service.buildIssueTx(
        'organizer-1',
        'tt-1',
        'buyer-1',
        'GBUYER',
        'A1',
      );

      expect(unsignedXdr).toBe('unsigned-xdr');
      expect(organizations.assertMember).toHaveBeenCalledWith(
        'org-1',
        'organizer-1',
      );
      expect(stellar.buildIssueTicketTx).toHaveBeenCalledWith({
        organizerPublicKey: 'GORGANIZER',
        chainEventId: 42n,
        toPublicKey: 'GBUYER',
        tier: 'GA',
        seat: 'A1',
        price: 1_000n,
      });
    });
  });

  describe('buildIssueBatch (#133)', () => {
    beforeEach(() => {
      prisma.ticketType.findUnique.mockResolvedValue(buildTicketType());
    });

    it('rejects a batch that exceeds the configured maximum size', async () => {
      config.get.mockReturnValue(2);
      const recipients = [
        { toUserId: 'u1', toPublicKey: 'GPUBKEY1' },
        { toUserId: 'u2', toPublicKey: 'GPUBKEY2' },
        { toUserId: 'u3', toPublicKey: 'GPUBKEY3' },
      ];

      await expect(
        service.buildIssueBatch('organizer-1', 'tt-1', recipients),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns one unsignedXdr per valid recipient', async () => {
      config.get.mockReturnValue(50);
      prisma.user.findUnique
        .mockResolvedValueOnce(
          createUser({ id: 'u1', stellarPublicKey: 'GPUBKEY1' }),
        )
        .mockResolvedValueOnce(
          createUser({ id: 'u2', stellarPublicKey: 'GPUBKEY2' }),
        );

      const result = await service.buildIssueBatch('organizer-1', 'tt-1', [
        { toUserId: 'u1', toPublicKey: 'GPUBKEY1', seat: 'A1' },
        { toUserId: 'u2', toPublicKey: 'GPUBKEY2' },
      ]);

      expect(result.total).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      expect(stellar.buildIssueTicketTx).toHaveBeenCalledTimes(2);
    });

    it('collects per-recipient errors without aborting the batch', async () => {
      config.get.mockReturnValue(50);
      // u1 not found, u2 succeeds
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          createUser({ id: 'u2', stellarPublicKey: 'GPUBKEY2' }),
        );

      const result = await service.buildIssueBatch('organizer-1', 'tt-1', [
        { toUserId: 'u1', toPublicKey: 'GPUBKEY1' },
        { toUserId: 'u2', toPublicKey: 'GPUBKEY2' },
      ]);

      expect(result.total).toBe(2);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(1);
      const errorResult = result.results.find((r) => r.toUserId === 'u1');
      expect(errorResult?.status).toBe('error');
    });

    it('rejects a recipient whose provided public key does not match their stored wallet', async () => {
      config.get.mockReturnValue(50);
      prisma.user.findUnique.mockResolvedValue(
        createUser({ id: 'u1', stellarPublicKey: 'GACTUALKEY' }),
      );

      const result = await service.buildIssueBatch('organizer-1', 'tt-1', [
        { toUserId: 'u1', toPublicKey: 'GDIFFERENTKEY' },
      ]);

      expect(result.failed).toBe(1);
      expect(result.results[0]?.status).toBe('error');
      expect(stellar.buildIssueTicketTx).not.toHaveBeenCalled();
    });

    it('rejects a batch for an unpublished event', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(
        buildTicketType({
          event: {
            ...buildTicketType().event,
            status: 'DRAFT',
            chainEventId: null,
          },
        }),
      );

      await expect(
        service.buildIssueBatch('organizer-1', 'tt-1', [
          { toUserId: 'u1', toPublicKey: 'GPUBKEY1' },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('buildPurchaseTx', () => {
    it('rejects purchase against a DRAFT event (400) (#383)', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(
        buildTicketType({
          event: {
            ...buildTicketType().event,
            status: 'DRAFT',
            chainEventId: null,
          },
        }),
      );
      prisma.user.findUnique.mockResolvedValue(
        createUser({ id: 'buyer-1', stellarPublicKey: 'GBUYER' }),
      );

      await expect(
        service.buildPurchaseTx('buyer-1', 'tt-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects purchase against a CANCELLED event even if it has a chainEventId (400) (#383)', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(
        buildTicketType({
          event: {
            ...buildTicketType().event,
            status: 'CANCELLED',
            chainEventId: 42n,
          },
        }),
      );
      prisma.user.findUnique.mockResolvedValue(
        createUser({ id: 'buyer-1', stellarPublicKey: 'GBUYER' }),
      );

      await expect(
        service.buildPurchaseTx('buyer-1', 'tt-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('builds purchase_primary transaction against a PUBLISHED event (#383)', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(
        buildTicketType({
          event: {
            ...buildTicketType().event,
            status: 'PUBLISHED',
            chainEventId: 42n,
          },
        }),
      );
      prisma.user.findUnique.mockResolvedValue(
        createUser({ id: 'buyer-1', stellarPublicKey: 'GBUYER' }),
      );

      const result = await service.buildPurchaseTx('buyer-1', 'tt-1');
      expect(result).toEqual({ unsignedXdr: 'unsigned-xdr' });
      expect(stellar.buildPurchasePrimaryTx).toHaveBeenCalledWith({
        buyerPublicKey: 'GBUYER',
        chainEventId: 42n,
        tier: 'GA',
        seat: UNASSIGNED_SEAT,
      });
    });
  });

  describe('confirmIssue', () => {
    const issueArgs = (seat = 'unassigned', to = 'GBUYER') => [
      'GORGANIZER',
      42n,
      to,
      'GA',
      seat,
      1_000n,
    ];

    beforeEach(() => mockSignedCall('issue_ticket', issueArgs('A1')));

    it('creates the ticket row and increments quantityIssued using the on-chain ticket id', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(buildTicketType());
      prisma.ticket.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'ticket-1', ...data }),
      );

      prisma.user.findUnique.mockResolvedValue(
        createUser({ id: 'buyer-1', stellarPublicKey: 'GBUYER' }),
      );

      const ticket = await service.confirmIssue(
        'organizer-1',
        'tt-1',
        'buyer-1',
        'GBUYER',
        'A1',
        'signed-xdr',
      );

      expect(stellar.submitSignedTransaction).toHaveBeenCalledWith(
        'signed-xdr',
      );
      expect(prisma.ticketType.update).toHaveBeenCalledWith({
        where: { id: 'tt-1' },
        data: { quantityIssued: { increment: 1 } },
      });
      expect(ticket).toMatchObject({
        chainTicketId: 7n,
        ownerId: 'buyer-1',
        seat: 'A1',
      });
    });

    it('locks the TicketType row and re-checks capacity under the lock (#217)', async () => {
      mockSignedCall('issue_ticket', issueArgs());
      prisma.ticketType.findUnique.mockResolvedValue(buildTicketType());
      prisma.user.findUnique.mockResolvedValue(
        createUser({ id: 'buyer-1', stellarPublicKey: 'GBUYER' }),
      );
      prisma.ticketType.update.mockResolvedValue({});
      prisma.ticket.create.mockResolvedValue(
        createTicket({ id: 'ticket-new', ownerId: 'buyer-1' }),
      );

      await service.confirmIssue(
        'organizer-1',
        'tt-1',
        'buyer-1',
        'GBUYER',
        undefined,
        'signed-xdr',
      );

      // The row lock precedes the increment inside the same transaction.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const [query] = prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray];
      expect(query.join('')).toContain('FOR UPDATE');
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.ticketType.update.mock.invocationCallOrder[0],
      );
    });

    it('uses the locked row as the capacity authority, not the stale read (#217)', async () => {
      mockSignedCall('issue_ticket', issueArgs());
      prisma.ticketType.findUnique.mockResolvedValue(buildTicketType());
      prisma.user.findUnique.mockResolvedValue(
        createUser({ id: 'buyer-1', stellarPublicKey: 'GBUYER' }),
      );
      // The stale pre-transaction read said capacity was available, but the
      // locked row shows a concurrent transaction already filled the tier.
      prisma.$queryRaw.mockResolvedValueOnce([
        { quantityIssued: 100, quantityTotal: 100 },
      ]);

      await expect(
        service.confirmIssue(
          'organizer-1',
          'tt-1',
          'buyer-1',
          'GBUYER',
          undefined,
          'signed-xdr',
        ),
      ).rejects.toBeInstanceOf(TicketTypeSoldOutError);

      expect(prisma.ticketType.update).not.toHaveBeenCalled();
      expect(prisma.ticket.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate assigned seat for the same event (#211)', async () => {
      prisma.ticketType.findUnique.mockResolvedValue(buildTicketType());
      prisma.ticket.findFirst.mockResolvedValueOnce({ id: 'existing-ticket' });
      prisma.user.findUnique.mockResolvedValue(
        createUser({ id: 'buyer-1', stellarPublicKey: 'GBUYER' }),
      );

      await expect(
        service.confirmIssue(
          'organizer-1',
          'tt-1',
          'buyer-1',
          'GBUYER',
          'A1',
          'signed-xdr',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
    });

    it.each([
      ['seat', issueArgs('VIP')],
      ['recipient', issueArgs('A1', 'GSOMEONEELSE')],
      ['tier', ['GORGANIZER', 42n, 'GBUYER', 'VIP', 'A1', 1_000n]],
      ['event', ['GORGANIZER', 99n, 'GBUYER', 'GA', 'A1', 1_000n]],
    ])(
      'rejects a signed issuance whose %s differs from the request (#377)',
      async (label, args) => {
        mockSignedCall('issue_ticket', args);
        prisma.ticketType.findUnique.mockResolvedValue(buildTicketType());
        prisma.user.findUnique.mockResolvedValue(
          createUser({ id: 'buyer-1', stellarPublicKey: 'GBUYER' }),
        );

        await expect(
          service.confirmIssue(
            'organizer-1',
            'tt-1',
            'buyer-1',
            'GBUYER',
            'A1',
            'signed-xdr',
          ),
        ).rejects.toThrow(
          new BadRequestException(
            `Signed transaction ${label} does not match the request`,
          ),
        );
        expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
        expect(prisma.ticket.create).not.toHaveBeenCalled();
      },
    );

    it('rejects a signed envelope that calls a different contract function (#377)', async () => {
      mockSignedCall('purchase_primary', ['GBUYER', 42n, 'GA', 'A1', 1_000n]);
      prisma.ticketType.findUnique.mockResolvedValue(buildTicketType());
      prisma.user.findUnique.mockResolvedValue(
        createUser({ id: 'buyer-1', stellarPublicKey: 'GBUYER' }),
      );

      await expect(
        service.confirmIssue(
          'organizer-1',
          'tt-1',
          'buyer-1',
          'GBUYER',
          'A1',
          'signed-xdr',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
    });

    it('rejects an envelope that cannot be decoded with a 400 (#377)', async () => {
      stellar.decodeSignedInvocation.mockImplementation(() => {
        throw new Error('Expected one operation, got 2');
      });
      prisma.ticketType.findUnique.mockResolvedValue(buildTicketType());
      prisma.user.findUnique.mockResolvedValue(
        createUser({ id: 'buyer-1', stellarPublicKey: 'GBUYER' }),
      );

      await expect(
        service.confirmIssue(
          'organizer-1',
          'tt-1',
          'buyer-1',
          'GBUYER',
          'A1',
          'signed-xdr',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
    });
  });

  describe('confirmPurchase', () => {
    beforeEach(() => {
      prisma.ticketType.findUnique.mockResolvedValue(buildTicketType());
      prisma.user.findUnique.mockResolvedValue(
        createUser({ id: 'buyer-1', stellarPublicKey: 'GBUYER' }),
      );
      prisma.ticket.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'ticket-1', ...data }),
      );
    });

    it('records the ticket the signed purchase mints', async () => {
      mockSignedCall('purchase_primary', ['GBUYER', 42n, 'GA', 'A1', 1_000n]);

      const ticket = await service.confirmPurchase(
        'buyer-1',
        'tt-1',
        'A1',
        'signed-xdr',
      );

      expect(stellar.submitSignedTransaction).toHaveBeenCalledWith(
        'signed-xdr',
        { sponsorFee: false },
      );
      expect(ticket).toMatchObject({
        chainTicketId: 7n,
        ownerId: 'buyer-1',
        seat: 'A1',
      });
    });

    it.each([
      ['seat', ['GBUYER', 42n, 'GA', 'VIP', 1_000n]],
      ['buyer', ['GSOMEONEELSE', 42n, 'GA', 'A1', 1_000n]],
      ['tier', ['GBUYER', 42n, 'VIP', 'A1', 1_000n]],
    ])(
      'rejects a signed purchase whose %s differs from the request (#377)',
      async (label, args) => {
        mockSignedCall('purchase_primary', args);

        await expect(
          service.confirmPurchase('buyer-1', 'tt-1', 'A1', 'signed-xdr'),
        ).rejects.toThrow(
          new BadRequestException(
            `Signed transaction ${label} does not match the request`,
          ),
        );
        expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
        expect(prisma.ticket.create).not.toHaveBeenCalled();
      },
    );

    it('treats a missing seat as the unassigned sentinel when comparing (#377)', async () => {
      mockSignedCall('purchase_primary', [
        'GBUYER',
        42n,
        'GA',
        'unassigned',
        1_000n,
      ]);

      await expect(
        service.confirmPurchase('buyer-1', 'tt-1', undefined, 'signed-xdr'),
      ).resolves.toMatchObject({ seat: 'unassigned' });
    });

    it('marks waitlist entry CONVERTED on purchase if waitlist service is provided', async () => {
      mockSignedCall('purchase_primary', ['GBUYER', 42n, 'GA', 'A1', 1_000n]);
      const waitlist = {
        markConverted: jest.fn().mockResolvedValue(undefined),
      };
      const serviceWithWaitlist = new TicketsService(
        prisma as unknown as PrismaService,
        organizations as unknown as OrganizationsService,
        stellar as unknown as StellarService,
        undefined,
        offlineTokens as unknown as OfflineTokenService,
        config as unknown as ConfigService,
        undefined,
        undefined,
        undefined,
        undefined,
        qrTokens as unknown as QrTokenService,
        waitlist as unknown as WaitlistService,
      );

      await serviceWithWaitlist.confirmPurchase(
        'buyer-1',
        'tt-1',
        'A1',
        'signed-xdr',
      );

      expect(waitlist.markConverted).toHaveBeenCalledWith('tt-1', 'buyer-1');
    });
  });

  describe('transfer', () => {
    it('refuses to build a transfer for a ticket the caller does not own', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        ...createTicket({
          id: 'ticket-1',
          ownerId: 'someone-else',
          chainTicketId: 7n,
        }),
        event: {
          organizationId: 'org-1',
          organization: createOrganization({ stellarAccount: 'GORG' }),
        },
      });

      await expect(
        service.buildTransferTx(
          'not-the-owner',
          'ticket-1',
          'friend-1',
          'GFRIEND',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('builds a transfer using both parties on-chain public keys', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        ...createTicket({
          id: 'ticket-1',
          ownerId: 'owner-1',
          chainTicketId: 7n,
        }),
        event: {
          organizationId: 'org-1',
          organization: createOrganization({ stellarAccount: 'GORG' }),
        },
      });
      prisma.user.findUnique
        .mockResolvedValueOnce(
          createUser({ id: 'owner-1', stellarPublicKey: 'GOWNER' }),
        )
        .mockResolvedValueOnce(
          createUser({ id: 'friend-1', stellarPublicKey: 'GFRIEND' }),
        );

      await service.buildTransferTx(
        'owner-1',
        'ticket-1',
        'friend-1',
        'GFRIEND',
      );

      expect(stellar.buildTransferTicketTx).toHaveBeenCalledWith({
        fromPublicKey: 'GOWNER',
        chainTicketId: 7n,
        toPublicKey: 'GFRIEND',
      });
    });

    describe('confirmTransfer', () => {
      beforeEach(() => {
        prisma.ticket.findUnique.mockResolvedValue({
          ...createTicket({
            id: 'ticket-1',
            ownerId: 'owner-1',
            chainTicketId: 7n,
          }),
          event: {
            organizationId: 'org-1',
            organization: createOrganization({ stellarAccount: 'GORG' }),
          },
        });
        prisma.user.findUnique.mockResolvedValue(
          createUser({ id: 'friend-1', stellarPublicKey: 'GFRIEND' }),
        );
        prisma.ticket.update.mockImplementation(({ data }) =>
          Promise.resolve({ id: 'ticket-1', ...data }),
        );
        stellar.verifyTicket.mockResolvedValue({ owner: 'GFRIEND' });
      });

      it('records the new owner once the chain confirms it', async () => {
        mockSignedCall('transfer_ticket', ['GOWNER', 7n, 'GFRIEND']);

        const ticket = await service.confirmTransfer(
          'owner-1',
          'ticket-1',
          'friend-1',
          'GFRIEND',
          'signed-xdr',
        );

        expect(stellar.verifyTicket).toHaveBeenCalledWith(7n);
        expect(ticket).toMatchObject({ ownerId: 'friend-1', status: 'VALID' });
      });

      it('returns 409 and leaves ownerId unchanged when the signed recipient differs from toUserId (#375)', async () => {
        mockSignedCall('transfer_ticket', ['GOWNER', 7n, 'GWALLETA']);

        await expect(
          service.confirmTransfer(
            'owner-1',
            'ticket-1',
            'friend-1',
            'GFRIEND',
            'signed-xdr',
          ),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
        expect(prisma.ticket.update).not.toHaveBeenCalled();
      });

      it('returns 409 and leaves ownerId unchanged when the on-chain owner is not toUserId (#375)', async () => {
        mockSignedCall('transfer_ticket', ['GOWNER', 7n, 'GFRIEND']);
        stellar.verifyTicket.mockResolvedValue({ owner: 'GWALLETA' });

        await expect(
          service.confirmTransfer(
            'owner-1',
            'ticket-1',
            'friend-1',
            'GFRIEND',
            'signed-xdr',
          ),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.ticket.update).not.toHaveBeenCalled();
      });

      it('rejects a signed transfer of a different ticket (#375)', async () => {
        mockSignedCall('transfer_ticket', ['GOWNER', 8n, 'GFRIEND']);

        await expect(
          service.confirmTransfer(
            'owner-1',
            'ticket-1',
            'friend-1',
            'GFRIEND',
            'signed-xdr',
          ),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
      });

      it('cancels the ACTIVE resale listing of a transferred ticket in the same transaction (#378)', async () => {
        mockSignedCall('transfer_ticket', ['GOWNER', 7n, 'GFRIEND']);

        await service.confirmTransfer(
          'owner-1',
          'ticket-1',
          'friend-1',
          'GFRIEND',
          'signed-xdr',
        );

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.resaleListing.updateMany).toHaveBeenCalledWith({
          where: { ticketId: 'ticket-1', status: 'ACTIVE' },
          data: { status: 'CANCELLED' },
        });
        expect(prisma.ticket.update).toHaveBeenCalledWith({
          where: { id: 'ticket-1' },
          data: { ownerId: 'friend-1', status: 'VALID' },
        });
      });
    });
  });

  describe('verify', () => {
    it('reconciles the cached status when it diverges from the chain', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        chainTicketId: 7n,
        status: 'VALID',
        seat: 'A1',
        event: { organizationId: 'org-1', name: 'Radiohead Live' },
        owner: { name: 'Ada Lovelace' },
        ticketType: { name: 'GA' },
      });
      stellar.verifyTicket.mockResolvedValue({
        owner: 'GBUYER',
        status: 'Used',
      });

      const result = await service.verify('staff-1', 'qr-secret-abc');

      expect(prisma.ticket.update).toHaveBeenCalledWith({
        where: { id: 'ticket-1' },
        data: { status: 'USED' },
      });
      expect(result.status).toBe('USED');
      expect(result.eventName).toBe('Radiohead Live');
    });

    it('throws when no ticket matches the scanned secret', async () => {
      prisma.ticket.findUnique.mockResolvedValue(null);

      await expect(
        service.verify('staff-1', 'unknown-secret'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('verify — rotating QR tokens (#129)', () => {
    const token = 'v1.ticket-1.1790592000.signature';

    it('looks the ticket up by the id inside a valid token', async () => {
      qrTokens.verify.mockReturnValue('ticket-1');
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        chainTicketId: 7n,
        status: 'VALID',
        seat: 'A1',
        event: { organizationId: 'org-1', name: 'Radiohead Live' },
        owner: { name: 'Ada Lovelace' },
        ticketType: { name: 'GA' },
      });
      stellar.verifyTicket.mockResolvedValue({
        owner: 'GBUYER',
        status: 'Valid',
      });

      const result = await service.verify('staff-1', token);

      expect(qrTokens.verify).toHaveBeenCalledWith(token);
      expect(prisma.ticket.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'ticket-1' } }),
      );
      expect(organizations.assertMember).toHaveBeenCalledWith(
        'org-1',
        'staff-1',
      );
      expect(result.ticketId).toBe('ticket-1');
    });

    it('rejects an expired token without touching the database', async () => {
      qrTokens.verify.mockImplementation(() => {
        throw new BadRequestException('QR code has expired');
      });

      await expect(service.verify('staff-1', token)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.ticket.findUnique).not.toHaveBeenCalled();
    });

    it('still resolves a static qrSecret by the secret, never as a token', async () => {
      prisma.ticket.findUnique.mockResolvedValue(null);

      await expect(
        service.verify('staff-1', 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(qrTokens.verify).not.toHaveBeenCalled();
      expect(prisma.ticket.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { qrSecret: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f' },
        }),
      );
    });
  });

  describe('getOfflineToken', () => {
    it('signs a payload built from the ticket for an authorized staff member', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        eventId: 'event-1',
        chainTicketId: 7n,
        status: 'VALID',
        chainTicketId: 7n,
        event: {
          organizationId: 'org-1',
          organization: { stellarAccount: 'GORG' },
        },
      });

      const token = await service.getOfflineToken('staff-1', 'ticket-1');

      expect(organizations.assertMember).toHaveBeenCalledWith(
        'org-1',
        'staff-1',
      );
      expect(offlineTokens.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: 'ticket-1',
          chainTicketId: '7',
          eventId: 'event-1',
          status: 'VALID',
        }),
      );
      expect(token.kid).toBe('test-key');
    });

    it('throws when the ticket does not exist', async () => {
      prisma.ticket.findUnique.mockResolvedValue(null);

      await expect(
        service.getOfflineToken('staff-1', 'missing-ticket'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(offlineTokens.sign).not.toHaveBeenCalled();
    });

    it('rejects a caller who is not a member of the owning organization', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        eventId: 'event-1',
        chainTicketId: 7n,
        status: 'VALID',
        chainTicketId: 7n,
        event: {
          organizationId: 'org-1',
          organization: { stellarAccount: 'GORG' },
        },
      });
      organizations.assertMember.mockRejectedValueOnce(
        new ForbiddenException('You are not a member of this organization'),
      );

      await expect(
        service.getOfflineToken('outsider-1', 'ticket-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(offlineTokens.sign).not.toHaveBeenCalled();
    });
  });

  describe('getOfflinePublicKeys', () => {
    it('returns the offline token service public keys', () => {
      expect(service.getOfflinePublicKeys()).toEqual({ 'test-key': 'pem' });
    });
  });

  describe('resale marketplace', () => {
    it('rejects buying a ticket that is not listed for resale', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        status: 'VALID',
        chainTicketId: 7n,
        event: {
          organizationId: 'org-1',
          organization: { stellarAccount: 'GORG' },
        },
      });

      await expect(
        service.buildBuyResaleTx('buyer-1', 'ticket-1'),
      ).rejects.toBeInstanceOf(ListingInactiveError);
    });

    it('creates an active resale listing on confirm', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        ownerId: 'owner-1',
        chainTicketId: 7n,
        event: {
          organizationId: 'org-1',
          organization: { stellarAccount: 'GORG' },
          maxResaleMultiplierBps: 20_000,
        },
        ticketType: { price: 1_000n },
      });
      prisma.resaleListing.create.mockResolvedValue({
        id: 'listing-1',
        status: 'ACTIVE',
      });
      mockSignedCall('list_for_resale', ['GOWNER', 7n, 1200n]);
      stellar.verifyTicket.mockResolvedValue({ resalePrice: 1200n });

      await service.confirmListForResale(
        'owner-1',
        'ticket-1',
        '1200',
        'signed-xdr',
      );

      expect(prisma.ticket.update).toHaveBeenCalledWith({
        where: { id: 'ticket-1' },
        data: { status: 'RESALE' },
      });
      expect(prisma.resaleListing.create).toHaveBeenCalledWith({
        data: {
          ticketId: 'ticket-1',
          sellerId: 'owner-1',
          price: 1200n,
          txHash: '0xabc',
          expiresAt: null,
          priceHistory: {
            create: {
              price: 1200n,
            },
          },
        },
      });
    });

    it('rejects listing a ticket that already has an ACTIVE listing (#216)', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        ownerId: 'owner-1',
        chainTicketId: 7n,
        event: {
          organizationId: 'org-1',
          organization: { stellarAccount: 'GORG' },
          maxResaleMultiplierBps: 20_000,
        },
        ticketType: { price: 1_000n },
      });
      prisma.resaleListing.findFirst.mockResolvedValueOnce({
        id: 'existing-listing',
      });

      await expect(
        service.confirmListForResale(
          'owner-1',
          'ticket-1',
          '1200',
          'signed-xdr',
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      // Fail fast: the chain is never touched and no listing row is written.
      expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
      expect(prisma.resaleListing.create).not.toHaveBeenCalled();
    });

    it('maps the DB unique-index violation to 409 when a concurrent create wins (#216)', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        ownerId: 'owner-1',
        chainTicketId: 7n,
        event: {
          organizationId: 'org-1',
          organization: { stellarAccount: 'GORG' },
          maxResaleMultiplierBps: 20_000,
        },
        ticketType: { price: 1_000n },
      });
      mockSignedCall('list_for_resale', ['GOWNER', 7n, 1200n]);
      stellar.verifyTicket.mockResolvedValue({ resalePrice: 1200n });
      // Both transactions race past the pre-check; the DB partial unique
      // index rejects the loser with a P2002 on the active-listing index.
      prisma.$transaction.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['ticketId', 'ResaleListing_ticketId_active_key'] },
        }),
      );

      await expect(
        service.confirmListForResale(
          'owner-1',
          'ticket-1',
          '1200',
          'signed-xdr',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a body price that differs from the signed listing price (#376)', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        ownerId: 'owner-1',
        chainTicketId: 7n,
        event: {
          organizationId: 'org-1',
          organization: { stellarAccount: 'GORG' },
          maxResaleMultiplierBps: 20_000,
        },
        ticketType: { price: 1_000n },
      });
      // Signed to list at 1 500, but the body claims 1 200.
      mockSignedCall('list_for_resale', ['GOWNER', 7n, 1500n]);

      await expect(
        service.confirmListForResale(
          'owner-1',
          'ticket-1',
          '1200',
          'signed-xdr',
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'Signed transaction price does not match the request',
        ),
      );
      expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
      expect(prisma.resaleListing.create).not.toHaveBeenCalled();
    });

    it('stores the on-chain resale price, not the body price (#376)', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        ownerId: 'owner-1',
        chainTicketId: 7n,
        event: {
          organizationId: 'org-1',
          organization: { stellarAccount: 'GORG' },
          maxResaleMultiplierBps: 20_000,
        },
        ticketType: { price: 1_000n },
      });
      mockSignedCall('list_for_resale', ['GOWNER', 7n, 1200n]);
      stellar.verifyTicket.mockResolvedValue({ resalePrice: 1150n });

      await service.confirmListForResale(
        'owner-1',
        'ticket-1',
        '1200',
        'signed-xdr',
      );

      expect(stellar.verifyTicket).toHaveBeenCalledWith(7n);
      const expectedData: unknown = expect.objectContaining({
        price: 1150n,
        priceHistory: { create: { price: 1150n } },
      });
      expect(prisma.resaleListing.create).toHaveBeenCalledWith({
        data: expectedData,
      });
    });

    it('enforces soft limit on active resale listings per user (409 Conflict)', async () => {
      prisma.resaleListing.count.mockResolvedValue(5);

      await expect(
        service.buildListForResaleTx('seller-1', 'ticket-1', '1000'),
      ).rejects.toBeInstanceOf(ConflictException);

      await expect(
        service.confirmListForResale(
          'seller-1',
          'ticket-1',
          '1000',
          'signed-xdr',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('supports optional expiresAt when creating resale listing', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        ownerId: 'owner-1',
        chainTicketId: 7n,
        event: {
          organizationId: 'org-1',
          organization: { stellarAccount: 'GORG' },
          maxResaleMultiplierBps: 20_000,
        },
        ticketType: { price: 1_000n },
      });
      prisma.resaleListing.create.mockResolvedValue({
        id: 'listing-1',
        status: 'ACTIVE',
      });
      mockSignedCall('list_for_resale', ['GOWNER', 7n, 1200n]);
      stellar.verifyTicket.mockResolvedValue({ resalePrice: 1200n });

      const expiryStr = '2026-12-31T23:59:59.000Z';
      await service.confirmListForResale(
        'owner-1',
        'ticket-1',
        '1200',
        'signed-xdr',
        expiryStr,
      );

      const expectedData: unknown = expect.objectContaining({
        expiresAt: new Date(expiryStr),
      });
      expect(prisma.resaleListing.create).toHaveBeenCalledWith({
        data: expectedData,
      });
    });

    it('updates resale listing price and logs price audit history', async () => {
      prisma.resaleListing.findUnique.mockResolvedValue({
        id: 'listing-1',
        sellerId: 'owner-1',
        status: 'ACTIVE',
        price: 1000n,
        ticket: {
          ticketType: { price: 1_000n },
          event: { maxResaleMultiplierBps: 20_000 },
        },
      });

      await service.updateResalePrice('owner-1', 'listing-1', '1500');

      expect(prisma.resalePriceHistory.create).toHaveBeenCalledWith({
        data: {
          resaleListingId: 'listing-1',
          price: 1500n,
        },
      });
      expect(prisma.resaleListing.update).toHaveBeenCalledWith({
        where: { id: 'listing-1' },
        data: { price: 1500n },
      });
    });

    it('fetches price history audit trail for a listing', async () => {
      prisma.resaleListing.findUnique.mockResolvedValue({ id: 'listing-1' });
      prisma.resalePriceHistory.findMany.mockResolvedValue([
        { id: 'h-1', price: 1000n },
        { id: 'h-2', price: 1500n },
      ]);

      const history = await service.getPriceHistory('listing-1');
      expect(history).toHaveLength(2);
      expect(prisma.resalePriceHistory.findMany).toHaveBeenCalledWith({
        where: { resaleListingId: 'listing-1' },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('cancels expired listings and restores ticket status to VALID', async () => {
      prisma.resaleListing.findMany.mockResolvedValue([
        { id: 'listing-exp-1', ticketId: 'ticket-exp-1' },
        { id: 'listing-exp-2', ticketId: 'ticket-exp-2' },
      ]);

      const res = await service.cancelExpiredListings();

      expect(res.cancelledCount).toBe(2);
      expect(prisma.resaleListing.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['listing-exp-1', 'listing-exp-2'] } },
        data: { status: 'CANCELLED' },
      });
      expect(prisma.ticket.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['ticket-exp-1', 'ticket-exp-2'] } },
        data: { status: 'VALID' },
      });
    });
  });

  describe('findActiveResaleListings', () => {
    it('returns a cursor page with stable createdAt+id ordering', async () => {
      const newer = {
        id: 'listing-2',
        price: 1_000n,
        createdAt: new Date('2026-09-02T00:00:00.000Z'),
        ticket: { event: { royaltyBps: 500 }, ticketType: {} },
      };
      const older = {
        id: 'listing-1',
        price: 1_000n,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        ticket: { event: { royaltyBps: 500 }, ticketType: {} },
      };
      prisma.resaleListing.findMany.mockResolvedValue([newer, older]);

      const page = await service.findActiveResaleListings(undefined, 10);

      expect(prisma.resaleListing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 11,
        }),
      );
      // items contain enriched rows; check id equality
      expect(page.items.map((i) => i.id)).toEqual([newer.id, older.id]);
      expect(page.nextCursor).toBeNull();
      expect(page.limit).toBe(10);
    });

    it('exposes nextCursor when more rows remain', async () => {
      const rows = [
        {
          id: 'c',
          price: 1_000n,
          createdAt: new Date('2026-09-03T00:00:00.000Z'),
          ticket: { event: { royaltyBps: 500 }, ticketType: {} },
        },
        {
          id: 'b',
          price: 1_000n,
          createdAt: new Date('2026-09-02T00:00:00.000Z'),
          ticket: { event: { royaltyBps: 500 }, ticketType: {} },
        },
        {
          id: 'a',
          price: 1_000n,
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          ticket: { event: { royaltyBps: 500 }, ticketType: {} },
        },
      ];
      prisma.resaleListing.findMany.mockResolvedValue(rows);

      const page = await service.findActiveResaleListings(undefined, 2);

      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toEqual(
        Buffer.from(
          `${rows[1].createdAt.toISOString()}|${rows[1].id}`,
          'utf8',
        ).toString('base64url'),
      );
    });

    it('rejects a malformed cursor', async () => {
      await expect(
        service.findActiveResaleListings('%%%', 10),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('projects only marketplace fields, never qrSecret or ownerId (#374)', async () => {
      prisma.resaleListing.findMany.mockResolvedValue([]);

      await service.findActiveResaleListings(undefined, 10);

      const [args] = prisma.resaleListing.findMany.mock.calls[0] as [
        { select: Record<string, unknown>; include?: unknown },
      ];
      expect(args.include).toBeUndefined();
      expect(args.select).toMatchObject({
        id: true,
        ticketId: true,
        price: true,
        seller: { select: { name: true } },
      });

      const ticketSelect = (
        args.select.ticket as { select: Record<string, unknown> }
      ).select;
      expect(ticketSelect).not.toHaveProperty('qrSecret');
      expect(ticketSelect).not.toHaveProperty('ownerId');
      expect(ticketSelect).toHaveProperty('seat');

      const eventSelect = (
        ticketSelect.event as { select: Record<string, unknown> }
      ).select;
      expect(eventSelect).toMatchObject({
        name: true,
        venue: true,
        startsAt: true,
        royaltyBps: true,
      });
      expect(
        (ticketSelect.ticketType as { select: Record<string, unknown> }).select,
      ).toMatchObject({ name: true, price: true });
    });

    it('maps the projected rows into the marketplace feed with royalty math', async () => {
      prisma.resaleListing.findMany.mockResolvedValue([
        {
          id: 'listing-1',
          ticketId: 'ticket-1',
          price: 1_200n,
          status: 'ACTIVE',
          expiresAt: null,
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          ticket: {
            id: 'ticket-1',
            seat: 'A1',
            event: {
              id: 'event-1',
              name: 'Radiohead Live',
              venue: 'O2 Arena',
              startsAt: new Date('2026-12-01T20:00:00.000Z'),
              royaltyBps: 500,
            },
            ticketType: { name: 'GA', price: 1_000n },
          },
          seller: { name: 'Alice' },
        },
      ]);

      const page = await service.findActiveResaleListings(undefined, 10);
      const [item] = page.items;

      expect(item.ticket.event.name).toBe('Radiohead Live');
      expect(item.ticket.ticketType.name).toBe('GA');
      expect(item.seller.name).toBe('Alice');
      expect(item.royaltyFee).toBe(60n);
      expect(item.sellerProceeds).toBe(1_140n);
      expect(item).not.toHaveProperty('qrSecret');
      expect(item.ticket).not.toHaveProperty('ownerId');
    });
  });

  describe('findMine', () => {
    it('scopes the query to the caller’s own tickets', async () => {
      prisma.ticket.findMany.mockResolvedValue([
        { id: 'ticket-1', ownerId: 'owner-1' },
      ]);

      await service.findMine('owner-1');

      expect(prisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ownerId: 'owner-1' } }),
      );
    });

    it('filters by status when provided, using the (ownerId, status) index (#213)', async () => {
      prisma.ticket.findMany.mockResolvedValue([]);

      await service.findMine('owner-1', 'VALID');

      expect(prisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ownerId: 'owner-1', status: 'VALID' },
        }),
      );
    });
  });

  describe('findByChainTicketId (#268)', () => {
    const ticket = {
      id: 'ticket-1',
      chainTicketId: 7n,
      event: { id: 'event-1', organizationId: 'org-1', organization: {} },
      ticketType: { id: 'tt-1' },
    };

    it('returns the ticket when the caller is staff of the owning organization', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticket);

      const result = await service.findByChainTicketId('staff-1', 7n);

      expect(prisma.ticket.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { chainTicketId: 7n } }),
      );
      expect(organizations.assertMember).toHaveBeenCalledWith(
        'org-1',
        'staff-1',
      );
      expect(result).toBe(ticket);
    });

    it('throws NotFoundException for an unknown chainTicketId', async () => {
      prisma.ticket.findUnique.mockResolvedValue(null);

      await expect(
        service.findByChainTicketId('staff-1', 999n),
      ).rejects.toThrow(NotFoundException);
      expect(organizations.assertMember).not.toHaveBeenCalled();
    });

    it('propagates ForbiddenException when the caller is not org staff', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticket);
      organizations.assertMember.mockRejectedValueOnce(
        new ForbiddenException('You are not a member of this organization'),
      );

      await expect(
        service.findByChainTicketId('outsider-1', 7n),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('findOne (#121)', () => {
    const ticket = {
      id: 'ticket-1',
      ownerId: 'owner-1',
      qrSecret: 'qr-secret-1',
      event: { id: 'event-1', organizationId: 'org-1', organization: {} },
      ticketType: { id: 'tt-1' },
    };

    it('returns the ticket, including its qrSecret, to its owner', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticket);

      const result = await service.findOne('owner-1', 'ticket-1');

      expect(prisma.ticket.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'ticket-1' } }),
      );
      expect(organizations.assertMember).not.toHaveBeenCalled();
      expect(result).toBe(ticket);
    });

    it('returns the ticket without its qrSecret to staff of the owning organization', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticket);

      const result = await service.findOne('staff-1', 'ticket-1');

      expect(organizations.assertMember).toHaveBeenCalledWith(
        'org-1',
        'staff-1',
      );
      expect(result.id).toBe('ticket-1');
      expect(result.qrSecret).toBeUndefined();
    });

    it('rejects a caller who is neither the owner nor organization staff (403)', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticket);
      organizations.assertMember.mockRejectedValueOnce(
        new ForbiddenException('You are not a member of this organization'),
      );

      await expect(service.findOne('outsider-1', 'ticket-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws NotFoundException for an unknown ticket', async () => {
      prisma.ticket.findUnique.mockResolvedValue(null);

      await expect(service.findOne('owner-1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
      expect(organizations.assertMember).not.toHaveBeenCalled();
    });
  });

  describe('getQrImage (#125)', () => {
    const PNG_SIGNATURE = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const ticket = {
      id: 'ticket-1',
      ownerId: 'owner-1',
      qrSecret: 'qr-secret-1',
      event: { organizationId: 'org-1', organization: {} },
    };

    it('renders a PNG of the ticket secret for its owner', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticket);

      const png = await service.getQrImage('owner-1', 'ticket-1');

      expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    });

    it('rejects anyone but the owner, including organization staff (403)', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticket);

      await expect(service.getQrImage('staff-1', 'ticket-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(organizations.assertMember).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for an unknown ticket', async () => {
      prisma.ticket.findUnique.mockResolvedValue(null);

      await expect(service.getQrImage('owner-1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('issueQrToken (#129)', () => {
    const ticket = {
      id: 'ticket-1',
      ownerId: 'owner-1',
      event: { organizationId: 'org-1', organization: {} },
    };

    it("issues a token for the owner's ticket", async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticket);
      qrTokens.issue.mockReturnValue({
        token: 'v1.ticket-1.1790592030.sig',
        expiresAt: '2026-10-17T12:00:30.000Z',
        ttlSeconds: 30,
      });

      const result = await service.issueQrToken('owner-1', 'ticket-1');

      expect(qrTokens.issue).toHaveBeenCalledWith('ticket-1');
      expect(result.ttlSeconds).toBe(30);
    });

    it('rejects anyone but the owner without issuing a token (403)', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticket);

      await expect(
        service.issueQrToken('outsider-1', 'ticket-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(qrTokens.issue).not.toHaveBeenCalled();
    });
  });

  // ---- #321 Graceful degradation ----

  describe('verify — graceful RPC degradation (#321)', () => {
    const baseTicket = {
      id: 'ticket-1',
      chainTicketId: 7n,
      status: 'VALID',
      seat: 'A1',
      event: { organizationId: 'org-1', name: 'Radiohead Live' },
      owner: { name: 'Ada Lovelace' },
      ticketType: { name: 'GA' },
    };

    it('returns stale:false and on-chain data when RPC is available', async () => {
      prisma.ticket.findUnique.mockResolvedValue(baseTicket);
      stellar.verifyTicket.mockResolvedValue({
        owner: 'GBUYER',
        status: 'Valid',
      });

      const result = await service.verify('staff-1', 'qr-secret');

      expect(result.stale).toBe(false);
      expect(result.status).toBe('VALID');
      expect(result.onChainOwner).toBe('GBUYER');
    });

    it('returns stale:true with cached DB data when RPC throws', async () => {
      prisma.ticket.findUnique.mockResolvedValue(baseTicket);
      stellar.verifyTicket.mockRejectedValue(new Error('RPC unavailable'));

      const result = await service.verify('staff-1', 'qr-secret');

      expect(result.stale).toBe(true);
      expect(result.status).toBe('VALID');
      expect(result.onChainOwner).toBeNull();
      // #380 — nothing to compare against while the chain is unreachable.
      expect(result.ownerMismatch).toBe(false);
      // should NOT attempt a DB update when RPC is down
      expect(prisma.ticket.update).not.toHaveBeenCalled();
    });
  });

  describe('verify — owner mismatch (#380)', () => {
    const ticketRow = {
      id: 'ticket-1',
      ownerId: 'owner-1',
      chainTicketId: 7n,
      status: 'VALID',
      seat: 'A1',
      event: { organizationId: 'org-1', name: 'Radiohead Live' },
      owner: { id: 'owner-1', name: 'Ada Lovelace', stellarPublicKey: 'GADA' },
      ticketType: { name: 'GA' },
    };

    it('reports no mismatch and writes nothing when the chain agrees', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticketRow);
      stellar.verifyTicket.mockResolvedValue({
        owner: 'GADA',
        status: 'Valid',
      });

      const result = await service.verify('staff-1', 'qr-secret');

      expect(result.ownerMismatch).toBe(false);
      expect(result.ownerName).toBe('Ada Lovelace');
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.ticket.update).not.toHaveBeenCalled();
    });

    it('flags a mismatch and reconciles the owner to the on-chain wallet’s account', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticketRow);
      stellar.verifyTicket.mockResolvedValue({
        owner: 'GGRACE',
        status: 'Valid',
      });
      prisma.user.findUnique.mockResolvedValue({
        id: 'owner-2',
        name: 'Grace Hopper',
      });

      const result = await service.verify('staff-1', 'qr-secret');

      expect(result.ownerMismatch).toBe(true);
      expect(result.onChainOwner).toBe('GGRACE');
      expect(result.ownerName).toBe('Grace Hopper');
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { stellarPublicKey: 'GGRACE' },
        select: { id: true, name: true },
      });
      expect(prisma.ticket.update).toHaveBeenCalledWith({
        where: { id: 'ticket-1' },
        data: { ownerId: 'owner-2' },
      });
    });

    it('flags a mismatch but keeps the owner when no account holds the on-chain wallet', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticketRow);
      stellar.verifyTicket.mockResolvedValue({
        owner: 'GUNKNOWN',
        status: 'Valid',
      });
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.verify('staff-1', 'qr-secret');

      expect(result.ownerMismatch).toBe(true);
      expect(result.ownerName).toBe('Ada Lovelace');
      expect(prisma.ticket.update).not.toHaveBeenCalled();
    });
  });

  // ---- #320 Royalty and seller proceeds ----

  describe('findActiveResaleListings — royalty and proceeds (#320)', () => {
    it('computes royaltyFee and sellerProceeds matching contract math', async () => {
      const listing = {
        id: 'listing-1',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        price: 10_000n,
        ticket: {
          event: { royaltyBps: 500 },
          ticketType: { price: 1_000n },
        },
        seller: { name: 'Alice' },
      };
      prisma.resaleListing.findMany.mockResolvedValue([listing]);

      const page = await service.findActiveResaleListings(undefined, 10);

      // royaltyFee = floor(10_000 * 500 / 10_000) = 500
      expect(page.items[0].royaltyFee).toBe(500n);
      // sellerProceeds = 10_000 - 500 = 9_500
      expect(page.items[0].sellerProceeds).toBe(9_500n);
    });

    it('handles zero royaltyBps (no fee deducted)', async () => {
      const listing = {
        id: 'listing-2',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        price: 5_000n,
        ticket: {
          event: { royaltyBps: 0 },
          ticketType: { price: 1_000n },
        },
        seller: { name: 'Bob' },
      };
      prisma.resaleListing.findMany.mockResolvedValue([listing]);

      const page = await service.findActiveResaleListings(undefined, 10);

      expect(page.items[0].royaltyFee).toBe(0n);
      expect(page.items[0].sellerProceeds).toBe(5_000n);
    });
  });

  // ---- #319 Resale price cap validation ----

  describe('computeResalePriceCap (#319)', () => {
    it('mirrors contract floor(originalPrice * multiplierBps / 10_000)', () => {
      // 1_000 * 11_000 / 10_000 = 1_100
      expect(TicketsService.computeResalePriceCap(1_000n, 11_000)).toBe(1_100n);
    });

    it('truncates fractional results like Rust integer division', () => {
      // 999 * 11_000 / 10_000 = 1098.9 → 1098
      expect(TicketsService.computeResalePriceCap(999n, 11_000)).toBe(1098n);
    });

    it('returns 0 when multiplier is 0', () => {
      expect(TicketsService.computeResalePriceCap(1_000n, 0)).toBe(0n);
    });
  });

  describe('buildListForResaleTx — price cap validation (#319)', () => {
    const ticketRow = {
      id: 'ticket-1',
      ownerId: 'owner-1',
      chainTicketId: 7n,
      event: {
        organizationId: 'org-1',
        organization: { stellarAccount: 'GORG' },
        maxResaleMultiplierBps: 11_000,
      },
      ticketType: { price: 1_000n },
    };

    it('rejects a price above the cap', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticketRow);
      prisma.user.findUnique.mockResolvedValue({
        id: 'owner-1',
        stellarPublicKey: 'GOWNER',
      });

      // cap = 1_100; 1_101 > cap
      await expect(
        service.buildListForResaleTx('owner-1', 'ticket-1', '1101'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stellar.buildListForResaleTx).not.toHaveBeenCalled();
    });

    it('accepts a price exactly at the cap', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticketRow);
      prisma.user.findUnique.mockResolvedValue({
        id: 'owner-1',
        stellarPublicKey: 'GOWNER',
      });

      const result = await service.buildListForResaleTx(
        'owner-1',
        'ticket-1',
        '1100',
      );
      expect(result.unsignedXdr).toBe('unsigned-xdr');
    });
  });

  // ---- #318 update-price with price cap ----

  describe('updateResalePrice — price cap validation (#318)', () => {
    const listingWithPricingInfo = {
      id: 'listing-1',
      sellerId: 'owner-1',
      status: 'ACTIVE',
      price: 1_000n,
      ticket: {
        ticketType: { price: 1_000n },
        event: { maxResaleMultiplierBps: 11_000 },
      },
    };

    it('rejects a new price above the cap', async () => {
      prisma.resaleListing.findUnique.mockResolvedValue(listingWithPricingInfo);

      await expect(
        service.updateResalePrice('owner-1', 'listing-1', '1101'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.resaleListing.update).not.toHaveBeenCalled();
    });

    it('accepts a new price at the cap', async () => {
      prisma.resaleListing.findUnique.mockResolvedValue(listingWithPricingInfo);

      await service.updateResalePrice('owner-1', 'listing-1', '1100');

      expect(prisma.resaleListing.update).toHaveBeenCalledWith({
        where: { id: 'listing-1' },
        data: { price: 1100n },
      });
    });

    it('rejects when listing is not ACTIVE', async () => {
      prisma.resaleListing.findUnique.mockResolvedValue({
        ...listingWithPricingInfo,
        status: 'SOLD',
      });

      await expect(
        service.updateResalePrice('owner-1', 'listing-1', '900'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when caller does not own the listing', async () => {
      prisma.resaleListing.findUnique.mockResolvedValue(listingWithPricingInfo);

      await expect(
        service.updateResalePrice('someone-else', 'listing-1', '900'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ---- Bulk revoke (#267) ----

  describe('buildRevokeBatch / confirmRevokeBatch (#499, #500)', () => {
    const ticketIds = (count: number) =>
      Array.from({ length: count }, (_, i) => `ticket-${i + 1}`);

    function mockBatch(ids: string[]) {
      prisma.event.findUnique.mockResolvedValue({
        id: 'event-1',
        organizationId: 'org-1',
        status: 'PUBLISHED',
        chainEventId: 42n,
        organization: { stellarAccount: 'GORGANIZER' },
      });
      prisma.ticket.findMany.mockResolvedValue(
        ids.map((id, i) => ({
          id,
          eventId: 'event-1',
          chainTicketId: BigInt(i + 1),
        })),
      );
    }

    it('builds one revoke_batch envelope per 35-ticket chunk', async () => {
      const ids = ticketIds(36);
      mockBatch(ids);
      stellar.buildRevokeBatchTx
        .mockResolvedValueOnce('xdr-1')
        .mockResolvedValueOnce('xdr-2');

      const result = await service.buildRevokeBatch('user-1', 'event-1', ids);

      expect(result).toEqual({
        unsignedXdrs: ['xdr-1', 'xdr-2'],
        chunkSize: 35,
      });
      expect(stellar.buildRevokeBatchTx).toHaveBeenNthCalledWith(1, {
        organizerPublicKey: 'GORGANIZER',
        chainTicketIds: Array.from({ length: 35 }, (_, i) => BigInt(i + 1)),
      });
      expect(stellar.buildRevokeBatchTx).toHaveBeenNthCalledWith(2, {
        organizerPublicKey: 'GORGANIZER',
        chainTicketIds: [36n],
      });
    });

    it('submits all chunks before revoking tickets and cancelling listings', async () => {
      const ids = ticketIds(2);
      mockBatch(ids);
      mockSignedCall('revoke_batch', ['GORGANIZER', [1n, 2n]]);
      prisma.ticket.updateMany.mockResolvedValue({ count: 2 });
      prisma.resaleListing.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.confirmRevokeBatch(
        'user-1',
        'event-1',
        ids,
        ['signed-1'],
      );

      expect(result.count).toBe(2);
      expect(stellar.submitSignedTransaction).toHaveBeenCalledTimes(1);
      expect(prisma.ticket.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ids }, eventId: 'event-1' },
        data: { status: 'REVOKED' },
      });
      expect(prisma.resaleListing.updateMany).toHaveBeenCalledWith({
        where: { ticketId: { in: ids }, status: 'ACTIVE' },
        data: { status: 'CANCELLED' },
      });
      expect(prisma.processedTx.create).toHaveBeenCalledTimes(1);
      const [processedTxArgs] = prisma.processedTx.create.mock.calls[0] as [
        { data: { txHash: string } },
      ];
      expect(processedTxArgs.data.txHash).toBe('hash-1');
    });

    it('rejects a signed chunk that does not match the request before submitting', async () => {
      const ids = ticketIds(2);
      mockBatch(ids);
      mockSignedCall('revoke_batch', ['GORGANIZER', [1n, 99n]]);

      await expect(
        service.confirmRevokeBatch('user-1', 'event-1', ids, ['signed-1']),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
      expect(prisma.ticket.updateMany).not.toHaveBeenCalled();
    });

    it('leaves the DB untouched when a signed submission fails', async () => {
      const ids = ticketIds(2);
      mockBatch(ids);
      mockSignedCall('revoke_batch', ['GORGANIZER', [1n, 2n]]);
      stellar.submitSignedTransaction.mockRejectedValueOnce(
        new Error('RPC unavailable'),
      );

      await expect(
        service.confirmRevokeBatch('user-1', 'event-1', ids, ['signed-1']),
      ).rejects.toThrow('RPC unavailable');
      expect(prisma.ticket.updateMany).not.toHaveBeenCalled();
      expect(prisma.resaleListing.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a batch exceeding max size', async () => {
      await expect(
        service.buildRevokeBatch('user-1', 'event-1', ticketIds(101)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stellar.buildRevokeBatchTx).not.toHaveBeenCalled();
    });

    it('rejects when user is not an organization member', async () => {
      mockBatch(ticketIds(1));
      organizations.assertMember.mockRejectedValue(
        new ForbiddenException('Not a member'),
      );

      await expect(
        service.buildRevokeBatch('user-1', 'event-1', ticketIds(1)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects when some tickets are not found', async () => {
      mockBatch(ticketIds(1));

      await expect(
        service.buildRevokeBatch('user-1', 'event-1', ticketIds(2)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ---- confirmCheckIn / confirmRevoke status updates (#413) ----

  describe('confirmCheckIn — status update', () => {
    beforeEach(() => mockSignedCall('check_in', ['GORG', 7n]));

    const ticketRow = {
      id: 'ticket-1',
      eventId: 'event-1',
      ownerId: 'owner-1',
      chainTicketId: 7n,
      event: {
        organizationId: 'org-1',
        organization: { stellarAccount: 'GORG' },
      },
    };

    it('writes USED status and checkedInAt after a successful submission', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticketRow);
      prisma.ticket.update.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'ticket-1', ...data }),
      );

      const before = Date.now();
      const result = await service.confirmCheckIn(
        'user-1',
        'ticket-1',
        'signed-xdr',
      );

      expect(stellar.submitSignedTransaction).toHaveBeenCalledWith(
        'signed-xdr',
      );
      const updateCall = prisma.ticket.update.mock.calls[0] as [
        { where: { id: string }; data: { status: string; checkedInAt: Date } },
      ];
      expect(updateCall[0].where).toEqual({ id: 'ticket-1' });
      expect(updateCall[0].data.status).toBe('USED');
      expect(updateCall[0].data.checkedInAt).toBeInstanceOf(Date);
      expect(result.status).toBe('USED');
      expect((result.checkedInAt as Date).getTime()).toBeGreaterThanOrEqual(
        before,
      );
    });

    it('does not update the ticket when submission fails', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticketRow);
      stellar.submitSignedTransaction.mockRejectedValueOnce(
        new Error('Soroban submission failed'),
      );

      await expect(
        service.confirmCheckIn('user-1', 'ticket-1', 'bad-signed-xdr'),
      ).rejects.toThrow('Soroban submission failed');
      expect(prisma.ticket.update).not.toHaveBeenCalled();
    });

    it('requires the caller to be a member of the event organization', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticketRow);
      organizations.assertMember.mockRejectedValueOnce(
        new ForbiddenException('Not a member'),
      );

      await expect(
        service.confirmCheckIn('outsider-1', 'ticket-1', 'signed-xdr'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
      expect(prisma.ticket.update).not.toHaveBeenCalled();
    });
  });

  describe('confirmRevoke — status update', () => {
    beforeEach(() => mockSignedCall('revoke_ticket', ['GORG', 7n]));

    const ticketRow = {
      id: 'ticket-1',
      eventId: 'event-1',
      ownerId: 'owner-1',
      chainTicketId: 7n,
      event: {
        organizationId: 'org-1',
        organization: { stellarAccount: 'GORG' },
      },
    };

    it('writes REVOKED status after a successful submission', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticketRow);
      prisma.ticket.update.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'ticket-1', ...data }),
      );

      const result = await service.confirmRevoke(
        'organizer-1',
        'ticket-1',
        'signed-xdr',
      );

      expect(stellar.submitSignedTransaction).toHaveBeenCalledWith(
        'signed-xdr',
      );
      expect(prisma.ticket.update).toHaveBeenCalledWith({
        where: { id: 'ticket-1' },
        data: { status: 'REVOKED' },
      });
      expect(result.status).toBe('REVOKED');
    });

    it('cancels the ticket’s ACTIVE resale listing in the same transaction (#379)', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticketRow);

      await service.confirmRevoke('organizer-1', 'ticket-1', 'signed-xdr');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.resaleListing.updateMany).toHaveBeenCalledWith({
        where: { ticketId: 'ticket-1', status: 'ACTIVE' },
        data: { status: 'CANCELLED' },
      });
    });

    it('does not update the ticket when submission fails', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticketRow);
      stellar.submitSignedTransaction.mockRejectedValueOnce(
        new Error('Soroban submission failed'),
      );

      await expect(
        service.confirmRevoke('organizer-1', 'ticket-1', 'bad-signed-xdr'),
      ).rejects.toThrow('Soroban submission failed');
      expect(prisma.ticket.update).not.toHaveBeenCalled();
      expect(prisma.resaleListing.updateMany).not.toHaveBeenCalled();
    });

    it('requires the caller to be a member of the event organization', async () => {
      prisma.ticket.findUnique.mockResolvedValue(ticketRow);
      organizations.assertMember.mockRejectedValueOnce(
        new ForbiddenException('Not a member'),
      );

      await expect(
        service.confirmRevoke('outsider-1', 'ticket-1', 'signed-xdr'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
      expect(prisma.ticket.update).not.toHaveBeenCalled();
    });
  });

  // ---- buildBuyResaleTx status guard and seller/buyer checks (#414) ----

  describe('buildBuyResaleTx — status guard and buyer checks', () => {
    const resaleTicketRow = {
      id: 'ticket-1',
      status: 'RESALE',
      ownerId: 'seller-1',
      chainTicketId: 7n,
      event: {
        organizationId: 'org-1',
        organization: { stellarAccount: 'GORG' },
      },
    };

    it('rejects a VALID ticket (not listed for resale)', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        ...resaleTicketRow,
        status: 'VALID',
      });

      await expect(
        service.buildBuyResaleTx('buyer-1', 'ticket-1'),
      ).rejects.toBeInstanceOf(ListingInactiveError);
      expect(stellar.buildBuyResaleTx).not.toHaveBeenCalled();
    });

    it('builds the transaction for a RESALE ticket using the buyer public key', async () => {
      prisma.ticket.findUnique.mockResolvedValue(resaleTicketRow);
      prisma.user.findUnique.mockResolvedValue({
        id: 'buyer-1',
        stellarPublicKey: 'GBUYER',
      });

      const { unsignedXdr } = await service.buildBuyResaleTx(
        'buyer-1',
        'ticket-1',
      );

      expect(unsignedXdr).toBe('unsigned-xdr');
      expect(stellar.buildBuyResaleTx).toHaveBeenCalledWith({
        buyerPublicKey: 'GBUYER',
        chainTicketId: 7n,
      });
    });

    it('requires the buyer to have a connected Stellar wallet', async () => {
      prisma.ticket.findUnique.mockResolvedValue(resaleTicketRow);
      prisma.user.findUnique.mockResolvedValue({
        id: 'buyer-1',
        stellarPublicKey: null,
      });

      await expect(
        service.buildBuyResaleTx('buyer-1', 'ticket-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stellar.buildBuyResaleTx).not.toHaveBeenCalled();
    });

    it('requires the buyer to exist', async () => {
      prisma.ticket.findUnique.mockResolvedValue(resaleTicketRow);
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.buildBuyResaleTx('missing-buyer', 'ticket-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(stellar.buildBuyResaleTx).not.toHaveBeenCalled();
    });

    it('throws when the ticket itself does not exist', async () => {
      prisma.ticket.findUnique.mockResolvedValue(null);

      await expect(
        service.buildBuyResaleTx('buyer-1', 'missing-ticket'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ---- Check-in with reason (#266) ----

  describe('signed invocation guard on confirm paths (#157)', () => {
    it('rejects a check-in envelope for a different ticket with a 400', async () => {
      mockSignedCall('check_in', ['GORG', 8n]);
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        eventId: 'event-1',
        ownerId: 'owner-1',
        chainTicketId: 7n,
        event: {
          organizationId: 'org-1',
          organization: { stellarAccount: 'GORG' },
        },
      });

      await expect(
        service.confirmCheckIn('user-1', 'ticket-1', 'signed-xdr'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
      expect(prisma.ticket.update).not.toHaveBeenCalled();
    });

    it('rejects a revoke envelope that calls another function with a 400', async () => {
      mockSignedCall('check_in', ['GORG', 7n]);
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        eventId: 'event-1',
        ownerId: 'owner-1',
        chainTicketId: 7n,
        event: {
          organizationId: 'org-1',
          organization: { stellarAccount: 'GORG' },
        },
      });

      await expect(
        service.confirmRevoke('organizer-1', 'ticket-1', 'signed-xdr'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
    });

    it('rejects a cancel-resale envelope signed by another wallet with a 400', async () => {
      mockSignedCall('cancel_resale', ['GSOMEONEELSE', 7n]);
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        ownerId: 'owner-1',
        chainTicketId: 7n,
        event: { organization: {} },
      });
      prisma.user.findUnique.mockResolvedValue(
        createUser({ id: 'owner-1', stellarPublicKey: 'GOWNER' }),
      );

      await expect(
        service.confirmCancelResale('owner-1', 'ticket-1', 'signed-xdr'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
    });

    it('rejects a buy-resale envelope for a different ticket with a 400', async () => {
      mockSignedCall('buy_resale', ['GBUYER', 9n]);
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        status: 'RESALE',
        chainTicketId: 7n,
        event: { organization: {} },
      });
      prisma.user.findUnique.mockResolvedValue(
        createUser({ id: 'buyer-1', stellarPublicKey: 'GBUYER' }),
      );

      await expect(
        service.confirmBuyResale('buyer-1', 'ticket-1', 'signed-xdr'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
    });
  });

  describe('replayed confirm requests (#159)', () => {
    const ticketRow = {
      id: 'ticket-1',
      eventId: 'event-1',
      ownerId: 'owner-1',
      chainTicketId: 7n,
      event: {
        organizationId: 'org-1',
        organization: { stellarAccount: 'GORG' },
      },
    };

    it('returns the stored response without re-submitting or re-writing', async () => {
      const stored = { id: 'ticket-1', status: 'USED' };
      prisma.processedTx.findUnique.mockResolvedValue({
        txHash: 'hash-1',
        operation: 'check-in',
        response: stored,
      });
      prisma.ticket.findUnique.mockResolvedValue(ticketRow);

      const result = await service.confirmCheckIn(
        'user-1',
        'ticket-1',
        'signed-xdr',
      );

      expect(result).toEqual(stored);
      expect(prisma.processedTx.findUnique).toHaveBeenCalledWith({
        where: { txHash: 'hash-1' },
      });
      expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
      expect(prisma.ticket.update).not.toHaveBeenCalled();
      expect(prisma.processedTx.create).not.toHaveBeenCalled();
    });

    it('records the processed marker in the same transaction as the update', async () => {
      mockSignedCall('revoke_ticket', ['GORG', 7n]);
      prisma.ticket.findUnique.mockResolvedValue(ticketRow);
      prisma.ticket.update.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'ticket-1', ...data }),
      );

      await service.confirmRevoke('organizer-1', 'ticket-1', 'signed-xdr');

      expect(prisma.processedTx.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          txHash: 'hash-1',
          operation: 'revoke',
        }) as object,
      });
    });
  });

  describe('confirmCheckIn with reason', () => {
    beforeEach(() => mockSignedCall('check_in', ['GORG', 7n]));

    it('stores check-in reason when provided', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        eventId: 'event-1',
        ownerId: 'owner-1',
        chainTicketId: 7n,
        event: {
          organizationId: 'org-1',
          organization: { stellarAccount: 'GORG' },
        },
      });
      prisma.ticket.update.mockResolvedValue({
        id: 'ticket-1',
        checkInReason: 'scanner_malfunction',
      });

      await service.confirmCheckIn(
        'user-1',
        'ticket-1',
        'signed-xdr',
        undefined,
        'scanner_malfunction',
      );

      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            checkInReason: 'scanner_malfunction',
          }) as object,
        }),
      );
    });

    it('stores null reason when not provided', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        eventId: 'event-1',
        ownerId: 'owner-1',
        chainTicketId: 7n,
        event: {
          organizationId: 'org-1',
          organization: { stellarAccount: 'GORG' },
        },
      });
      prisma.ticket.update.mockResolvedValue({
        id: 'ticket-1',
        checkInReason: null,
      });

      await service.confirmCheckIn('user-1', 'ticket-1', 'signed-xdr');

      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            checkInReason: null,
          }) as object,
        }),
      );
    });
  });
});
