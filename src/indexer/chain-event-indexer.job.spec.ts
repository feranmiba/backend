import 'reflect-metadata';

jest.mock('../stellar/stellar.service', () => ({ StellarService: jest.fn() }));

import {
  CHAIN_EVENT_INDEXER_JOB_NAME,
  ChainEventIndexerJob,
  indexerPollIntervalMs,
} from './chain-event-indexer.job';
import type { ChainEventIndexer } from './chain-event-indexer.service';
import type { FeatureFlagsService } from '../config/feature-flags.service';
import type { MetricsService } from '../common/metrics/metrics.service';
import type { SchedulerRegistry } from '@nestjs/schedule';

function setup(enabled: boolean) {
  const indexer = {
    indexOnce: jest
      .fn()
      .mockResolvedValue({ applied: 0, fetched: 0, lagLedgers: 0 }),
  };
  const flags = { isEnabled: jest.fn().mockReturnValue(enabled) };
  const metrics = { recordIndexerRun: jest.fn() };
  const scheduler = {
    addInterval: jest.fn(),
    doesExist: jest.fn().mockReturnValue(true),
    deleteInterval: jest.fn(),
  };
  const job = new ChainEventIndexerJob(
    indexer as unknown as ChainEventIndexer,
    flags as unknown as FeatureFlagsService,
    scheduler as unknown as SchedulerRegistry,
    metrics as unknown as MetricsService,
  );
  return { job, indexer, flags, metrics, scheduler };
}

describe('ChainEventIndexerJob', () => {
  it('does nothing while FEATURE_INDEXER is off', async () => {
    const { job, indexer, flags, metrics } = setup(false);

    await job.run();

    expect(flags.isEnabled).toHaveBeenCalledWith('indexer');
    expect(indexer.indexOnce).not.toHaveBeenCalled();
    expect(metrics.recordIndexerRun).not.toHaveBeenCalled();
  });

  it('polls the chain when FEATURE_INDEXER is on', async () => {
    const { job, indexer } = setup(true);

    await job.run();

    expect(indexer.indexOnce).toHaveBeenCalledTimes(1);
  });

  it('survives a failed poll so the next tick can retry', async () => {
    const { job, indexer } = setup(true);
    indexer.indexOnce.mockRejectedValueOnce(new Error('RPC unavailable'));

    await expect(job.run()).resolves.toBeUndefined();
  });

  describe('metrics (#530)', () => {
    it('records applied events and lag after a successful poll', async () => {
      const { job, indexer, metrics } = setup(true);
      indexer.indexOnce.mockResolvedValue({
        applied: 4,
        fetched: 100,
        lagLedgers: 37,
      });

      await job.run();

      expect(metrics.recordIndexerRun).toHaveBeenCalledWith({
        success: true,
        applied: 4,
        lagLedgers: 37,
      });
    });

    it('records a failed poll', async () => {
      const { job, indexer, metrics } = setup(true);
      indexer.indexOnce.mockRejectedValueOnce(new Error('RPC unavailable'));

      await job.run();

      expect(metrics.recordIndexerRun).toHaveBeenCalledWith({
        success: false,
      });
    });
  });

  it('skips a tick while the previous poll is still running', async () => {
    const { job, indexer } = setup(true);
    let finish!: () => void;
    indexer.indexOnce.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () => resolve({ applied: 0, fetched: 0, lagLedgers: 0 });
      }),
    );

    const first = job.run();
    await job.run();
    expect(indexer.indexOnce).toHaveBeenCalledTimes(1);

    finish();
    await first;
    await job.run();
    expect(indexer.indexOnce).toHaveBeenCalledTimes(2);
  });

  it('registers and removes its interval with the scheduler', () => {
    const { job, scheduler } = setup(true);
    jest.useFakeTimers();
    try {
      job.onModuleInit();
      expect(scheduler.addInterval).toHaveBeenCalledWith(
        CHAIN_EVENT_INDEXER_JOB_NAME,
        expect.anything(),
      );
      job.onModuleDestroy();
      expect(scheduler.deleteInterval).toHaveBeenCalledWith(
        CHAIN_EVENT_INDEXER_JOB_NAME,
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('indexerPollIntervalMs (#530)', () => {
  it('defaults to 30 seconds', () => {
    expect(indexerPollIntervalMs({})).toBe(30_000);
  });

  it('reads INDEXER_POLL_INTERVAL_SECONDS', () => {
    expect(indexerPollIntervalMs({ INDEXER_POLL_INTERVAL_SECONDS: '10' })).toBe(
      10_000,
    );
  });

  it.each(['0', '4', '3601', '1.5', 'often'])(
    'rejects %s',
    (INDEXER_POLL_INTERVAL_SECONDS) => {
      expect(() =>
        indexerPollIntervalMs({ INDEXER_POLL_INTERVAL_SECONDS }),
      ).toThrow(/INDEXER_POLL_INTERVAL_SECONDS/);
    },
  );
});
