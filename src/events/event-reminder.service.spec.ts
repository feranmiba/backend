import { Prisma } from '@prisma/client';
import { EventReminderService } from './event-reminder.service';
import type { PrismaService } from '../prisma/prisma.service';

describe('EventReminderService', () => {
  let service: EventReminderService;
  let prisma: {
    event: { findMany: jest.Mock };
    eventReminder: { create: jest.Mock };
  };

  beforeEach(() => {
    jest.useFakeTimers();
    prisma = {
      event: { findMany: jest.fn() },
      eventReminder: { create: jest.fn() },
    };

    service = new EventReminderService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    service.stopCron();
    jest.useRealTimers();
  });

  it('only targets ticket holders with a verified email (#599)', async () => {
    prisma.event.findMany.mockResolvedValue([]);

    await service.sendUpcomingEventReminders();

    expect(prisma.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          tickets: {
            where: { owner: { emailVerifiedAt: { not: null } } },
            select: { ownerId: true },
          },
        },
      }),
    );
  });

  it('sends reminders for published events starting within 24h', async () => {
    prisma.event.findMany.mockResolvedValue([
      {
        id: 'event-1',
        name: 'Concert A',
        tickets: [{ ownerId: 'user-1' }, { ownerId: 'user-2' }],
      },
    ]);
    prisma.eventReminder.create.mockResolvedValue({ id: 'rem-1' });

    const result = await service.sendUpcomingEventReminders();

    expect(result.remindersSent).toBe(2);
    expect(prisma.eventReminder.create).toHaveBeenCalledTimes(2);
    expect(prisma.eventReminder.create).toHaveBeenCalledWith({
      data: { eventId: 'event-1', userId: 'user-1' },
    });
    expect(prisma.eventReminder.create).toHaveBeenCalledWith({
      data: { eventId: 'event-1', userId: 'user-2' },
    });
  });

  it('is idempotent and skips duplicate reminder creation (P2002 error)', async () => {
    prisma.event.findMany.mockResolvedValue([
      {
        id: 'event-1',
        name: 'Concert A',
        tickets: [{ ownerId: 'user-1' }],
      },
    ]);

    const p2002Error = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: '6.19.3' },
    );
    prisma.eventReminder.create.mockRejectedValueOnce(p2002Error);

    const result = await service.sendUpcomingEventReminders();

    expect(result.remindersSent).toBe(0);
  });

  it('runs on module init and sets interval', () => {
    prisma.event.findMany.mockResolvedValue([]);
    service.onModuleInit();

    expect(prisma.event.findMany).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(5 * 60 * 1000);
    expect(prisma.event.findMany).toHaveBeenCalledTimes(2);
  });
});
