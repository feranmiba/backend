import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { CHAIN_STATUS_TO_DB_STATUS } from '../stellar/ticket-status';

export const TICKET_STATUS_RECONCILIATION_JOB_NAME =
  'ticket-status-reconciliation';
export const DEFAULT_TICKET_RECONCILIATION_INTERVAL_MINUTES = 60;
const RECONCILIATION_PAGE_SIZE = 100;

export interface TicketStatusReconciliationCounts {
  checked: number;
  drifted: number;
  repaired: number;
  raced: number;
  failed: number;
}

export function ticketReconciliationIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = env.TICKET_RECONCILIATION_INTERVAL_MINUTES;
  if (value === undefined) {
    return DEFAULT_TICKET_RECONCILIATION_INTERVAL_MINUTES * 60_000;
  }

  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error(
      'TICKET_RECONCILIATION_INTERVAL_MINUTES must be an integer from 1 to 1440',
    );
  }
  return minutes * 60_000;
}

/** Reconciles the cached ticket status against the contract's source of truth. */
@Injectable()
export class TicketStatusReconciliationJob
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TicketStatusReconciliationJob.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const interval = setInterval(() => {
      void this.run();
    }, ticketReconciliationIntervalMs());
    this.scheduler.addInterval(TICKET_STATUS_RECONCILIATION_JOB_NAME, interval);
  }

  onModuleDestroy(): void {
    if (
      this.scheduler.doesExist(
        'interval',
        TICKET_STATUS_RECONCILIATION_JOB_NAME,
      )
    ) {
      this.scheduler.deleteInterval(TICKET_STATUS_RECONCILIATION_JOB_NAME);
    }
  }

  async run(): Promise<void> {
    if (this.running) {
      this.logger.warn(
        'Skipping ticket status reconciliation; previous run is still active',
      );
      return;
    }

    this.running = true;
    try {
      await this.reconcileOnce();
    } catch (err) {
      this.logger.error(
        `Ticket status reconciliation failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    } finally {
      this.running = false;
    }
  }

  async reconcileOnce(): Promise<TicketStatusReconciliationCounts> {
    const counts: TicketStatusReconciliationCounts = {
      checked: 0,
      drifted: 0,
      repaired: 0,
      raced: 0,
      failed: 0,
    };
    let afterId: string | undefined;

    while (true) {
      const tickets = await this.prisma.ticket.findMany({
        ...(afterId ? { where: { id: { gt: afterId } } } : {}),
        select: { id: true, chainTicketId: true, status: true },
        orderBy: { id: 'asc' },
        take: RECONCILIATION_PAGE_SIZE,
      });
      if (tickets.length === 0) {
        break;
      }

      for (const ticket of tickets) {
        counts.checked++;
        try {
          const onChain = await this.stellar.verifyTicket(ticket.chainTicketId);
          const expectedStatus = CHAIN_STATUS_TO_DB_STATUS[onChain.status];
          if (expectedStatus === ticket.status) {
            continue;
          }

          counts.drifted++;
          const result = await this.prisma.ticket.updateMany({
            where: { id: ticket.id, status: ticket.status },
            data: { status: expectedStatus },
          });
          if (result.count === 0) {
            counts.raced++;
            this.logger.warn(
              `Ticket status drift changed during reconciliation (ticketId=${ticket.id}, chainStatus=${expectedStatus})`,
            );
            continue;
          }

          counts.repaired++;
          this.logger.warn(
            `Repaired ticket status drift (ticketId=${ticket.id}, databaseStatus=${ticket.status}, chainStatus=${expectedStatus})`,
          );
        } catch (err) {
          counts.failed++;
          this.logger.error(
            `Ticket status reconciliation failed (ticketId=${ticket.id}): ${(err as Error).message}`,
            (err as Error).stack,
          );
        }
      }

      afterId = tickets[tickets.length - 1].id;
      if (tickets.length < RECONCILIATION_PAGE_SIZE) {
        break;
      }
    }

    this.logger.log(
      `Ticket status reconciliation complete: checked=${counts.checked}, drifted=${counts.drifted}, repaired=${counts.repaired}, raced=${counts.raced}, failed=${counts.failed}`,
    );
    return counts;
  }
}
