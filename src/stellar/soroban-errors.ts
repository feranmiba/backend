import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { Error as ContractError } from './generated/ticketing/types';

export interface SorobanErrorMapping {
  status: number;
  message: string;
  code: string;
}

type ContractErrorName =
  (typeof ContractError)[keyof typeof ContractError]['message'];

type ErrorDetail = Pick<SorobanErrorMapping, 'status' | 'message'>;

/**
 * Human-readable mapping for every error in the generated contract error enum.
 * `Record<ContractErrorName, ...>` makes adding a new contract error a
 * compile-time failure until it is mapped here.
 */
const ERROR_DETAILS: Record<ContractErrorName, ErrorDetail> = {
  AlreadyInitialized: {
    status: HttpStatus.CONFLICT,
    message: 'The contract has already been initialized',
  },
  NotInitialized: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'The ticketing contract is not initialized',
  },
  EventNotFound: {
    status: HttpStatus.NOT_FOUND,
    message: 'Event not found on-chain',
  },
  EventAlreadyExists: {
    status: HttpStatus.CONFLICT,
    message: 'An event with this id already exists on-chain',
  },
  TicketNotFound: {
    status: HttpStatus.NOT_FOUND,
    message: 'Ticket not found on-chain',
  },
  NotOrganizer: {
    status: HttpStatus.FORBIDDEN,
    message: 'Only the event organizer can perform this action',
  },
  NotOwner: {
    status: HttpStatus.FORBIDDEN,
    message: 'Only the ticket owner can perform this action',
  },
  AlreadyUsed: {
    status: HttpStatus.CONFLICT,
    message: 'The ticket has already been checked in',
  },
  Revoked: { status: HttpStatus.GONE, message: 'The ticket has been revoked' },
  NotForResale: {
    status: HttpStatus.CONFLICT,
    message: 'The ticket is not listed for resale',
  },
  ResalePriceExceedsCap: {
    status: HttpStatus.BAD_REQUEST,
    message: "The resale price exceeds the event's resale cap",
  },
  InvalidPrice: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The price is invalid',
  },
  InvalidRoyalty: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The royalty exceeds 100%',
  },
  EscrowNotEnabled: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Escrow is not enabled for this event',
  },
  EventNotEnded: {
    status: HttpStatus.CONFLICT,
    message: 'The event has not reached its escrow release ledger',
  },
  PurchaseTooSoon: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'The purchase was made too soon after the previous one',
  },
  NotAdmin: {
    status: HttpStatus.FORBIDDEN,
    message: 'Only the contract admin can perform this action',
  },
  EventAlreadyStarted: {
    status: HttpStatus.CONFLICT,
    message: 'This action is only available before the event starts',
  },
  InvalidEventTime: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The event start time must be in the future',
  },
  TransfersFrozen: {
    status: HttpStatus.CONFLICT,
    message: 'Transfers are frozen for this event',
  },
  ResaleClosed: {
    status: HttpStatus.CONFLICT,
    message: 'Resale listings are closed for this event',
  },
  InvalidLottery: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The lottery entrants or winner count are invalid',
  },
  GiftClaimNotFound: {
    status: HttpStatus.NOT_FOUND,
    message: 'No gift claim exists for this ticket',
  },
  GiftClaimExpired: {
    status: HttpStatus.GONE,
    message: 'The gift claim has expired',
  },
  InvalidSecret: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The gift secret does not match the stored hash',
  },
  InvalidExpiry: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The expiry must be in the future',
  },
  EmptyBatch: { status: HttpStatus.BAD_REQUEST, message: 'The batch is empty' },
  BatchTooLarge: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The batch exceeds the maximum batch size',
  },
  InvalidPaymentToken: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The proposed payment token is not a valid token contract',
  },
  NoPendingPaymentToken: {
    status: HttpStatus.CONFLICT,
    message: 'There is no pending payment token change',
  },
  TimelockNotElapsed: {
    status: HttpStatus.CONFLICT,
    message: 'The payment token change timelock has not elapsed',
  },
  TicketsAlreadyIssued: {
    status: HttpStatus.CONFLICT,
    message: 'Tickets have already been issued for this event',
  },
  TransferLimitExceeded: {
    status: HttpStatus.CONFLICT,
    message: "The ticket has reached its event's transfer limit",
  },
  ResalePriceBelowFloor: {
    status: HttpStatus.BAD_REQUEST,
    message: "The resale price is below the event's resale floor",
  },
  TierPriceNotSet: {
    status: HttpStatus.CONFLICT,
    message: 'No primary sale price is configured for this tier',
  },
  InvalidMultiplier: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The resale multiplier is below the face-value floor',
  },
  EmptyNameOrCategory: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The event name or category is empty',
  },
  StringTooLong: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A name, category, tier or seat exceeds the maximum length',
  },
  SelfTransfer: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A ticket cannot be transferred to its current owner',
  },
  SelfPurchase: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The seller cannot buy their own resale listing',
  },
  OrganizerNotApproved: {
    status: HttpStatus.FORBIDDEN,
    message: 'This organizer is not approved to create events',
  },
  ResaleListingActive: {
    status: HttpStatus.CONFLICT,
    message: 'Cancel the active resale listing before performing this action',
  },
  InvalidTicketLifecycle: {
    status: HttpStatus.CONFLICT,
    message: 'The stored ticket has an unknown lifecycle status',
  },
  SamePaymentToken: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The proposed payment token is already active',
  },
  MathOverflow: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A financial calculation overflowed',
  },
  NotTransferable: {
    status: HttpStatus.CONFLICT,
    message: 'Tickets for this event are not transferable',
  },
  MetadataUriNotSet: {
    status: HttpStatus.NOT_FOUND,
    message: 'This ticket has no metadata URI',
  },
  TicketNotUsed: {
    status: HttpStatus.CONFLICT,
    message: 'The ticket has not been checked in',
  },
  RetentionPeriodNotElapsed: {
    status: HttpStatus.CONFLICT,
    message: "The used ticket's retention period has not elapsed",
  },
  SoldOut: {
    status: HttpStatus.CONFLICT,
    message: 'The event has reached its maximum ticket count',
  },
  InvalidCapacity: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The capacity is below the number of tickets already issued',
  },
  CheckInWindowClosed: {
    status: HttpStatus.GONE,
    message: 'Check-in is outside the event window',
  },
  InvalidCheckInWindow: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The check-in window ends before the event starts',
  },
  TicketExpired: {
    status: HttpStatus.GONE,
    message: 'The ticket has passed its expiry time',
  },
  InvalidTicketExpiry: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The ticket expiry must be in the future',
  },
  ReentryNotAllowed: {
    status: HttpStatus.CONFLICT,
    message: 'This event does not allow re-entry',
  },
  ReentryLimitReached: {
    status: HttpStatus.CONFLICT,
    message: 'The ticket has used all of its re-entries',
  },
  EventCancelled: {
    status: HttpStatus.GONE,
    message: 'The event has been cancelled',
  },
  TierSoldOut: {
    status: HttpStatus.CONFLICT,
    message: 'The tier has reached its issuance cap',
  },
  InvalidMaxUses: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The maximum uses is invalid',
  },
  GiftClaimAlreadyExists: {
    status: HttpStatus.CONFLICT,
    message: 'A gift claim already exists for this ticket',
  },
  ContractPaused: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'The ticketing contract is paused',
  },
  RefundWindowExpired: {
    status: HttpStatus.GONE,
    message: 'The refund window for this ticket has expired',
  },
  AlreadyRefunded: {
    status: HttpStatus.CONFLICT,
    message: 'The ticket has already been refunded',
  },
  PurchaseLimitExceeded: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'The wallet has reached its purchase limit for this event',
  },
  NotOnAllowlist: {
    status: HttpStatus.FORBIDDEN,
    message: 'This wallet is not on the event presale allowlist',
  },
  PresaleNotStarted: {
    status: HttpStatus.CONFLICT,
    message: 'The presale has not started',
  },
  PresaleEnded: { status: HttpStatus.GONE, message: 'The presale has ended' },
  InvalidPlatformFee: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The platform fee exceeds 100%',
  },
  AuctionNotFound: {
    status: HttpStatus.NOT_FOUND,
    message: 'No auction exists for this ticket',
  },
  AuctionEnded: {
    status: HttpStatus.CONFLICT,
    message: 'The auction has ended',
  },
  AuctionNotEnded: {
    status: HttpStatus.CONFLICT,
    message: 'The auction is still open',
  },
  AuctionActive: {
    status: HttpStatus.CONFLICT,
    message: 'Settle the active auction before performing this action',
  },
  AuctionHasBids: {
    status: HttpStatus.CONFLICT,
    message: 'The auction already has bids and cannot be cancelled',
  },
  InvalidAuctionEnd: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The auction end is invalid',
  },
  BidTooLow: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The bid does not beat the highest bid or meet the reserve',
  },
  OfferNotFound: {
    status: HttpStatus.NOT_FOUND,
    message: 'No offer exists for this ticket',
  },
  OfferAlreadyExists: {
    status: HttpStatus.CONFLICT,
    message: 'An offer already exists for this ticket',
  },
  NotApproved: {
    status: HttpStatus.FORBIDDEN,
    message: 'The caller is not the approved operator for this ticket',
  },
  ResaleFundsOutstanding: {
    status: HttpStatus.CONFLICT,
    message: 'Resale bids or offers are still held in escrow',
  },
  ZoneNotAllowed: {
    status: HttpStatus.FORBIDDEN,
    message: "The ticket's tier may not enter this zone",
  },
  InvalidZones: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Too many zones, or a zone label is empty or too long',
  },
  SaleNotStarted: {
    status: HttpStatus.CONFLICT,
    message: 'The primary sale has not started',
  },
  SaleEnded: { status: HttpStatus.GONE, message: 'The primary sale has ended' },
  InvalidSaleWindow: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The sale window ends at or before it starts',
  },
  TicketNotYetValid: {
    status: HttpStatus.CONFLICT,
    message: "The ticket's validity window has not opened",
  },
  TicketValidityEnded: {
    status: HttpStatus.GONE,
    message: "The ticket's validity window has closed",
  },
  InvalidValidityWindow: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The validity window ends at or before it starts',
  },
  InvalidPerks: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Too many perks, or a perk label is empty or too long',
  },
  InvalidEventMetadata: {
    status: HttpStatus.BAD_REQUEST,
    message: 'An event metadata key or value is empty or too long',
  },
  EventMetadataFull: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The event already holds the maximum number of metadata entries',
  },
  NoPendingAdmin: {
    status: HttpStatus.CONFLICT,
    message: 'There is no pending admin transfer',
  },
  NotPendingAdmin: {
    status: HttpStatus.FORBIDDEN,
    message: 'The caller is not the nominee for the pending admin transfer',
  },
};

function machineCode(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** Every generated contract error code, keyed by its numeric code. */
export const SOROBAN_ERROR_MAP: Record<number, SorobanErrorMapping> =
  Object.fromEntries(
    Object.entries(ContractError).map(([code, { message }]) => {
      const detail = ERROR_DETAILS[message];
      return [Number(code), { ...detail, code: machineCode(message) }];
    }),
  );

/** Pull the numeric code out of the several formats the RPC uses for contract errors. */
export function parseSorobanErrorCode(errorMsg: string): number | null {
  const patterns = [
    /Error\(\s*Contract\s*,\s*#(\d+)\s*\)/i,
    /\bcontract(?:\s+error)?\s*#?(\d+)\b/i,
    /ContractError\(\s*(\d+)\s*\)/i,
  ];
  for (const pattern of patterns) {
    const match = errorMsg.match(pattern);
    if (match?.[1]) return Number(match[1]);
  }
  return null;
}

export function mapSorobanErrorToApiException(errorMsg: string): HttpException {
  const codeNum = parseSorobanErrorCode(errorMsg);
  if (codeNum !== null && SOROBAN_ERROR_MAP[codeNum]) {
    const mapped = SOROBAN_ERROR_MAP[codeNum];
    return new HttpException(
      {
        statusCode: mapped.status,
        message: mapped.message,
        error: mapped.code,
      },
      mapped.status,
    );
  }
  return new BadRequestException(`Soroban contract error: ${errorMsg}`);
}
