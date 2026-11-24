import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { ScanRateLimitGuard } from '../common/guards/scan-rate-limit.guard';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { TicketsService } from './tickets.service';
import { IssueTicketDto } from './dto/issue-ticket.dto';
import { ConfirmIssueTicketDto } from './dto/confirm-issue-ticket.dto';
import { PurchasePrimaryDto } from './dto/purchase-primary.dto';
import { ConfirmPurchasePrimaryDto } from './dto/confirm-purchase-primary.dto';
import { TransferTicketDto } from './dto/transfer-ticket.dto';
import { ConfirmTransferTicketDto } from './dto/confirm-transfer-ticket.dto';
import { ConfirmSignedTxDto } from './dto/confirm-signed-tx.dto';
import { ConfirmCheckInDto } from './dto/confirm-check-in.dto';
import { ListForResaleDto } from './dto/list-for-resale.dto';
import { ConfirmListForResaleDto } from './dto/confirm-list-for-resale.dto';
import { UpdateResalePriceDto } from './dto/update-resale-price.dto';
import { ResaleListingsQueryDto } from './dto/resale-listings-query.dto';
import { MyTicketsQueryDto } from './dto/my-tickets-query.dto';
import { RevokeBatchDto } from './dto/revoke-batch.dto';
import { ConfirmRevokeBatchDto } from './dto/confirm-revoke-batch.dto';
import { IssueBatchDto } from './dto/issue-batch.dto';

/** Largest on-chain ticket id: the contract stores ids as u64. */
const MAX_CHAIN_TICKET_ID = 2n ** 64n - 1n;

/**
 * Parses a route param into the BigInt `chainTicketId`. A malformed value is
 * "not found"; a well-formed but negative or >= 2^64 value is a bad request.
 */
function parseChainTicketId(raw: string): bigint {
  let id: bigint;
  try {
    id = BigInt(raw);
  } catch {
    throw new NotFoundException('Ticket not found');
  }
  if (id < 0n || id > MAX_CHAIN_TICKET_ID) {
    throw new BadRequestException(
      'chainTicketId must be between 0 and 2^64 - 1',
    );
  }
  return id;
}

@Controller('tickets')
@UseGuards(JwtAuthGuard)
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Get('resale')
  findActiveResaleListings(@Query() query: ResaleListingsQueryDto) {
    return this.ticketsService.findActiveResaleListings(
      query.cursor,
      query.limit,
    );
  }

  @Get('mine')
  findMine(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: MyTicketsQueryDto,
  ) {
    return this.ticketsService.findMine(user.userId, query.status);
  }

  @Get('verify/:qrSecret')
  @UseGuards(ScanRateLimitGuard)
  verify(
    @CurrentUser() user: CurrentUserPayload,
    @Param('qrSecret') qrSecret: string,
  ) {
    return this.ticketsService.verify(user.userId, qrSecret);
  }

  @Get('offline-public-keys')
  getOfflinePublicKeys() {
    return this.ticketsService.getOfflinePublicKeys();
  }

  @Get('by-chain/:chainTicketId')
  findByChainTicketId(
    @CurrentUser() user: CurrentUserPayload,
    @Param('chainTicketId') chainTicketId: string,
  ) {
    return this.ticketsService.findByChainTicketId(
      user.userId,
      parseChainTicketId(chainTicketId),
    );
  }

  /** #121 — One ticket, for its owner or staff of the event's organization. */
  @Get(':ticketId')
  findOne(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
  ) {
    return this.ticketsService.findOne(user.userId, ticketId);
  }

  /**
   * #125 — PNG of the ticket's QR code, owner only. Written to the response
   * directly: the global BigInt serializer would flatten a returned Buffer.
   */
  @Get(':ticketId/qr')
  async getQrImage(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
    @Res() res: Response,
  ) {
    const png = await this.ticketsService.getQrImage(user.userId, ticketId);
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.send(png);
  }

  /** #129 — Short-lived signed token to render in place of the static QR secret, owner only. */
  @Get(':ticketId/qr-token')
  @Header('Cache-Control', 'no-store')
  getQrToken(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
  ) {
    return this.ticketsService.issueQrToken(user.userId, ticketId);
  }

  @Get(':ticketId/offline-token')
  getOfflineToken(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
  ) {
    return this.ticketsService.getOfflineToken(user.userId, ticketId);
  }

  @Post('issue')
  @UseInterceptors(IdempotencyInterceptor)
  buildIssueTx(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: IssueTicketDto,
  ) {
    return this.ticketsService.buildIssueTx(
      user.userId,
      dto.ticketTypeId,
      dto.toUserId,
      dto.toPublicKey,
      dto.seat,
    );
  }

  /** #133 — Batch-build issue_ticket envelopes, one per recipient (up to ISSUE_BATCH_MAX_SIZE). */
  @Post('issue-batch')
  buildIssueBatch(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: IssueBatchDto,
  ) {
    return this.ticketsService.buildIssueBatch(
      user.userId,
      dto.ticketTypeId,
      dto.recipients,
    );
  }

  @Post('confirm-issue')
  confirmIssue(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: ConfirmIssueTicketDto,
  ) {
    return this.ticketsService.confirmIssue(
      user.userId,
      dto.ticketTypeId,
      dto.toUserId,
      dto.toPublicKey,
      dto.seat,
      dto.signedXdr,
    );
  }

  @Post('purchase')
  @UseInterceptors(IdempotencyInterceptor)
  buildPurchaseTx(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: PurchasePrimaryDto,
  ) {
    return this.ticketsService.buildPurchaseTx(
      user.userId,
      dto.ticketTypeId,
      dto.seat,
      dto.promoCode,
    );
  }

  @Post('confirm-purchase')
  confirmPurchase(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: ConfirmPurchasePrimaryDto,
  ) {
    return this.ticketsService.confirmPurchase(
      user.userId,
      dto.ticketTypeId,
      dto.seat,
      dto.signedXdr,
      dto.promoCode,
    );
  }

  @Post(':ticketId/transfer')
  @UseInterceptors(IdempotencyInterceptor)
  buildTransferTx(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
    @Body() dto: TransferTicketDto,
  ) {
    return this.ticketsService.buildTransferTx(
      user.userId,
      ticketId,
      dto.toUserId,
      dto.toPublicKey,
    );
  }

  @Post(':ticketId/confirm-transfer')
  confirmTransfer(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
    @Body() dto: ConfirmTransferTicketDto,
  ) {
    return this.ticketsService.confirmTransfer(
      user.userId,
      ticketId,
      dto.toUserId,
      dto.toPublicKey,
      dto.signedXdr,
    );
  }

  @Post(':ticketId/check-in')
  @UseInterceptors(IdempotencyInterceptor)
  buildCheckInTx(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
  ) {
    return this.ticketsService.buildCheckInTx(user.userId, ticketId);
  }

  @Post(':ticketId/confirm-check-in')
  confirmCheckIn(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
    @Body() dto: ConfirmCheckInDto,
  ) {
    return this.ticketsService.confirmCheckIn(
      user.userId,
      ticketId,
      dto.signedXdr,
      dto.gateId,
      dto.reason,
    );
  }

  @Post(':ticketId/revoke')
  @UseInterceptors(IdempotencyInterceptor)
  buildRevokeTx(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
  ) {
    return this.ticketsService.buildRevokeTx(user.userId, ticketId);
  }

  @Post(':ticketId/confirm-revoke')
  confirmRevoke(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
    @Body() dto: ConfirmSignedTxDto,
  ) {
    return this.ticketsService.confirmRevoke(
      user.userId,
      ticketId,
      dto.signedXdr,
    );
  }

  @Post('events/:eventId/revoke-batch')
  @UseInterceptors(IdempotencyInterceptor)
  buildRevokeBatch(
    @CurrentUser() user: CurrentUserPayload,
    @Param('eventId') eventId: string,
    @Body() dto: RevokeBatchDto,
  ) {
    return this.ticketsService.buildRevokeBatch(
      user.userId,
      eventId,
      dto.ticketIds,
    );
  }

  @Post('events/:eventId/confirm-revoke-batch')
  confirmRevokeBatch(
    @CurrentUser() user: CurrentUserPayload,
    @Param('eventId') eventId: string,
    @Body() dto: ConfirmRevokeBatchDto,
  ) {
    return this.ticketsService.confirmRevokeBatch(
      user.userId,
      eventId,
      dto.ticketIds,
      dto.signedXdrs,
    );
  }

  @Post(':ticketId/list-resale')
  @UseInterceptors(IdempotencyInterceptor)
  buildListForResaleTx(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
    @Body() dto: ListForResaleDto,
  ) {
    return this.ticketsService.buildListForResaleTx(
      user.userId,
      ticketId,
      dto.price,
    );
  }

  @Post(':ticketId/confirm-list-resale')
  confirmListForResale(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
    @Body() dto: ConfirmListForResaleDto,
  ) {
    return this.ticketsService.confirmListForResale(
      user.userId,
      ticketId,
      dto.price,
      dto.signedXdr,
      dto.expiresAt,
    );
  }

  @Get('resale/:listingId/price-history')
  getPriceHistory(@Param('listingId') listingId: string) {
    return this.ticketsService.getPriceHistory(listingId);
  }

  @Patch('resale/:listingId/price')
  updateResalePrice(
    @CurrentUser() user: CurrentUserPayload,
    @Param('listingId') listingId: string,
    @Body() dto: UpdateResalePriceDto,
  ) {
    return this.ticketsService.updateResalePrice(
      user.userId,
      listingId,
      dto.price,
    );
  }

  @Post('resale/cancel-expired')
  cancelExpiredListings() {
    return this.ticketsService.cancelExpiredListings();
  }

  @Post(':ticketId/cancel-resale')
  @UseInterceptors(IdempotencyInterceptor)
  buildCancelResaleTx(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
  ) {
    return this.ticketsService.buildCancelResaleTx(user.userId, ticketId);
  }

  @Post(':ticketId/confirm-cancel-resale')
  confirmCancelResale(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
    @Body() dto: ConfirmSignedTxDto,
  ) {
    return this.ticketsService.confirmCancelResale(
      user.userId,
      ticketId,
      dto.signedXdr,
    );
  }

  @Post(':ticketId/buy-resale')
  @UseInterceptors(IdempotencyInterceptor)
  buildBuyResaleTx(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
  ) {
    return this.ticketsService.buildBuyResaleTx(user.userId, ticketId);
  }

  @Post(':ticketId/confirm-buy-resale')
  confirmBuyResale(
    @CurrentUser() user: CurrentUserPayload,
    @Param('ticketId') ticketId: string,
    @Body() dto: ConfirmSignedTxDto,
  ) {
    return this.ticketsService.confirmBuyResale(
      user.userId,
      ticketId,
      dto.signedXdr,
    );
  }
}
