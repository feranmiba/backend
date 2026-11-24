import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { WaitlistEntryStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { NotificationService } from '../notifications/notifications.service';

/** Cadence for checking and rolling forward expired waitlist offers (every 60 seconds). */
export const WAITLIST_EXPIRY_CHECK_INTERVAL_MS = 60_000;

@Injectable()
export class WaitlistService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WaitlistService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
    @Optional() private readonly notifications?: NotificationService,
  ) {}

  onModuleInit() {
    this.startCron();
  }

  onModuleDestroy() {
    this.stopCron();
  }

  startCron() {
    void this.checkExpiredOffers();
    this.timer = setInterval(() => {
      void this.checkExpiredOffers();
    }, WAITLIST_EXPIRY_CHECK_INTERVAL_MS);
  }

  stopCron() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async checkExpiredOffers(): Promise<{
    expiredCount: number;
    rolledForwardCount: number;
  }> {
    try {
      const result = await this.rollForwardExpiredOffers();
      if (result.expiredCount > 0) {
        this.logger.log(
          `Expired ${result.expiredCount} waitlist offer(s) and rolled forward ${result.rolledForwardCount} new offer(s).`,
        );
      }
      return result;
    } catch (err) {
      this.logger.error('Failed to roll forward expired waitlist offers', err);
      return { expiredCount: 0, rolledForwardCount: 0 };
    }
  }

  /**
   * Finds all OFFERED waitlist entries whose offerExpiresAt has passed, marks them
   * EXPIRED, and rolls the offer forward to the next WAITING entry in FIFO order for
   * each ticket type.
   */
  async rollForwardExpiredOffers(
    now: Date = new Date(),
    windowMs = 24 * 60 * 60 * 1000,
  ): Promise<{ expiredCount: number; rolledForwardCount: number }> {
    const expired = await this.prisma.waitlistEntry.findMany({
      where: {
        status: WaitlistEntryStatus.OFFERED,
        offerExpiresAt: { lte: now },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (expired.length === 0) {
      return { expiredCount: 0, rolledForwardCount: 0 };
    }

    const expiredIds = expired.map((e) => e.id);
    await this.prisma.waitlistEntry.updateMany({
      where: { id: { in: expiredIds } },
      data: { status: WaitlistEntryStatus.EXPIRED },
    });

    // Group count of expired offers by ticketTypeId
    const countsByTicketType = new Map<string, number>();
    for (const entry of expired) {
      const current = countsByTicketType.get(entry.ticketTypeId) ?? 0;
      countsByTicketType.set(entry.ticketTypeId, current + 1);
    }

    let rolledForwardCount = 0;
    const nextOfferExpiresAt = new Date(now.getTime() + windowMs);

    for (const [ticketTypeId, count] of countsByTicketType.entries()) {
      const nextWaiting = await this.prisma.waitlistEntry.findMany({
        where: {
          ticketTypeId,
          status: WaitlistEntryStatus.WAITING,
        },
        orderBy: { createdAt: 'asc' },
        take: count,
      });

      if (nextWaiting.length > 0) {
        await this.prisma.waitlistEntry.updateMany({
          where: { id: { in: nextWaiting.map((e) => e.id) } },
          data: {
            status: WaitlistEntryStatus.OFFERED,
            offeredAt: now,
            offerExpiresAt: nextOfferExpiresAt,
          },
        });
        rolledForwardCount += nextWaiting.length;
      }
    }

    return {
      expiredCount: expired.length,
      rolledForwardCount,
    };
  }

  /**
   * Joins the waitlist for a sold-out ticket type. Ordering is fair: a row's
   * place in line is its rank by `createdAt` among still-WAITING entries, so
   * there is no separate counter to drift out of sync with insertion order.
   */
  async join(userId: string, ticketTypeId: string) {
    const ticketType = await this.prisma.ticketType.findUnique({
      where: { id: ticketTypeId },
    });
    if (!ticketType) {
      throw new NotFoundException('Ticket type not found');
    }
    if (ticketType.quantityIssued < ticketType.quantityTotal) {
      throw new ConflictException(
        'This ticket type still has capacity; join the waitlist once it sells out',
      );
    }

    const existing = await this.prisma.waitlistEntry.findUnique({
      where: { ticketTypeId_userId: { ticketTypeId, userId } },
    });
    if (existing && existing.status === WaitlistEntryStatus.WAITING) {
      throw new ConflictException('You are already on this waitlist');
    }

    const entry = existing
      ? await this.prisma.waitlistEntry.update({
          where: { id: existing.id },
          data: {
            status: WaitlistEntryStatus.WAITING,
            offeredAt: null,
            offerExpiresAt: null,
          },
        })
      : await this.prisma.waitlistEntry.create({
          data: { ticketTypeId, userId },
        });

    return { entry, position: await this.positionOf(entry) };
  }

  async leave(userId: string, ticketTypeId: string) {
    const entry = await this.prisma.waitlistEntry.findUnique({
      where: { ticketTypeId_userId: { ticketTypeId, userId } },
    });
    if (!entry || entry.status !== WaitlistEntryStatus.WAITING) {
      throw new NotFoundException('You are not waiting on this ticket type');
    }
    return this.prisma.waitlistEntry.update({
      where: { id: entry.id },
      data: { status: WaitlistEntryStatus.CANCELLED },
    });
  }

  async myEntry(userId: string, ticketTypeId: string) {
    const entry = await this.prisma.waitlistEntry.findUnique({
      where: { ticketTypeId_userId: { ticketTypeId, userId } },
    });
    if (!entry || entry.status !== WaitlistEntryStatus.WAITING) {
      throw new NotFoundException('You are not waiting on this ticket type');
    }
    return { entry, position: await this.positionOf(entry) };
  }

  /** Organizer-only: the full, ordered queue for a ticket type. */
  async listForOrganizer(userId: string, ticketTypeId: string) {
    const ticketType = await this.prisma.ticketType.findUnique({
      where: { id: ticketTypeId },
      include: { event: true },
    });
    if (!ticketType) {
      throw new NotFoundException('Ticket type not found');
    }
    await this.organizations.assertMember(
      ticketType.event.organizationId,
      userId,
    );

    return this.prisma.waitlistEntry.findMany({
      where: { ticketTypeId, status: WaitlistEntryStatus.WAITING },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  }

  /**
   * Offers the next `count` WAITING entries a purchase window. Called by
   * organizers (or a future capacity-freed hook) once inventory reopens --
   * e.g. a cancellation. Entries are offered strictly in FIFO order.
   */
  async offerNext(
    userId: string,
    ticketTypeId: string,
    count: number,
    windowMs = 24 * 60 * 60 * 1000,
  ) {
    const ticketType = await this.prisma.ticketType.findUnique({
      where: { id: ticketTypeId },
      include: { event: true },
    });
    if (!ticketType) {
      throw new NotFoundException('Ticket type not found');
    }
    await this.organizations.assertMember(
      ticketType.event.organizationId,
      userId,
    );

    const next = await this.prisma.waitlistEntry.findMany({
      where: { ticketTypeId, status: WaitlistEntryStatus.WAITING },
      orderBy: { createdAt: 'asc' },
      take: count,
      include: { user: true },
    });

    const now = new Date();
    const offerExpiresAt = new Date(now.getTime() + windowMs);
    await this.prisma.waitlistEntry.updateMany({
      where: { id: { in: next.map((e) => e.id) } },
      data: {
        status: WaitlistEntryStatus.OFFERED,
        offeredAt: now,
        offerExpiresAt,
      },
    });

    // #561 — Send email notifications to waitlist users who received offers
    if (this.notifications) {
      for (const entry of next) {
        this.notifications
          .sendWaitlistOffer({
            to: entry.user.email,
            userName: entry.user.name,
            eventName: ticketType.event.name,
            ticketType: ticketType.name,
            expiresAt: offerExpiresAt,
          })
          .catch((err) => {
            // Fire and forget: log failures but don't block the offer
            console.error(
              `Failed to send waitlist offer email to ${entry.user.email}: ${err.message}`,
            );
          });
      }
    }

    return next.map((e) => ({
      ...e,
      status: WaitlistEntryStatus.OFFERED,
      user: undefined,
    }));
  }

  /** Marks an OFFERED entry CONVERTED once the offered user actually buys. */
  async markConverted(ticketTypeId: string, userId: string) {
    await this.prisma.waitlistEntry.updateMany({
      where: {
        ticketTypeId,
        userId,
        status: WaitlistEntryStatus.OFFERED,
      },
      data: { status: WaitlistEntryStatus.CONVERTED },
    });
  }

  /** Position among still-WAITING entries, 1-indexed. */
  private async positionOf(entry: { ticketTypeId: string; createdAt: Date }) {
    const aheadCount = await this.prisma.waitlistEntry.count({
      where: {
        ticketTypeId: entry.ticketTypeId,
        status: WaitlistEntryStatus.WAITING,
        createdAt: { lt: entry.createdAt },
      },
    });
    return aheadCount + 1;
  }
}
