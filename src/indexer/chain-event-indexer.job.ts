import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { MetricsService } from '../common/metrics/metrics.service';
import { FeatureFlagsService } from '../config/feature-flags.service';
import { ChainEventIndexer } from './chain-event-indexer.service';

export const CHAIN_EVENT_INDEXER_JOB_NAME = 'chain-event-indexer';
export const DEFAULT_INDEXER_POLL_INTERVAL_SECONDS = 30;

/**
 * #530 — poll interval from `INDEXER_POLL_INTERVAL_SECONDS` (integer, 5 to
 * 3600; default 30).
 */
export function indexerPollIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = env.INDEXER_POLL_INTERVAL_SECONDS;
  if (value === undefined || value.trim() === '') {
    return DEFAULT_INDEXER_POLL_INTERVAL_SECONDS * 1000;
  }
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
    throw new Error(
      'INDEXER_POLL_INTERVAL_SECONDS must be an integer from 5 to 3600',
    );
  }
  return seconds * 1000;
}

/**
 * Polls the ticketing contract for events every `INDEXER_POLL_INTERVAL_SECONDS`
 * (default 30). Does nothing unless `FEATURE_INDEXER=true`, so the timer can
 * stay registered in every environment. Registered by `SchedulerModule`, so
 * `SCHEDULER_ENABLED=false` switches it off. See docs/SCHEDULER.md.
 */
@Injectable()
export class ChainEventIndexerJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChainEventIndexerJob.name);
  private running = false;

  constructor(
    private readonly indexer: ChainEventIndexer,
    private readonly flags: FeatureFlagsService,
    @Optional() private readonly scheduler?: SchedulerRegistry,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.scheduler) return;
    const interval = setInterval(() => {
      void this.run();
    }, indexerPollIntervalMs());
    this.scheduler.addInterval(CHAIN_EVENT_INDEXER_JOB_NAME, interval);
  }

  onModuleDestroy(): void {
    if (this.scheduler?.doesExist('interval', CHAIN_EVENT_INDEXER_JOB_NAME)) {
      this.scheduler.deleteInterval(CHAIN_EVENT_INDEXER_JOB_NAME);
    }
  }

  async run(): Promise<void> {
    if (!this.flags.isEnabled('indexer')) {
      return;
    }
    // A page with many check-ins makes one RPC read each, so a slow poll can
    // outlast the interval. Skip the tick rather than index the same page twice.
    if (this.running) {
      this.logger.warn('Previous indexer poll still running; skipping tick');
      return;
    }
    this.running = true;
    try {
      const { applied, lagLedgers } = await this.indexer.indexOnce();
      this.metrics?.recordIndexerRun({ success: true, applied, lagLedgers });
      if (applied > 0) {
        this.logger.log(`Applied ${applied} ticket event(s) from chain`);
      }
    } catch (err) {
      this.metrics?.recordIndexerRun({ success: false });
      this.logger.error(
        `Chain event indexing failed: ${(err as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }
}
