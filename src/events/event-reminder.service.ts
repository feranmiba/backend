import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Interval for checking upcoming events (every 5 minutes). */
const REMINDER_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class EventReminderService implements OnModuleInit {
  private readonly logger = new Logger(EventReminderService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.startCron();
  }

  startCron() {
    void this.sendUpcomingEventReminders();
    this.timer = setInterval(() => {
      void this.sendUpcomingEventReminders();
    }, REMINDER_CHECK_INTERVAL_MS);
  }

  stopCron() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /**
   * Idempotent method to send reminders for events starting within the next 24 hours.
   * Uses unique constraint on EventReminder (eventId, userId) to ensure duplicate notifications are never sent.
   */
  async sendUpcomingEventReminders(): Promise<{ remindersSent: number }> {
    const now = new Date();
    const targetWindow = new Date(now.getTime() + REMINDER_WINDOW_MS);

    // Find published events starting between now and the 24-hour mark
    const upcomingEvents = await this.prisma.event.findMany({
      where: {
        status: EventStatus.PUBLISHED,
        // #207 — never remind for soft-deleted events.
        deletedAt: null,
        startsAt: {
          gte: now,
          lte: targetWindow,
        },
      },
      include: {
        tickets: {
          // #599 — reminders only go to verified addresses.
          where: { owner: { emailVerifiedAt: { not: null } } },
          select: {
            ownerId: true,
          },
        },
      },
    });

    let remindersSent = 0;

    for (const event of upcomingEvents) {
      // Collect unique ticket holder user IDs
      const ticketHolderIds = Array.from(
        new Set(event.tickets.map((t) => t.ownerId)),
      );

      for (const userId of ticketHolderIds) {
        try {
          await this.prisma.eventReminder.create({
            data: {
              eventId: event.id,
              userId,
            },
          });

          remindersSent++;
          this.logger.log(
            `Sent 24h event reminder to user ${userId} for event ${event.name} (${event.id})`,
          );
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            // Already sent a reminder for this event to this user (idempotent skip)
            continue;
          }
          this.logger.error(
            `Failed to create event reminder for event ${event.id} user ${userId}`,
            err,
          );
        }
      }
    }

    return { remindersSent };
  }
}
