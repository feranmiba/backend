import { ConflictException, NotFoundException } from '@nestjs/common';
import { WaitlistEntryStatus } from '@prisma/client';
import { WaitlistService } from './waitlist.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { OrganizationsService } from '../organizations/organizations.service';

describe('WaitlistService', () => {
  let service: WaitlistService;
  let prisma: {
    ticketType: { findUnique: jest.Mock };
    waitlistEntry: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
  };
  let organizations: { assertMember: jest.Mock };

  beforeEach(() => {
    prisma = {
      ticketType: { findUnique: jest.fn() },
      waitlistEntry: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };
    organizations = { assertMember: jest.fn() };
    service = new WaitlistService(
      prisma as unknown as PrismaService,
      organizations as unknown as OrganizationsService,
    );
  });

  afterEach(() => {
    service.stopCron();
  });

  describe('join', () => {
    it('rejects joining a ticket type that still has capacity', async () => {
      prisma.ticketType.findUnique.mockResolvedValue({
        id: 'tt-1',
        quantityIssued: 5,
        quantityTotal: 10,
      });

      await expect(service.join('user-1', 'tt-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
    });

    it('rejects a user already WAITING on the same ticket type', async () => {
      prisma.ticketType.findUnique.mockResolvedValue({
        id: 'tt-1',
        quantityIssued: 10,
        quantityTotal: 10,
      });
      prisma.waitlistEntry.findUnique.mockResolvedValue({
        id: 'entry-1',
        status: WaitlistEntryStatus.WAITING,
      });

      await expect(service.join('user-1', 'tt-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('assigns fair FIFO position based on earlier WAITING entries', async () => {
      prisma.ticketType.findUnique.mockResolvedValue({
        id: 'tt-1',
        quantityIssued: 10,
        quantityTotal: 10,
      });
      prisma.waitlistEntry.findUnique.mockResolvedValue(null);
      const createdAt = new Date('2026-09-01T12:00:00Z');
      prisma.waitlistEntry.create.mockResolvedValue({
        id: 'entry-1',
        ticketTypeId: 'tt-1',
        userId: 'user-1',
        status: WaitlistEntryStatus.WAITING,
        createdAt,
      });
      prisma.waitlistEntry.count.mockResolvedValue(4);

      const result = await service.join('user-1', 'tt-1');

      expect(prisma.waitlistEntry.count).toHaveBeenCalledWith({
        where: {
          ticketTypeId: 'tt-1',
          status: WaitlistEntryStatus.WAITING,
          createdAt: { lt: createdAt },
        },
      });
      expect(result.position).toBe(5);
    });

    it('re-joins a previously CANCELLED entry instead of erroring', async () => {
      prisma.ticketType.findUnique.mockResolvedValue({
        id: 'tt-1',
        quantityIssued: 10,
        quantityTotal: 10,
      });
      prisma.waitlistEntry.findUnique.mockResolvedValue({
        id: 'entry-1',
        status: WaitlistEntryStatus.CANCELLED,
      });
      const createdAt = new Date('2026-09-01T12:00:00Z');
      prisma.waitlistEntry.update.mockResolvedValue({
        id: 'entry-1',
        ticketTypeId: 'tt-1',
        userId: 'user-1',
        status: WaitlistEntryStatus.WAITING,
        createdAt,
      });
      prisma.waitlistEntry.count.mockResolvedValue(0);

      const result = await service.join('user-1', 'tt-1');

      expect(prisma.waitlistEntry.update).toHaveBeenCalledWith({
        where: { id: 'entry-1' },
        data: {
          status: WaitlistEntryStatus.WAITING,
          offeredAt: null,
          offerExpiresAt: null,
        },
      });
      expect(result.position).toBe(1);
    });
  });

  describe('leave', () => {
    it('throws when the user has no active waitlist entry', async () => {
      prisma.waitlistEntry.findUnique.mockResolvedValue(null);

      await expect(service.leave('user-1', 'tt-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('marks a WAITING entry CANCELLED', async () => {
      prisma.waitlistEntry.findUnique.mockResolvedValue({
        id: 'entry-1',
        status: WaitlistEntryStatus.WAITING,
      });

      await service.leave('user-1', 'tt-1');

      expect(prisma.waitlistEntry.update).toHaveBeenCalledWith({
        where: { id: 'entry-1' },
        data: { status: WaitlistEntryStatus.CANCELLED },
      });
    });
  });

  describe('offerNext', () => {
    it('offers entries strictly in FIFO (createdAt asc) order', async () => {
      prisma.ticketType.findUnique.mockResolvedValue({
        id: 'tt-1',
        event: { organizationId: 'org-1' },
      });
      prisma.waitlistEntry.findMany.mockResolvedValue([
        { id: 'entry-1' },
        { id: 'entry-2' },
      ]);

      await service.offerNext('organizer-1', 'tt-1', 2);

      expect(organizations.assertMember).toHaveBeenCalledWith(
        'org-1',
        'organizer-1',
      );
      expect(prisma.waitlistEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ticketTypeId: 'tt-1', status: WaitlistEntryStatus.WAITING },
          orderBy: { createdAt: 'asc' },
          take: 2,
        }),
      );
      expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['entry-1', 'entry-2'] } },
          data: expect.objectContaining({
            status: WaitlistEntryStatus.OFFERED,
          }) as object,
        }),
      );
    });
  });

  describe('rollForwardExpiredOffers', () => {
    it('returns 0 counts when no offers are expired', async () => {
      prisma.waitlistEntry.findMany.mockResolvedValue([]);

      const result = await service.rollForwardExpiredOffers();

      expect(result).toEqual({ expiredCount: 0, rolledForwardCount: 0 });
      expect(prisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
    });

    it('moves expired OFFERED entries to EXPIRED and rolls forward to next WAITING entries', async () => {
      const expiredOffer1 = {
        id: 'offered-1',
        ticketTypeId: 'tt-1',
        status: WaitlistEntryStatus.OFFERED,
      };
      const expiredOffer2 = {
        id: 'offered-2',
        ticketTypeId: 'tt-1',
        status: WaitlistEntryStatus.OFFERED,
      };

      const waitingEntry1 = {
        id: 'waiting-1',
        ticketTypeId: 'tt-1',
        status: WaitlistEntryStatus.WAITING,
      };
      const waitingEntry2 = {
        id: 'waiting-2',
        ticketTypeId: 'tt-1',
        status: WaitlistEntryStatus.WAITING,
      };

      prisma.waitlistEntry.findMany
        .mockResolvedValueOnce([expiredOffer1, expiredOffer2])
        .mockResolvedValueOnce([waitingEntry1, waitingEntry2]);

      const now = new Date('2026-11-24T00:00:00Z');
      const result = await service.rollForwardExpiredOffers(now);

      expect(result).toEqual({ expiredCount: 2, rolledForwardCount: 2 });
      expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['offered-1', 'offered-2'] } },
        data: { status: WaitlistEntryStatus.EXPIRED },
      });
      expect(prisma.waitlistEntry.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { ticketTypeId: 'tt-1', status: WaitlistEntryStatus.WAITING },
          orderBy: { createdAt: 'asc' },
          take: 2,
        }),
      );
      expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['waiting-1', 'waiting-2'] } },
          data: expect.objectContaining({
            status: WaitlistEntryStatus.OFFERED,
            offeredAt: now,
          }) as object,
        }),
      );
    });

    it('handles multiple ticket types independently', async () => {
      const expiredTt1 = {
        id: 'offered-1',
        ticketTypeId: 'tt-1',
        status: WaitlistEntryStatus.OFFERED,
      };
      const expiredTt2 = {
        id: 'offered-2',
        ticketTypeId: 'tt-2',
        status: WaitlistEntryStatus.OFFERED,
      };

      const waitingTt1 = {
        id: 'waiting-1',
        ticketTypeId: 'tt-1',
        status: WaitlistEntryStatus.WAITING,
      };
      const waitingTt2 = {
        id: 'waiting-2',
        ticketTypeId: 'tt-2',
        status: WaitlistEntryStatus.WAITING,
      };

      prisma.waitlistEntry.findMany
        .mockResolvedValueOnce([expiredTt1, expiredTt2])
        .mockResolvedValueOnce([waitingTt1])
        .mockResolvedValueOnce([waitingTt2]);

      const result = await service.rollForwardExpiredOffers();

      expect(result).toEqual({ expiredCount: 2, rolledForwardCount: 2 });
      expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['offered-1', 'offered-2'] } },
        data: { status: WaitlistEntryStatus.EXPIRED },
      });
    });

    it('handles case where fewer WAITING entries exist than expired offers', async () => {
      const expiredTt1A = {
        id: 'offered-1',
        ticketTypeId: 'tt-1',
        status: WaitlistEntryStatus.OFFERED,
      };
      const expiredTt1B = {
        id: 'offered-2',
        ticketTypeId: 'tt-1',
        status: WaitlistEntryStatus.OFFERED,
      };

      const onlyWaiting = {
        id: 'waiting-1',
        ticketTypeId: 'tt-1',
        status: WaitlistEntryStatus.WAITING,
      };

      prisma.waitlistEntry.findMany
        .mockResolvedValueOnce([expiredTt1A, expiredTt1B])
        .mockResolvedValueOnce([onlyWaiting]);

      const result = await service.rollForwardExpiredOffers();

      expect(result).toEqual({ expiredCount: 2, rolledForwardCount: 1 });
      expect(prisma.waitlistEntry.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['waiting-1'] } },
        data: expect.objectContaining({
          status: WaitlistEntryStatus.OFFERED,
        }) as object,
      });
    });
  });

  describe('scheduled job and cron lifecycle', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('starts cron and runs initial check on module init, then triggers periodically', () => {
      const checkSpy = jest
        .spyOn(service, 'checkExpiredOffers')
        .mockResolvedValue({
          expiredCount: 0,
          rolledForwardCount: 0,
        });

      service.onModuleInit();

      expect(checkSpy).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(60_000);
      expect(checkSpy).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(60_000);
      expect(checkSpy).toHaveBeenCalledTimes(3);

      service.stopCron();
      jest.advanceTimersByTime(60_000);
      expect(checkSpy).toHaveBeenCalledTimes(3);
    });

    it('handles errors during checkExpiredOffers gracefully without throwing', async () => {
      jest
        .spyOn(service, 'rollForwardExpiredOffers')
        .mockRejectedValue(new Error('DB failure'));

      const result = await service.checkExpiredOffers();

      expect(result).toEqual({ expiredCount: 0, rolledForwardCount: 0 });
    });
  });
});
