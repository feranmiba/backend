import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { HeartbeatJob } from './heartbeat.job';
import { ChainEventIndexerJob } from '../indexer/chain-event-indexer.job';
import { IndexerModule } from '../indexer/indexer.module';
import { StellarModule } from '../stellar/stellar.module';
import { EventsModule } from '../events/events.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { TicketStatusReconciliationJob } from './ticket-status-reconciliation.job';
import { DistributedLockService } from './distributed-lock.service';
import { EventReminderJob } from './event-reminder.job';

/** Cron jobs run unless `SCHEDULER_ENABLED=false`. */
export function isSchedulerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.SCHEDULER_ENABLED?.trim().toLowerCase() !== 'false';
}

/**
 * Registers `@nestjs/schedule` and the app's cron jobs. Add new jobs to the
 * `providers` below so `SCHEDULER_ENABLED=false` switches them off too — with
 * it off, none of them are instantiated and no cron timer is ever created.
 *
 * Read from the environment at import time (a module's imports can't wait on
 * `ConfigService`), so in `AppModule` this must come after
 * `ConfigModule.forRoot()`, which is what loads `.env`.
 */
@Module({})
export class SchedulerModule {
  static forRoot(env: NodeJS.ProcessEnv = process.env): DynamicModule {
    if (!isSchedulerEnabled(env)) {
      return { module: SchedulerModule };
    }
    return {
      module: SchedulerModule,
      imports: [
        ScheduleModule.forRoot(),
        IndexerModule,
        StellarModule,
        EventsModule,
        MetricsModule,
      ],
      providers: [
        HeartbeatJob,
        ChainEventIndexerJob,
        TicketStatusReconciliationJob,
        DistributedLockService,
        EventReminderJob,
      ],
      exports: [DistributedLockService],
    };
  }
}
