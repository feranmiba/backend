import 'reflect-metadata';

// The indexer only needs StellarService's shape (it's fully mocked below);
// avoid loading the ESM-only @stellar/stellar-sdk chain under Jest.
jest.mock('../stellar/stellar.service', () => ({ StellarService: jest.fn() }));

import {
  ChainEventIndexer,
  INDEXER_PAGE_SIZE,
  TICKET_EVENTS_CURSOR,
  indexerLagLedgers,
} from './chain-event-indexer.service';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  ChainTicketEvent,
  StellarService,
} from '../stellar/stellar.service';

/** A page as the RPC returns it: issue, check-in, and a check-in with no ticket id. */
const fixturePage: ChainTicketEvent[] = [
  {
    id: 'evt-1',
    pagingToken: 'pt-1',
    ledger: 100,
    name: 'TicketIssued',
    chainTicketId: 7n,
  },
  {
    id: 'evt-2',
    pagingToken: 'pt-2',
    ledger: 101,
    name: 'TicketCheckedIn',
    chainTicketId: 7n,
  },
  {
    id: 'evt-3',
    pagingToken: 'pt-3',
    ledger: 102,
    name: 'TicketCheckedIn',
    chainTicketId: null,
  },
];

function setup() {
  const tx = {
    processedChainEvent: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    ticket: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    indexerCursor: { upsert: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    indexerCursor: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((cb: (client: typeof tx) => unknown) => cb(tx)),
  };
  const stellar = {
    getTicketEvents: jest
      .fn()
      .mockResolvedValue({ events: fixturePage, latestLedger: 110 }),
    verifyTicket: jest.fn().mockResolvedValue({ status: 'Used' }),
  };
  const indexer = new ChainEventIndexer(
    prisma as unknown as PrismaService,
    stellar as unknown as StellarService,
  );
  return { indexer, prisma, stellar, tx };
}

describe('ChainEventIndexer', () => {
  it('starts from the beginning of the stream when no cursor is stored', async () => {
    const { indexer, prisma, stellar } = setup();

    await indexer.indexOnce();

    expect(prisma.indexerCursor.findUnique).toHaveBeenCalledWith({
      where: { name: TICKET_EVENTS_CURSOR },
    });
    expect(stellar.getTicketEvents).toHaveBeenCalledWith(
      undefined,
      INDEXER_PAGE_SIZE,
    );
  });

  it('resumes from the persisted cursor', async () => {
    const { indexer, prisma, stellar } = setup();
    prisma.indexerCursor.findUnique.mockResolvedValue({
      name: TICKET_EVENTS_CURSOR,
      cursor: 'pt-9',
    });

    await indexer.indexOnce();

    expect(stellar.getTicketEvents).toHaveBeenCalledWith(
      'pt-9',
      INDEXER_PAGE_SIZE,
    );
  });

  it('applies every new event and reports how many changed state', async () => {
    const { indexer, tx } = setup();

    const { applied, fetched } = await indexer.indexOnce();

    expect(applied).toBe(3);
    expect(fetched).toBe(3);
    expect(tx.processedChainEvent.createMany).toHaveBeenCalledTimes(3);
  });

  it('marks the ticket USED on check-in, and skips events without a ticket id', async () => {
    const { indexer, tx } = setup();

    await indexer.indexOnce();

    expect(tx.ticket.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.ticket.updateMany).toHaveBeenCalledWith({
      where: { chainTicketId: 7n },
      data: { status: 'USED' },
    });
  });

  describe('multi-use passes (#529)', () => {
    it('keeps a pass VALID when the chain says it has entries left', async () => {
      const { indexer, stellar, tx } = setup();
      stellar.verifyTicket.mockResolvedValue({ status: 'Valid' });

      await indexer.indexOnce();

      expect(stellar.verifyTicket).toHaveBeenCalledWith(7n);
      expect(tx.ticket.updateMany).toHaveBeenCalledWith({
        where: { chainTicketId: 7n },
        data: { status: 'VALID' },
      });
    });

    it('marks a pass USED once the chain reports its last entry consumed', async () => {
      const { indexer, stellar, tx } = setup();
      stellar.verifyTicket.mockResolvedValue({ status: 'Used' });

      await indexer.indexOnce();

      expect(tx.ticket.updateMany).toHaveBeenCalledWith({
        where: { chainTicketId: 7n },
        data: { status: 'USED' },
      });
    });

    it('only reads the chain for check-ins that carry a ticket id', async () => {
      const { indexer, stellar } = setup();

      await indexer.indexOnce();

      expect(stellar.verifyTicket).toHaveBeenCalledTimes(1);
    });

    it('leaves the event unapplied and the cursor in place when the read fails', async () => {
      const { indexer, stellar, tx } = setup();
      stellar.verifyTicket.mockRejectedValue(new Error('RPC unavailable'));

      await expect(indexer.indexOnce()).rejects.toThrow('RPC unavailable');

      // Only the TicketIssued event before the check-in committed.
      expect(tx.processedChainEvent.createMany).toHaveBeenCalledTimes(1);
      expect(tx.indexerCursor.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({ update: { cursor: 'pt-1' } }),
      );
      expect(tx.ticket.updateMany).not.toHaveBeenCalled();
    });
  });

  it('advances the cursor past each applied event', async () => {
    const { indexer, tx } = setup();

    await indexer.indexOnce();

    expect(tx.indexerCursor.upsert).toHaveBeenLastCalledWith({
      where: { name: TICKET_EVENTS_CURSOR },
      create: { name: TICKET_EVENTS_CURSOR, cursor: 'pt-3' },
      update: { cursor: 'pt-3' },
    });
  });

  it('skips events already processed, without touching tickets twice', async () => {
    const { indexer, tx } = setup();
    tx.processedChainEvent.createMany.mockResolvedValue({ count: 0 });

    const { applied } = await indexer.indexOnce();

    expect(applied).toBe(0);
    expect(tx.ticket.updateMany).not.toHaveBeenCalled();
    // The cursor still moves, so a re-delivered page does not stall the indexer.
    expect(tx.indexerCursor.upsert).toHaveBeenCalledTimes(3);
  });

  describe('lag (#530)', () => {
    const page = (count: number, lastLedger: number): ChainTicketEvent[] =>
      Array.from({ length: count }, (_, i) => ({
        id: `evt-${i}`,
        pagingToken: `evt-${i}`,
        ledger: lastLedger - (count - 1 - i),
        name: 'TicketIssued',
        chainTicketId: BigInt(i),
      }));

    it('is zero when the page is short, because the stream is drained', () => {
      expect(indexerLagLedgers(page(3, 100), 500)).toBe(0);
      expect(indexerLagLedgers([], 500)).toBe(0);
    });

    it('is the ledger gap after a full page', () => {
      expect(indexerLagLedgers(page(INDEXER_PAGE_SIZE, 400), 500)).toBe(100);
    });

    it('is reported by indexOnce', async () => {
      const { indexer, stellar } = setup();
      stellar.getTicketEvents.mockResolvedValue({
        events: page(INDEXER_PAGE_SIZE, 1_000),
        latestLedger: 1_250,
      });

      const { lagLedgers } = await indexer.indexOnce();

      expect(lagLedgers).toBe(250);
    });
  });
});
