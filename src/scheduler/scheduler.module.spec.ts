import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';
import { HEARTBEAT_JOB_NAME, HeartbeatJob } from './heartbeat.job';
import { SchedulerModule, isSchedulerEnabled } from './scheduler.module';
import { TicketStatusReconciliationJob } from './ticket-status-reconciliation.job';
import { EventReminderJob } from './event-reminder.job';
import { DistributedLockService } from './distributed-lock.service';
import { FeatureFlagsModule } from '../config/feature-flags.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';

describe('isSchedulerEnabled', () => {
  it('is on by default', () => {
    expect(isSchedulerEnabled({})).toBe(true);
  });

  it.each(['true', 'TRUE', '', 'anything-else'])(
    'stays on for SCHEDULER_ENABLED=%p',
    (value) => {
      expect(isSchedulerEnabled({ SCHEDULER_ENABLED: value })).toBe(true);
    },
  );

  it.each(['false', 'FALSE', ' false '])(
    'is off for SCHEDULER_ENABLED=%p',
    (value) => {
      expect(isSchedulerEnabled({ SCHEDULER_ENABLED: value })).toBe(false);
    },
  );
});

describe('SchedulerModule.forRoot', () => {
  it('registers the schedule module and the sample job by default', () => {
    const dynamicModule = SchedulerModule.forRoot({});

    // ScheduleModule, IndexerModule, StellarModule, and MetricsModule (#530).
    expect(dynamicModule.imports).toHaveLength(4);
    expect(dynamicModule.providers).toContain(HeartbeatJob);
    expect(dynamicModule.providers).toContain(TicketStatusReconciliationJob);
    expect(dynamicModule.providers).toContain(EventReminderJob);
    expect(dynamicModule.providers).toContain(DistributedLockService);
  });

  it('registers nothing when SCHEDULER_ENABLED=false', () => {
    const dynamicModule = SchedulerModule.forRoot({
      SCHEDULER_ENABLED: 'false',
    });

    expect(dynamicModule.imports).toBeUndefined();
    expect(dynamicModule.providers).toBeUndefined();
  });

  it('schedules the heartbeat job once the app is running', async () => {
    const app = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        FeatureFlagsModule,
        PrismaModule,
        SchedulerModule.forRoot({}),
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({
        ticket: {
          findMany: jest.fn().mockResolvedValue([]),
          updateMany: jest.fn(),
        },
      })
      .overrideProvider(StellarService)
      .useValue({ verifyTicket: jest.fn() })
      .compile();
    await app.init();

    try {
      const registry = app.get(SchedulerRegistry);
      expect(registry.getCronJobs().has(HEARTBEAT_JOB_NAME)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('creates no scheduler at all when disabled by env', async () => {
    const app = await Test.createTestingModule({
      imports: [SchedulerModule.forRoot({ SCHEDULER_ENABLED: 'false' })],
    }).compile();
    await app.init();

    try {
      expect(() => app.get(SchedulerRegistry, { strict: false })).toThrow();
      expect(() => app.get(HeartbeatJob, { strict: false })).toThrow();
    } finally {
      await app.close();
    }
  });
});
