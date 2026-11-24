import { Address } from '@stellar/stellar-sdk';

/**
 * Struct: EventParams
 */
export interface EventParams {
  name: string;
  category: string;
  max_resale_multiplier_bps: number;
  royalty_bps: number;
  starts_at: bigint;
  transfer_freeze_seconds: bigint;
  resale_cutoff_seconds: bigint;
  max_per_wallet: number | null;
  refund_window_seconds: bigint | null;
  presale_starts_at: bigint | null;
  presale_ends_at: bigint | null;
}

/**
 * Enum: TicketStatus
 */
export enum TicketStatus {
  /**
   * Enum Case: Valid
   */
  Valid = 0,
  /**
   * Enum Case: Used
   */
  Used = 1,
  /**
   * Enum Case: Revoked
   */
  Revoked = 2,
  /**
   * Enum Case: Resale
   */
  Resale = 3,
  /**
   * Enum Case: Refunded
   */
  Refunded = 4,
}

/**
 * Struct: Ticket
 */
export interface Ticket {
  event_id: bigint;
  owner: string;
  tier: string;
  seat: string;
  status: TicketStatus;
  original_price: bigint;
  resale_price: bigint;
  transfers: number;
  purchased_at: bigint;
}

/**
 * Struct: Event
 */
export interface Event {
  organizer: string;
  name: string;
  category: string;
  max_resale_multiplier_bps: number;
  min_resale_multiplier_bps: number | null;
  max_transfers_per_ticket: number | null;
  royalty_bps: number;
  tickets_issued: bigint;
  starts_at: bigint;
  transfer_freeze_seconds: bigint;
  resale_cutoff_seconds: bigint;
  escrow_enabled: boolean;
  escrow_release_ledger: number;
  escrow_balance: bigint;
  payment_token: string | null;
  transferable: boolean;
  max_per_wallet: number | null;
  refund_window_seconds: bigint | null;
  presale_starts_at: bigint | null;
  presale_ends_at: bigint | null;
  max_tickets: bigint | null;
  check_in_opens_seconds: bigint | null;
  ends_at: bigint | null;
  ticket_expires_at: bigint | null;
  max_reentries: number;
  cancelled: boolean;
  royalty_splits: Array<[string, number]> | null;
}

/**
 * Error Enum: Error
 */
export const Error = {
  1: { message: 'AlreadyInitialized' },
  2: { message: 'NotInitialized' },
  3: { message: 'EventNotFound' },
  4: { message: 'EventAlreadyExists' },
  5: { message: 'TicketNotFound' },
  6: { message: 'NotOrganizer' },
  7: { message: 'NotOwner' },
  8: { message: 'AlreadyUsed' },
  9: { message: 'Revoked' },
  10: { message: 'NotForResale' },
  11: { message: 'ResalePriceExceedsCap' },
  12: { message: 'InvalidPrice' },
  13: { message: 'InvalidRoyalty' },
  14: { message: 'EscrowNotEnabled' },
  15: { message: 'EventNotEnded' },
  16: { message: 'PurchaseTooSoon' },
  17: { message: 'NotAdmin' },
  18: { message: 'EventAlreadyStarted' },
  19: { message: 'InvalidEventTime' },
  20: { message: 'TransfersFrozen' },
  21: { message: 'ResaleClosed' },
  22: { message: 'InvalidLottery' },
  23: { message: 'GiftClaimNotFound' },
  24: { message: 'GiftClaimExpired' },
  25: { message: 'InvalidSecret' },
  26: { message: 'InvalidExpiry' },
  27: { message: 'EmptyBatch' },
  28: { message: 'BatchTooLarge' },
  29: { message: 'InvalidPaymentToken' },
  30: { message: 'NoPendingPaymentToken' },
  31: { message: 'TimelockNotElapsed' },
  32: { message: 'TicketsAlreadyIssued' },
  33: { message: 'TransferLimitExceeded' },
  34: { message: 'ResalePriceBelowFloor' },
  35: { message: 'TierPriceNotSet' },
  36: { message: 'InvalidMultiplier' },
  37: { message: 'EmptyNameOrCategory' },
  38: { message: 'StringTooLong' },
  39: { message: 'SelfTransfer' },
  40: { message: 'SelfPurchase' },
  41: { message: 'OrganizerNotApproved' },
  42: { message: 'ResaleListingActive' },
  43: { message: 'InvalidTicketLifecycle' },
  44: { message: 'SamePaymentToken' },
  45: { message: 'MathOverflow' },
  46: { message: 'NotTransferable' },
  47: { message: 'MetadataUriNotSet' },
  48: { message: 'TicketNotUsed' },
  49: { message: 'RetentionPeriodNotElapsed' },
  50: { message: 'SoldOut' },
  51: { message: 'InvalidCapacity' },
  52: { message: 'CheckInWindowClosed' },
  53: { message: 'InvalidCheckInWindow' },
  54: { message: 'TicketExpired' },
  55: { message: 'InvalidTicketExpiry' },
  56: { message: 'ReentryNotAllowed' },
  57: { message: 'ReentryLimitReached' },
  58: { message: 'EventCancelled' },
  59: { message: 'TierSoldOut' },
  60: { message: 'InvalidMaxUses' },
  66: { message: 'GiftClaimAlreadyExists' },
  67: { message: 'ContractPaused' },
  68: { message: 'RefundWindowExpired' },
  69: { message: 'AlreadyRefunded' },
  70: { message: 'PurchaseLimitExceeded' },
  71: { message: 'NotOnAllowlist' },
  72: { message: 'PresaleNotStarted' },
  73: { message: 'PresaleEnded' },
  74: { message: 'InvalidPlatformFee' },
  75: { message: 'AuctionNotFound' },
  76: { message: 'AuctionEnded' },
  77: { message: 'AuctionNotEnded' },
  78: { message: 'AuctionActive' },
  79: { message: 'AuctionHasBids' },
  80: { message: 'InvalidAuctionEnd' },
  81: { message: 'BidTooLow' },
  82: { message: 'OfferNotFound' },
  83: { message: 'OfferAlreadyExists' },
  84: { message: 'NotApproved' },
  85: { message: 'ResaleFundsOutstanding' },
  86: { message: 'ZoneNotAllowed' },
  87: { message: 'InvalidZones' },
  88: { message: 'SaleNotStarted' },
  89: { message: 'SaleEnded' },
  90: { message: 'InvalidSaleWindow' },
  91: { message: 'TicketNotYetValid' },
  92: { message: 'TicketValidityEnded' },
  93: { message: 'InvalidValidityWindow' },
  94: { message: 'InvalidPerks' },
  95: { message: 'InvalidEventMetadata' },
  96: { message: 'EventMetadataFull' },
  97: { message: 'NoPendingAdmin' },
  98: { message: 'NotPendingAdmin' },
} as const;
