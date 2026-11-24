import { TicketStatus } from '@prisma/client';
import type { OnChainTicket } from './stellar.service';

/** Maps the contract's `TicketStatus` onto the cached `Ticket.status` column. */
export const CHAIN_STATUS_TO_DB_STATUS: Record<
  OnChainTicket['status'],
  TicketStatus
> = {
  Valid: TicketStatus.VALID,
  Used: TicketStatus.USED,
  Revoked: TicketStatus.REVOKED,
  Resale: TicketStatus.RESALE,
};
