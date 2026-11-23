import { Prisma } from '@prisma/client';
import { EventReminderService } from './event-reminder.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationService } from '../notifications/notifications.service';

describe('EventReminderService', () => {
  let service: EventReminderService;
  let notifications: { sendEventReminder: jest.Mock };
  let prisma: {
    event: { findMany: jest.Mock };
    eventReminder: { create: jest.Mock; findUnique?: jest.Mock };
    user?: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    jest.useFakeTimers();
    prisma = {
      event: { findMany: jest.fn() },
      eventReminder: { create: jest.fn(), findUnique: jest.fn().mockResolvedValue(null) },
      user: { findUnique: jest.fn() },
    };
    notifications = {
      sendEventReminder: jest.fn().mockResolvedValue(undefined),
    };

    service = new EventReminderService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationService,
    );
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
            select: expect.objectContaining({ ownerId: true }),
          },
        },
      }),
    );
  });

  it('sends reminders for published events starting within 24h and delivers notifications (#537)', async () => {
    const startsAt = new Date('2026-10-01T19:00:00Z');
    prisma.event.findMany.mockResolvedValue([
      {
        id: 'event-1',
        name: 'Concert A',
        venue: 'Main Arena',
        startsAt,
        tickets: [
          {
            ownerId: 'user-1',
            seat: 'A-12',
            owner: { id: 'user-1', email: 'user1@example.com', name: 'User One' },
          },
          {
            ownerId: 'user-2',
            seat: 'unassigned',
            owner: { id: 'user-2', email: 'user2@example.com', name: 'User Two' },
          },
        ],
      },
    ]);
    prisma.eventReminder.create.mockResolvedValue({ id: 'rem-1' });

    const result = await service.sendUpcomingEventReminders();

    expect(result.remindersSent).toBe(2);
    expect(notifications.sendEventReminder).toHaveBeenCalledTimes(2);
    expect(notifications.sendEventReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user1@example.com',
        recipientName: 'User One',
        eventName: 'Concert A',
        startsAt,
        venue: 'Main Arena',
        seat: 'A-12',
      }),
    );
    expect(prisma.eventReminder.create).toHaveBeenCalledTimes(2);
    expect(prisma.eventReminder.create).toHaveBeenCalledWith({
      data: { eventId: 'event-1', userId: 'user-1' },
    });
    expect(prisma.eventReminder.create).toHaveBeenCalledWith({
      data: { eventId: 'event-1', userId: 'user-2' },
    });
  });

  it('does not record reminder when notification provider delivery fails (#537)', async () => {
    const startsAt = new Date('2026-10-01T19:00:00Z');
    prisma.event.findMany.mockResolvedValue([
      {
        id: 'event-1',
        name: 'Concert A',
        venue: 'Main Arena',
        startsAt,
        tickets: [
          {
            ownerId: 'user-1',
            owner: { id: 'user-1', email: 'fail@example.com', name: 'Fail User' },
          },
        ],
      },
    ]);
    notifications.sendEventReminder.mockRejectedValueOnce(
      new Error('SMTP connection refused'),
    );

    const result = await service.sendUpcomingEventReminders();

    expect(result.remindersSent).toBe(0);
    expect(notifications.sendEventReminder).toHaveBeenCalledTimes(1);
    expect(prisma.eventReminder.create).not.toHaveBeenCalled();
  });

  it('is idempotent and skips duplicate reminder creation (P2002 error)', async () => {
    prisma.event.findMany.mockResolvedValue([
      {
        id: 'event-1',
        name: 'Concert A',
        startsAt: new Date(),
        venue: 'Venue',
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

  it('does not register per-instance scheduling timer on boot (#536)', () => {
    // Service does not implement OnModuleInit and does not schedule a local setInterval timer
    expect((service as unknown as { onModuleInit?: () => void }).onModuleInit).toBeUndefined();
  });
});
