import { EventReminderJob, EVENT_REMINDER_LOCK_NAME } from './event-reminder.job';
import type { EventReminderService } from '../events/event-reminder.service';
import type { DistributedLockService, LockHandle } from './distributed-lock.service';

describe('EventReminderJob', () => {
  let job: EventReminderJob;
  let reminderService: { sendUpcomingEventReminders: jest.Mock };
  let lockService: { acquire: jest.Mock; release: jest.Mock };

  beforeEach(() => {
    reminderService = {
      sendUpcomingEventReminders: jest.fn().mockResolvedValue({ remindersSent: 3 }),
    };
    lockService = {
      acquire: jest.fn(),
      release: jest.fn().mockResolvedValue(true),
    };

    job = new EventReminderJob(
      reminderService as unknown as EventReminderService,
      lockService as unknown as DistributedLockService,
    );
  });

  it('acquires the distributed lock and processes reminders when lock is granted (#536)', async () => {
    const lock: LockHandle = { lockName: EVENT_REMINDER_LOCK_NAME, ownerToken: 'token-123' };
    lockService.acquire.mockResolvedValue(lock);

    await job.run();

    expect(lockService.acquire).toHaveBeenCalledWith(
      EVENT_REMINDER_LOCK_NAME,
      expect.any(Number),
    );
    expect(reminderService.sendUpcomingEventReminders).toHaveBeenCalledTimes(1);
    expect(lockService.release).toHaveBeenCalledWith(lock);
  });

  it('skips execution without querying or processing when lock is held by another replica (#536)', async () => {
    lockService.acquire.mockResolvedValue(null);

    await job.run();

    expect(lockService.acquire).toHaveBeenCalledTimes(1);
    expect(reminderService.sendUpcomingEventReminders).not.toHaveBeenCalled();
    expect(lockService.release).not.toHaveBeenCalled();
  });

  it('releases lock in finally even if reminder processing fails (#536)', async () => {
    const lock: LockHandle = { lockName: EVENT_REMINDER_LOCK_NAME, ownerToken: 'token-456' };
    lockService.acquire.mockResolvedValue(lock);
    reminderService.sendUpcomingEventReminders.mockRejectedValue(new Error('DB failure'));

    await job.run();

    expect(reminderService.sendUpcomingEventReminders).toHaveBeenCalledTimes(1);
    expect(lockService.release).toHaveBeenCalledWith(lock);
  });
});
