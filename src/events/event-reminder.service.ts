import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';

const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class EventReminderService {
  private readonly logger = new Logger(EventReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationService,
  ) {}

  /**
   * Method for backward compatibility with existing tests; per-instance
   * scheduling has been moved to SchedulerModule (#536).
   */
  stopCron(): void {}

  /**
   * Idempotent method to send reminders for events starting within the next 24 hours.
   * Uses unique constraint on EventReminder (eventId, userId) and NotificationService
   * to ensure duplicate notifications are never sent and reminders are delivered (#537).
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
            seat: true,
            owner: {
              select: {
                id: true,
                email: true,
                name: true,
              },
            },
            ticketType: {
              select: {
                name: true,
              },
            },
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
        // Skip if a reminder has already been recorded for this event and user
        if (this.prisma.eventReminder?.findUnique) {
          const alreadySent = await this.prisma.eventReminder.findUnique({
            where: {
              eventId_userId: {
                eventId: event.id,
                userId,
              },
            },
          });
          if (alreadySent) {
            continue;
          }
        }

        const userTickets = event.tickets.filter((t) => t.ownerId === userId);
        let recipientEmail = userTickets[0]?.owner?.email;
        let recipientName = userTickets[0]?.owner?.name;

        // If owner details weren't included in tickets selection, fall back to lookup
        if (!recipientEmail && this.prisma.user?.findUnique) {
          const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { email: true, name: true },
          });
          recipientEmail = user?.email;
          recipientName = user?.name;
        }

        // #537 — actually send event reminder notification if provider is available
        if (this.notifications && recipientEmail) {
          const seats = userTickets
            .map((t) => t.seat)
            .filter(
              (s): s is string => typeof s === 'string' && s !== 'unassigned',
            );
          const seatInfo = seats.length > 0 ? seats.join(', ') : undefined;

          try {
            await this.notifications.sendEventReminder({
              to: recipientEmail,
              recipientName,
              eventName: event.name,
              startsAt: event.startsAt,
              venue: event.venue,
              seat: seatInfo,
            });
          } catch (err) {
            this.logger.error(
              `Failed to send event reminder notification to user ${userId} (${recipientEmail}) for event ${event.id}: ${(err as Error).message}`,
              (err as Error).stack,
            );
            // Do not record reminder in database on failure, preserving retryability
            continue;
          }
        }

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
