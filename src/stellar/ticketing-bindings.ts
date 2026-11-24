import { xdr } from '@stellar/stellar-sdk';
import { Spec } from '@stellar/stellar-sdk/contract';
import { SPEC } from './generated/ticketing/spec';
import type { EventParams } from './generated/ticketing/types';

export type {
  Event,
  EventParams,
  Ticket,
  TicketStatus,
} from './generated/ticketing/types';

// The generated `Client` is available at `./generated/ticketing`; this module
// only needs the spec and types, so it deliberately does not import the client
// (which pulls in ESM-only SDK internals that Jest cannot load directly).

/** The generated contract spec, reused for every encode/decode operation. */
const spec = new Spec(SPEC);

/** Encode a contract call with the generated ABI instead of hand-built ScVals. */
export function contractArgs(
  functionName: string,
  args: Record<string, unknown>,
): xdr.ScVal[] {
  return spec.funcArgsToScVals(functionName, args);
}

export interface CreateEventArgs {
  organizer: string;
  eventId: bigint;
  params: EventParams;
}

export function encodeCreateEvent({
  organizer,
  eventId,
  params,
}: CreateEventArgs): xdr.ScVal[] {
  return contractArgs('create_event', {
    organizer,
    event_id: eventId,
    params,
  });
}

export function encodeIssueTicket(args: {
  organizer: string;
  eventId: bigint;
  to: string;
  tier: string;
  seat: string;
  price: bigint;
}): xdr.ScVal[] {
  return contractArgs('issue_ticket', {
    organizer: args.organizer,
    event_id: args.eventId,
    to: args.to,
    tier: args.tier,
    seat: args.seat,
    price: args.price,
  });
}

export function encodePurchasePrimary(args: {
  buyer: string;
  eventId: bigint;
  tier: string;
  seat: string;
}): xdr.ScVal[] {
  return contractArgs('purchase_primary', {
    buyer: args.buyer,
    event_id: args.eventId,
    tier: args.tier,
    seat: args.seat,
  });
}

export function encodeTransferTicket(args: {
  from: string;
  ticketId: bigint;
  to: string;
}): xdr.ScVal[] {
  return contractArgs('transfer_ticket', {
    from: args.from,
    ticket_id: args.ticketId,
    to: args.to,
  });
}

export function encodeCheckIn(args: {
  organizer: string;
  ticketId: bigint;
}): xdr.ScVal[] {
  return contractArgs('check_in', {
    organizer: args.organizer,
    ticket_id: args.ticketId,
  });
}

export function encodeRevokeTicket(args: {
  organizer: string;
  ticketId: bigint;
}): xdr.ScVal[] {
  return contractArgs('revoke_ticket', {
    organizer: args.organizer,
    ticket_id: args.ticketId,
  });
}

export function encodeRevokeBatch(args: {
  organizer: string;
  ticketIds: bigint[];
}): xdr.ScVal[] {
  return contractArgs('revoke_batch', {
    organizer: args.organizer,
    ticket_ids: args.ticketIds,
  });
}

export function encodeListForResale(args: {
  owner: string;
  ticketId: bigint;
  price: bigint;
}): xdr.ScVal[] {
  return contractArgs('list_for_resale', {
    owner: args.owner,
    ticket_id: args.ticketId,
    price: args.price,
  });
}

export function encodeCancelResale(args: {
  owner: string;
  ticketId: bigint;
}): xdr.ScVal[] {
  return contractArgs('cancel_resale', {
    owner: args.owner,
    ticket_id: args.ticketId,
  });
}

export function encodeBuyResale(args: {
  buyer: string;
  ticketId: bigint;
}): xdr.ScVal[] {
  return contractArgs('buy_resale', {
    buyer: args.buyer,
    ticket_id: args.ticketId,
  });
}
