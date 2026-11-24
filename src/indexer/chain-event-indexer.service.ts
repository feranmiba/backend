import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChainTicketEvent, StellarService } from '../stellar/stellar.service';
import { CHAIN_STATUS_TO_DB_STATUS } from '../stellar/ticket-status';

/** Name of the `IndexerCursor` row this indexer advances. */
export const TICKET_EVENTS_CURSOR = 'ticketing-events';

/** Events fetched per poll. */
export const INDEXER_PAGE_SIZE = 100;

/** Outcome of one {@link ChainEventIndexer.indexOnce} poll. */
export interface IndexerRunResult {
  /** Events that changed state (re-delivered events are not counted). */
  applied: number;
  /** Events returned by the RPC for this page. */
  fetched: number;
  /** How many ledgers the cursor trails the RPC's latest ledger (#530). */
  lagLedgers: number;
}

/**
 * #530 — ledgers between the last event applied and the RPC's latest ledger.
 * A short page means the stream is drained up to `latestLedger`, so the lag is
 * zero; a full page means more events are waiting after its last one.
 */
export function indexerLagLedgers(
  events: ChainTicketEvent[],
  latestLedger: number,
): number {
  const last = events[events.length - 1];
  if (!last || events.length < INDEXER_PAGE_SIZE) return 0;
  return Math.max(0, latestLedger - last.ledger);
}

/**
 * Applies ticketing-contract events (`TicketIssued`, `TicketCheckedIn`) to the
 * cached ticket state, so the DB keeps up with the chain (#163).
 *
 * Each event is applied in its own DB transaction together with the cursor
 * advance. Two guarantees follow:
 *   - Idempotent: the RPC event id is a primary key in `ProcessedChainEvent`,
 *     so a re-delivered event is skipped and does not change state twice.
 *   - Resumable: the cursor only moves past events whose changes committed,
 *     so a crash mid-page resumes from the last applied event.
 */
@Injectable()
export class ChainEventIndexer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
  ) {}

  /** Polls one page after the stored cursor. */
  async indexOnce(): Promise<IndexerRunResult> {
    const stored = await this.prisma.indexerCursor.findUnique({
      where: { name: TICKET_EVENTS_CURSOR },
    });
    const { events, latestLedger } = await this.stellar.getTicketEvents(
      stored?.cursor,
      INDEXER_PAGE_SIZE,
    );

    let applied = 0;
    for (const event of events) {
      if (await this.apply(event)) {
        applied++;
      }
    }
    return {
      applied,
      fetched: events.length,
      lagLedgers: indexerLagLedgers(events, latestLedger),
    };
  }

  /** Returns false when the event was already applied. */
  private async apply(event: ChainTicketEvent): Promise<boolean> {
    // #529 — a check-in only uses a ticket up once its entries are exhausted:
    // a multi-use pass stays `Valid` on chain until its last entry, and
    // `pass_out` can hand one back. So the status to cache comes from the
    // contract, not from the event name. The read happens before the DB
    // transaction; if it fails, nothing commits and the cursor stays put, so
    // the next poll retries this event.
    const checkedInStatus =
      event.name === 'TicketCheckedIn' && event.chainTicketId !== null
        ? CHAIN_STATUS_TO_DB_STATUS[
            (await this.stellar.verifyTicket(event.chainTicketId)).status
          ]
        : null;

    return this.prisma.$transaction(async (tx) => {
      // `skipDuplicates` turns a repeat into `ON CONFLICT DO NOTHING`, so the
      // transaction stays usable. A caught unique-violation would abort it.
      const { count } = await tx.processedChainEvent.createMany({
        data: [{ id: event.id, ledger: event.ledger, name: event.name }],
        skipDuplicates: true,
      });
      const isNew = count > 0;

      if (isNew && checkedInStatus !== null && event.chainTicketId !== null) {
        await tx.ticket.updateMany({
          where: { chainTicketId: event.chainTicketId },
          data: { status: checkedInStatus },
        });
      }

      await tx.indexerCursor.upsert({
        where: { name: TICKET_EVENTS_CURSOR },
        create: { name: TICKET_EVENTS_CURSOR, cursor: event.pagingToken },
        update: { cursor: event.pagingToken },
      });
      return isNew;
    });
  }
}
