import {
  Account,
  nativeToScVal,
  rpc,
  Transaction,
  xdr,
} from '@stellar/stellar-sdk';

/** The subset of `rpc.Server` that `StellarService` calls, as jest mocks. */
export interface MockRpcServer {
  getAccount: jest.Mock<Promise<Account>, [string]>;
  prepareTransaction: jest.Mock<Promise<Transaction>, [Transaction]>;
  simulateTransaction: jest.Mock<Promise<unknown>, [Transaction]>;
  sendTransaction: jest.Mock<Promise<unknown>, [Transaction]>;
  getTransaction: jest.Mock<Promise<unknown>, [string]>;
  getEvents: jest.Mock<Promise<unknown>, [unknown]>;
  getLatestLedger: jest.Mock<Promise<{ sequence: number }>, []>;
}

/**
 * Stands in for Soroban RPC. Accounts resolve at sequence 1 and
 * `prepareTransaction` hands the built transaction back untouched, so the
 * envelope a `build*Tx` method returns is exactly what the builder produced.
 * Override any call for a specific scenario.
 */
export function createMockRpcServer(
  overrides: Partial<MockRpcServer> = {},
): MockRpcServer {
  return {
    getAccount: jest.fn((publicKey: string) =>
      Promise.resolve(new Account(publicKey, '1')),
    ),
    prepareTransaction: jest.fn((tx: Transaction) => Promise.resolve(tx)),
    simulateTransaction: jest.fn<Promise<unknown>, [Transaction]>(() =>
      Promise.resolve(simulationSuccess(nativeToScVal(0n, { type: 'u64' }))),
    ),
    sendTransaction: jest.fn<Promise<unknown>, [Transaction]>(),
    getTransaction: jest.fn<Promise<unknown>, [string]>(),
    getEvents: jest.fn<Promise<unknown>, [unknown]>(),
    getLatestLedger: jest.fn(() => Promise.resolve({ sequence: 500 })),
    ...overrides,
  };
}

export const TX_HASH = 'ab'.repeat(32);

// ---- sendTransaction / getTransaction responses ----

export function sendPending(hash = TX_HASH) {
  return {
    status: 'PENDING',
    hash,
    latestLedger: 100,
    latestLedgerCloseTime: 1_700_000_000,
  };
}

export function sendRejected(hash = TX_HASH) {
  return {
    status: 'ERROR',
    hash,
    errorResult: { code: 'txBAD_SEQ' },
    latestLedger: 100,
    latestLedgerCloseTime: 1_700_000_000,
  };
}

export function sendDuplicate(hash = TX_HASH) {
  return {
    status: 'DUPLICATE',
    hash,
    latestLedger: 100,
    latestLedgerCloseTime: 1_700_000_000,
  };
}

export function sendTryAgainLater(hash = TX_HASH) {
  return {
    status: 'TRY_AGAIN_LATER',
    hash,
    latestLedger: 100,
    latestLedgerCloseTime: 1_700_000_000,
  };
}

export function txSuccess(returnValue?: xdr.ScVal) {
  return { status: rpc.Api.GetTransactionStatus.SUCCESS, returnValue };
}

export function txFailed() {
  return { status: rpc.Api.GetTransactionStatus.FAILED };
}

export function txNotFound() {
  return { status: rpc.Api.GetTransactionStatus.NOT_FOUND };
}

// ---- simulateTransaction responses ----

export function simulationSuccess(retval: xdr.ScVal) {
  return {
    latestLedger: 100,
    minResourceFee: '0',
    events: [],
    result: { retval, auth: [] },
  };
}

export function simulationError(error: string) {
  return { latestLedger: 100, events: [], error };
}

// ---- contract structs ----

export interface TicketFixture {
  eventId: bigint;
  owner: string;
  tier: string;
  seat: string;
  status: string;
  originalPrice: bigint;
  resalePrice: bigint;
}

/**
 * `Ticket` as the contract returns it from `verify_ticket`: a map keyed by
 * snake_case symbols. `status` is a unit enum variant, which the SDK decodes
 * either as a bare symbol or as `{ tag }` depending on version; pick the
 * encoding under test with `statusEncoding`.
 */
export function ticketScVal(
  ticket: TicketFixture,
  statusEncoding: 'symbol' | 'tagged' = 'symbol',
): xdr.ScVal {
  const status =
    statusEncoding === 'symbol'
      ? nativeToScVal(ticket.status, { type: 'symbol' })
      : nativeToScVal(
          { tag: ticket.status },
          { type: { tag: ['symbol', 'symbol'] } },
        );
  return nativeToScVal(
    {
      event_id: ticket.eventId,
      owner: ticket.owner,
      tier: ticket.tier,
      seat: ticket.seat,
      status,
      original_price: ticket.originalPrice,
      resale_price: ticket.resalePrice,
    },
    {
      type: {
        event_id: ['symbol', 'u64'],
        owner: ['symbol', 'address'],
        tier: ['symbol', 'string'],
        seat: ['symbol', 'string'],
        status: ['symbol', null],
        original_price: ['symbol', 'i128'],
        resale_price: ['symbol', 'i128'],
      },
    },
  );
}

export interface EventFixture {
  organizer: string;
  name: string;
  category: string;
  maxResaleMultiplierBps: number;
  royaltyBps: number;
  ticketsIssued: bigint;
}

/** `Event` as the contract returns it from `get_event`. */
export function eventScVal(event: EventFixture): xdr.ScVal {
  return nativeToScVal(
    {
      organizer: event.organizer,
      name: event.name,
      category: event.category,
      max_resale_multiplier_bps: event.maxResaleMultiplierBps,
      royalty_bps: event.royaltyBps,
      tickets_issued: event.ticketsIssued,
    },
    {
      type: {
        organizer: ['symbol', 'address'],
        name: ['symbol', 'string'],
        category: ['symbol', 'string'],
        max_resale_multiplier_bps: ['symbol', 'u32'],
        royalty_bps: ['symbol', 'u32'],
        tickets_issued: ['symbol', 'u64'],
      },
    },
  );
}
