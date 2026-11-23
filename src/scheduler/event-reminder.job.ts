import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventReminderService } from '../events/event-reminder.service';
import { DistributedLockService } from './distributed-lock.service';
import type { LockHandle } from './distributed-lock.service';

export const EVENT_REMINDER_JOB_NAME = 'event-reminder';
export const EVENT_REMINDER_LOCK_NAME = 'event-reminder-job';
export const EVENT_REMINDER_LOCK_TTL_MS = 4 * 60 * 1000; // 4 minutes lease

/**
 * Scheduled job to process and deliver 24h event reminders across the cluster (#536).
 * Uses DistributedLockService to guarantee single-replica execution per interval.
 */
@Injectable()
export class EventReminderJob {
  private readonly logger = new Logger(EventReminderJob.name);

  constructor(
    @Optional() private readonly reminderService?: EventReminderService,
    @Optional() private readonly lockService?: DistributedLockService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: EVENT_REMINDER_JOB_NAME })
  async run(): Promise<void> {
    if (!this.reminderService) {
      return;
    }

    let lock: LockHandle | null = null;
    if (this.lockService) {
      lock = await this.lockService.acquire(
        EVENT_REMINDER_LOCK_NAME,
        EVENT_REMINDER_LOCK_TTL_MS,
      );
      if (!lock) {
        // Another replica owns a valid lock; skip without running reminder query or spamming logs
        this.logger.debug(
          `Skipping event reminder job: lock "${EVENT_REMINDER_LOCK_NAME}" is currently held by another replica`,
        );
        return;
      }
    }

    try {
      this.logger.log('Starting scheduled event reminder processing');
      const result = await this.reminderService.sendUpcomingEventReminders();
      this.logger.log(
        `Completed event reminder processing: ${result.remindersSent} reminder(s) sent`,
      );
    } catch (err) {
      this.logger.error(
        `Event reminder job execution failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    } finally {
      if (lock && this.lockService) {
        await this.lockService.release(lock);
      }
    }
  }
}
