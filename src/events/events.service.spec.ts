import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

// See tickets.service.spec.ts for why StellarService is mocked at the
// module level rather than imported for real.
jest.mock('../stellar/stellar.service', () => ({ StellarService: jest.fn() }));

import { EventsService } from './events.service';
import type { CreateTicketTypeDto } from './dto/create-ticket-type.dto';
import type { PrismaService } from '../prisma/prisma.service';
import type { ConfigService } from '@nestjs/config';
import type { OrganizationsService } from '../organizations/organizations.service';
import type { StellarService } from '../stellar/stellar.service';
import { createEvent, createOrganization } from '../../test/factories';

describe('EventsService', () => {
  let service: EventsService;
  let prisma: {
    $transaction: jest.Mock;
    event: {
      create: jest.Mock;
      update: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
    };
    ticket: { count: jest.Mock };
    ticketType: {
      count: jest.Mock;
      createMany: jest.Mock;
      create: jest.Mock;
      findFirst: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
  };
  let organizations: {
    assertMember: jest.Mock;
    findOne: jest.Mock;
    isMember: jest.Mock;
  };
  let stellar: {
    buildTxTimeoutSeconds: number;
    buildCreateEventTx: jest.Mock;
    submitSignedTransaction: jest.Mock;
    getEvent: jest.Mock;
  };
  let cache: { delete: jest.Mock };

  beforeEach(() => {
    prisma = {
      // events.service.ts uses both the array form (`findPublished`) and the
      // interactive-callback form (`create`) of `$transaction`.
      $transaction: jest.fn((arg: unknown) =>
        Array.isArray(arg)
          ? Promise.all(arg)
          : (arg as (tx: unknown) => unknown)(prisma),
      ),
      event: {
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn(),
      },
      ticket: { count: jest.fn() },
      ticketType: {
        count: jest.fn().mockResolvedValue(1),
        createMany: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
    };
    organizations = {
      assertMember: jest.fn().mockResolvedValue(undefined),
      isMember: jest.fn().mockResolvedValue(false),
      findOne: jest.fn().mockResolvedValue({
        id: 'org-1',
        defaultMaxResaleMultiplierBps: 11_000,
        defaultRoyaltyBps: 500,
      }),
    };
    stellar = {
      buildTxTimeoutSeconds: 300,
      buildCreateEventTx: jest.fn().mockResolvedValue('unsigned-xdr'),
      submitSignedTransaction: jest
        .fn()
        .mockResolvedValue({ result: null, txHash: '0xabc' }),
      getEvent: jest.fn().mockResolvedValue({
        eventId: 99n,
        organizer: 'GORG',
        name: 'Radiohead Live',
        category: 'CONCERTS',
        maxResaleMultiplierBps: 11_000,
        royaltyBps: 500,
        ticketsIssued: 0n,
      }),
    };
    cache = { delete: jest.fn().mockResolvedValue(undefined) };

    service = new EventsService(
      prisma as unknown as PrismaService,
      organizations as unknown as OrganizationsService,
      stellar as unknown as StellarService,
      {
        get: jest.fn((key: string, fallback: unknown) =>
          key === 'SETTLEMENT_ASSET_CODE'
            ? 'XLM'
            : key === 'SETTLEMENT_ASSET_DECIMALS'
              ? 7
              : fallback,
        ),
      } as unknown as ConfigService,
      undefined,
      cache,
    );
  });

  describe('create', () => {
    it('falls back to the organization defaults when the DTO omits resale terms', async () => {
      prisma.event.create.mockResolvedValue({ id: 'event-1' });
      prisma.event.findUniqueOrThrow.mockResolvedValue({
        id: 'event-1',
        ticketTypes: [],
      });

      await service.create('organizer-1', 'org-1', {
        name: 'Radiohead Live',
        description: 'A live performance.',
        imageUrl: 'https://example.com/radiohead.jpg',
        category: 'CONCERTS',
        venue: 'O2 Arena',
        timezone: 'Europe/London',
        startsAt: new Date(),
      } as never);

      expect(prisma.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            id: expect.any(String),
            slug: expect.stringMatching(
              /^radiohead-live-\d{4}-\d{2}-\d{2}-[0-9a-f-]{36}$/,
            ),
            description: 'A live performance.',
            imageUrl: 'https://example.com/radiohead.jpg',
            timezone: 'Europe/London',
            maxResaleMultiplierBps: 11_000,
            royaltyBps: 500,
          }) as never,
        }),
      );
      expect(prisma.ticketType.createMany).not.toHaveBeenCalled();
    });

    it('prefers resale terms given on the DTO over the organization defaults', async () => {
      organizations.findOne.mockResolvedValue({
        id: 'org-1',
        defaultMaxResaleMultiplierBps: 15_000,
        defaultRoyaltyBps: 1_000,
      });
      prisma.event.create.mockResolvedValue({ id: 'event-1' });
      prisma.event.findUniqueOrThrow.mockResolvedValue({
        id: 'event-1',
        ticketTypes: [],
      });

      await service.create('organizer-1', 'org-1', {
        name: 'Radiohead Live',
        category: 'CONCERTS',
        venue: 'O2 Arena',
        startsAt: new Date(),
        maxResaleMultiplierBps: 12_000,
        royaltyBps: 500,
      } as never);

      expect(prisma.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            maxResaleMultiplierBps: 12_000,
            royaltyBps: 500,
          }) as never,
        }),
      );
    });

    it('creates the first ticket type in the same transaction as the event', async () => {
      prisma.event.create.mockResolvedValue({ id: 'event-1' });
      prisma.event.findUniqueOrThrow.mockResolvedValue({
        id: 'event-1',
        ticketTypes: [{ id: 'tt-1', name: 'General', price: 1_000n }],
      });

      await service.create('organizer-1', 'org-1', {
        name: 'Radiohead Live',
        category: 'CONCERTS',
        venue: 'O2 Arena',
        startsAt: new Date(),
        ticketTypes: [{ name: 'General', price: '1000', quantityTotal: 100 }],
      } as never);

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.ticketType.createMany).toHaveBeenCalledWith({
        data: [
          {
            eventId: 'event-1',
            name: 'General',
            price: 1000n,
            quantityTotal: 100,
          },
        ],
      });
    });

    it('rolls back the event when the ticket type fails to create', async () => {
      prisma.event.create.mockResolvedValue({ id: 'event-1' });
      prisma.ticketType.createMany.mockRejectedValue(
        new Error('duplicate ticket type name'),
      );

      await expect(
        service.create('organizer-1', 'org-1', {
          name: 'Radiohead Live',
          category: 'CONCERTS',
          venue: 'O2 Arena',
          startsAt: new Date(),
          ticketTypes: [{ name: 'General', price: '1000', quantityTotal: 100 }],
        } as never),
      ).rejects.toThrow('duplicate ticket type name');
    });
  });

  describe('addTicketType (#371)', () => {
    const dto: CreateTicketTypeDto = {
      name: 'General',
      price: '1000',
      quantityTotal: 100,
    };

    it('creates a ticket type while the event is still a draft', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({
          id: 'event-1',
          organizationId: 'org-1',
          status: 'DRAFT',
        }),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });
      prisma.ticketType.create.mockResolvedValue({
        id: 'tt-1',
        price: 1_000n,
      });

      await service.addTicketType('organizer-1', 'event-1', dto);

      expect(prisma.ticketType.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventId: 'event-1',
          name: 'General',
          price: 1_000n,
        }) as never,
      });
    });

    it('rejects a published event and writes nothing', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({
          id: 'event-1',
          organizationId: 'org-1',
          status: 'PUBLISHED',
        }),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });

      await expect(
        service.addTicketType('organizer-1', 'event-1', dto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.ticketType.create).not.toHaveBeenCalled();
    });

    it('rejects a cancelled event and writes nothing', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({
          id: 'event-1',
          organizationId: 'org-1',
          status: 'CANCELLED',
        }),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });

      await expect(
        service.addTicketType('organizer-1', 'event-1', dto),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.ticketType.create).not.toHaveBeenCalled();
    });

    it('requires membership before checking the event status', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({
          id: 'event-1',
          organizationId: 'org-1',
          status: 'PUBLISHED',
        }),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });
      organizations.assertMember.mockRejectedValue(new Error('not a member'));

      await expect(
        service.addTicketType('outsider-1', 'event-1', dto),
      ).rejects.toThrow('not a member');
      expect(prisma.ticketType.create).not.toHaveBeenCalled();
    });
  });

  describe('updateTicketType (#101)', () => {
    beforeEach(() => {
      prisma.ticketType.findFirst.mockResolvedValue({
        id: 'tt-1',
        eventId: 'event-1',
        quantityIssued: 10,
        event: { organizationId: 'org-1' },
      });
      prisma.ticketType.findUniqueOrThrow.mockResolvedValue({
        id: 'tt-1',
        price: 1_000n,
        quantityIssued: 10,
        quantityTotal: 10,
      });
    });

    it('allows quantityTotal to equal quantityIssued', async () => {
      prisma.ticketType.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.updateTicketType(
        'organizer-1',
        'event-1',
        'tt-1',
        { quantityTotal: 10 },
      );

      expect(prisma.ticketType.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'tt-1',
          eventId: 'event-1',
          quantityIssued: { lte: 10 },
        },
        data: { quantityTotal: 10 },
      });
      expect(result.quantityTotal).toBe(10);
    });

    it('returns 409 when quantityTotal would be below quantityIssued', async () => {
      prisma.ticketType.updateMany.mockResolvedValue({ count: 0 });

      const attempt = service.updateTicketType(
        'organizer-1',
        'event-1',
        'tt-1',
        { quantityTotal: 9 },
      );

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toMatchObject({
        message: 'quantityTotal cannot be lower than quantityIssued',
        status: 409,
      });
      expect(prisma.ticketType.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('returns not-found when the ticket type is outside the event', async () => {
      prisma.ticketType.findFirst.mockResolvedValue(null);

      await expect(
        service.updateTicketType('organizer-1', 'event-1', 'tt-other', {
          quantityTotal: 10,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(organizations.assertMember).not.toHaveBeenCalled();
      expect(prisma.ticketType.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('buildPublishTx', () => {
    it('refuses to publish an already-published event', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({
          id: 'event-1',
          organizationId: 'org-1',
          status: 'PUBLISHED',
          chainEventId: null,
        }),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });

      await expect(
        service.buildPublishTx('organizer-1', 'event-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stellar.buildCreateEventTx).not.toHaveBeenCalled();
    });

    it('refuses to re-publish while an earlier reservation could still land', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({
          id: 'event-1',
          organizationId: 'org-1',
          status: 'DRAFT',
          chainEventId: 99n,
          chainEventIdReservedAt: new Date(),
        }),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });

      await expect(
        service.buildPublishTx('organizer-1', 'event-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stellar.buildCreateEventTx).not.toHaveBeenCalled();
    });

    it('refuses to re-publish an event whose create_event was already confirmed', async () => {
      // An unpublished event is DRAFT again but still registered on-chain.
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({
          id: 'event-1',
          organizationId: 'org-1',
          status: 'DRAFT',
          chainEventId: 99n,
          publishedTxHash: '0xabc',
        }),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });

      await expect(
        service.buildPublishTx('organizer-1', 'event-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stellar.buildCreateEventTx).not.toHaveBeenCalled();
    });

    describe('abandoned signing (#381)', () => {
      beforeEach(() => {
        jest.useFakeTimers({ now: new Date('2026-10-18T12:00:00.000Z') });
      });
      afterEach(() => {
        jest.useRealTimers();
      });

      it('lets a second attempt reuse the reservation once its envelope expired', async () => {
        const draft = {
          ...createEvent({
            id: 'event-1',
            organizationId: 'org-1',
            status: 'DRAFT',
          }),
          organization: createOrganization({ stellarAccount: 'GORG' }),
        };
        prisma.event.findUnique.mockResolvedValue(draft);
        prisma.event.update.mockResolvedValue({});

        // First attempt reserves an id; the organizer never signs.
        await service.buildPublishTx('organizer-1', 'event-1');
        const [[{ data: reservation }]] = prisma.event.update.mock.calls as [
          [{ data: { chainEventId: bigint; chainEventIdReservedAt: Date } }],
        ];
        const reservedId = reservation.chainEventId;
        prisma.event.findUnique.mockResolvedValue({ ...draft, ...reservation });

        // Within the envelope's time bound the reservation still blocks.
        jest.advanceTimersByTime(299_000);
        await expect(
          service.buildPublishTx('organizer-1', 'event-1'),
        ).rejects.toBeInstanceOf(BadRequestException);

        // Past it, the second attempt succeeds with the same id.
        jest.advanceTimersByTime(2_000);
        const { unsignedXdr } = await service.buildPublishTx(
          'organizer-1',
          'event-1',
        );

        expect(unsignedXdr).toBe('unsigned-xdr');
        expect(stellar.buildCreateEventTx).toHaveBeenCalledTimes(2);
        expect(stellar.buildCreateEventTx).toHaveBeenLastCalledWith(
          expect.objectContaining({ chainEventId: reservedId }),
        );
        expect(prisma.event.update).toHaveBeenLastCalledWith({
          where: { id: 'event-1' },
          data: { chainEventIdReservedAt: new Date() },
        });
      });
    });

    it('returns conflict when the event has no ticket types to sell', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({
          id: 'event-1',
          organizationId: 'org-1',
          status: 'DRAFT',
          chainEventId: null,
        }),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });
      prisma.ticketType.count.mockResolvedValue(0);

      const attempt = service.buildPublishTx('organizer-1', 'event-1');

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toMatchObject({ status: 409 });
      expect(prisma.ticketType.count).toHaveBeenCalledWith({
        where: { eventId: 'event-1' },
      });
      expect(prisma.event.update).not.toHaveBeenCalled();
      expect(stellar.buildCreateEventTx).not.toHaveBeenCalled();
    });

    it('reserves a chain event id and builds create_event against the org account', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({
          id: 'event-1',
          organizationId: 'org-1',
          status: 'DRAFT',
          chainEventId: null,
          name: 'Radiohead Live',
          category: 'CONCERTS',
          maxResaleMultiplierBps: 12_000,
          royaltyBps: 500,
        }),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });
      prisma.event.update.mockResolvedValue({});

      const { unsignedXdr } = await service.buildPublishTx(
        'organizer-1',
        'event-1',
      );

      expect(unsignedXdr).toBe('unsigned-xdr');
      expect(organizations.assertMember).toHaveBeenCalledWith(
        'org-1',
        'organizer-1',
      );
      expect(stellar.buildCreateEventTx).toHaveBeenCalledWith(
        expect.objectContaining({
          organizerPublicKey: 'GORG',
          name: 'Radiohead Live',
          category: 'CONCERTS',
          maxResaleMultiplierBps: 12_000,
          royaltyBps: 500,
        }),
      );
    });
  });

  describe('confirmPublish', () => {
    it('requires publish to have been called first', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({
          id: 'event-1',
          organizationId: 'org-1',
          chainEventId: null,
        }),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });

      await expect(
        service.confirmPublish('organizer-1', 'event-1', 'signed-xdr'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns conflict for an already-published event without touching the network (#382)', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({
          id: 'event-1',
          organizationId: 'org-1',
          status: 'PUBLISHED',
          chainEventId: 99n,
          publishedTxHash: '0xabc',
        }),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });

      const attempt = service.confirmPublish(
        'organizer-1',
        'event-1',
        'signed-xdr',
      );

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toMatchObject({ status: 409 });
      expect(stellar.submitSignedTransaction).not.toHaveBeenCalled();
      expect(stellar.getEvent).not.toHaveBeenCalled();
      expect(prisma.event.update).not.toHaveBeenCalled();
    });

    it('rejects a confirmed transaction whose on-chain event does not match', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({
          id: 'event-1',
          organizationId: 'org-1',
          chainEventId: 99n,
        }),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });
      stellar.getEvent.mockResolvedValue({
        eventId: 100n,
        organizer: 'GOTHER',
      });

      await expect(
        service.confirmPublish('organizer-1', 'event-1', 'signed-xdr'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.event.update).not.toHaveBeenCalled();
    });

    it('submits the signed transaction, confirms it on-chain, and marks the event published', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({
          id: 'event-1',
          organizationId: 'org-1',
          chainEventId: 99n,
        }),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });
      prisma.event.update.mockResolvedValue(
        createEvent({
          id: 'event-1',
          status: 'PUBLISHED',
          publishedTxHash: '0xabc',
        }),
      );

      const event = await service.confirmPublish(
        'organizer-1',
        'event-1',
        'signed-xdr',
      );

      expect(stellar.submitSignedTransaction).toHaveBeenCalledWith(
        'signed-xdr',
      );
      expect(stellar.getEvent).toHaveBeenCalledWith(99n);
      expect(prisma.event.update).toHaveBeenCalledWith({
        where: { id: 'event-1' },
        data: { status: 'PUBLISHED', publishedTxHash: '0xabc' },
      });
      expect(event.status).toBe('PUBLISHED');
      // #430 — the publish transaction hash is returned on the event.
      expect(event.publishedTxHash).toBe('0xabc');
    });

    it('fails the request when the on-chain event cannot be confirmed after submission', async () => {
      prisma.event.findUnique.mockResolvedValue({
        id: 'event-1',
        organizationId: 'org-1',
        status: 'DRAFT',
        chainEventId: 99n,
        organization: { stellarAccount: 'GORG' },
      });
      stellar.getEvent.mockRejectedValue(new Error('not found'));

      await expect(
        service.confirmPublish('organizer-1', 'event-1', 'signed-xdr'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.event.update).not.toHaveBeenCalled();
    });
  });

  describe('getWithReconciliation', () => {
    it('skips the chain lookup when reconciliation is not requested', async () => {
      prisma.event.findUnique.mockResolvedValue({
        id: 'event-1',
        status: 'PUBLISHED',
        chainEventId: 99n,
        organization: { stellarAccount: 'GORG' },
      });

      const event = await service.getWithReconciliation('event-1', false);

      expect(stellar.getEvent).not.toHaveBeenCalled();
      expect(event).not.toHaveProperty('onChainStatus');
    });

    it('reports PUBLISHED when the chain agrees with the cached status', async () => {
      prisma.event.findUnique.mockResolvedValue({
        id: 'event-1',
        status: 'PUBLISHED',
        chainEventId: 99n,
        organization: { stellarAccount: 'GORG' },
      });

      const event = await service.getWithReconciliation('event-1', true);

      expect(stellar.getEvent).toHaveBeenCalledWith(99n);
      expect(event.onChainStatus).toBe('PUBLISHED');
    });

    it('reports NOT_FOUND when the DB says published but the chain lookup fails', async () => {
      prisma.event.findUnique.mockResolvedValue({
        id: 'event-1',
        status: 'PUBLISHED',
        chainEventId: 99n,
        organization: { stellarAccount: 'GORG' },
      });
      stellar.getEvent.mockRejectedValue(new Error('not found'));

      const event = await service.getWithReconciliation('event-1', true);

      expect(event.onChainStatus).toBe('NOT_FOUND');
    });

    it('reports NOT_PUBLISHED without a chain lookup when no chain id was reserved', async () => {
      prisma.event.findUnique.mockResolvedValue({
        id: 'event-1',
        organizationId: 'org-1',
        status: 'DRAFT',
        chainEventId: null,
        organization: { stellarAccount: 'GORG' },
      });
      organizations.isMember.mockResolvedValue(true);

      const event = await service.getWithReconciliation(
        'event-1',
        true,
        'organizer-1',
      );

      expect(stellar.getEvent).not.toHaveBeenCalled();
      expect(event.onChainStatus).toBe('NOT_PUBLISHED');
    });

    describe('draft visibility (#372)', () => {
      const draft = {
        id: 'event-1',
        organizationId: 'org-1',
        status: 'DRAFT',
        chainEventId: null,
        organization: { stellarAccount: 'GORG' },
      };

      it('hides a draft from anonymous callers with a 404', async () => {
        prisma.event.findUnique.mockResolvedValue(draft);

        await expect(
          service.getWithReconciliation('event-1', false),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(organizations.isMember).not.toHaveBeenCalled();
      });

      it('hides a draft from authenticated non-members with a 404', async () => {
        prisma.event.findUnique.mockResolvedValue(draft);
        organizations.isMember.mockResolvedValue(false);

        await expect(
          service.getWithReconciliation('event-1', false, 'outsider-1'),
        ).rejects.toMatchObject({ status: 404 });
        expect(organizations.isMember).toHaveBeenCalledWith(
          'org-1',
          'outsider-1',
        );
      });

      it('shows a draft to a member of the owning organization', async () => {
        prisma.event.findUnique.mockResolvedValue(draft);
        organizations.isMember.mockResolvedValue(true);

        const event = await service.getWithReconciliation(
          'event-1',
          false,
          'organizer-1',
        );

        expect(event).toMatchObject(draft);
      });

      it('shows a published event to anonymous callers without a membership lookup', async () => {
        prisma.event.findUnique.mockResolvedValue({
          ...draft,
          status: 'PUBLISHED',
        });

        const event = await service.getWithReconciliation('event-1', false);

        expect(event.status).toBe('PUBLISHED');
        expect(organizations.isMember).not.toHaveBeenCalled();
      });
    });
  });

  describe('getBySlug', () => {
    it('returns a published event looked up by its slug', async () => {
      prisma.event.findUnique.mockResolvedValue({
        id: 'event-1',
        slug: 'radiohead-live-2026-12-01',
        status: 'PUBLISHED',
        chainEventId: null,
        organization: { stellarAccount: 'GORG' },
      });

      await expect(
        service.getBySlug('radiohead-live-2026-12-01'),
      ).resolves.toMatchObject({
        id: 'event-1',
        slug: 'radiohead-live-2026-12-01',
      });
      expect(prisma.event.findUnique).toHaveBeenCalledWith({
        where: { slug: 'radiohead-live-2026-12-01' },
        include: { organization: true },
      });
    });

    it('hides drafts from anonymous callers', async () => {
      prisma.event.findUnique.mockResolvedValue({
        id: 'event-1',
        status: 'DRAFT',
        organizationId: 'org-1',
        organization: { stellarAccount: 'GORG' },
      });

      await expect(
        service.getBySlug('radiohead-live'),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('findPublished', () => {
    const publishedWhere = {
      status: 'PUBLISHED',
      deletedAt: null,
      organization: { deletedAt: null },
    };

    it('returns one page of published events and the total count', async () => {
      prisma.event.findMany.mockResolvedValue([
        {
          id: 'event-21',
          ticketTypes: [{ name: 'General', price: 1_234_500n }],
        },
      ]);
      prisma.event.count.mockResolvedValue(21);

      const result = await service.findPublished({ page: 2, limit: 20 });

      expect(result).toEqual([
        [
          {
            id: 'event-21',
            ticketTypes: [
              {
                name: 'General',
                price: 1_234_500n,
                priceDisplay: '0.1234500 XLM',
              },
            ],
            settlementAsset: { code: 'XLM', decimals: 7 },
          },
        ],
        21,
      ]);
      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: publishedWhere,
          orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
          skip: 20,
          take: 20,
        }),
      );
      expect(prisma.event.count).toHaveBeenCalledWith({
        where: publishedWhere,
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('still hides hidden ticket types', async () => {
      prisma.event.findMany.mockResolvedValue([]);
      prisma.event.count.mockResolvedValue(0);

      await service.findPublished({ page: 1, limit: 20 });

      const [args] = prisma.event.findMany.mock.calls[0] as [
        { include: { ticketTypes: unknown } },
      ];
      expect(args.include.ticketTypes).toEqual({ where: { isHidden: false } });
    });

    it('formats prices using the configured settlement asset decimals', async () => {
      const customAssetService = new EventsService(
        prisma as unknown as PrismaService,
        organizations as unknown as OrganizationsService,
        stellar as unknown as StellarService,
        {
          get: jest.fn((key: string, fallback: unknown) =>
            key === 'SETTLEMENT_ASSET_CODE'
              ? 'USDC'
              : key === 'SETTLEMENT_ASSET_DECIMALS'
                ? 6
                : fallback,
          ),
        } as unknown as ConfigService,
        undefined,
        cache,
      );
      prisma.event.findMany.mockResolvedValue([
        {
          id: 'event-usdc',
          ticketTypes: [{ name: 'General', price: 1_234_500n }],
        },
      ]);
      prisma.event.count.mockResolvedValue(1);

      const [events] = await customAssetService.findPublished({
        page: 1,
        limit: 20,
      });

      expect(events[0]).toMatchObject({
        settlementAsset: { code: 'USDC', decimals: 6 },
        ticketTypes: [{ priceDisplay: '1.234500 USDC' }],
      });
    });

    describe('filters', () => {
      const from = new Date('2026-11-01T00:00:00.000Z');
      const to = new Date('2026-11-30T23:59:59.000Z');
      const textMatch = (q: string) => ({
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { venue: { contains: q, mode: 'insensitive' } },
        ],
      });

      beforeEach(() => {
        prisma.event.findMany.mockResolvedValue([]);
        prisma.event.count.mockResolvedValue(0);
      });

      const expectWhere = (where: object) => {
        expect(prisma.event.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where }),
        );
        expect(prisma.event.count).toHaveBeenCalledWith({ where });
      };

      it('matches q against name or venue, case-insensitively', async () => {
        await service.findPublished({ page: 1, limit: 20, q: 'jazz' });
        expectWhere({ ...publishedWhere, ...textMatch('jazz') });
      });

      it('filters by category', async () => {
        await service.findPublished({
          page: 1,
          limit: 20,
          category: 'CONCERTS',
        });
        expectWhere({ ...publishedWhere, category: 'CONCERTS' });
      });

      it('filters by a lower bound on startsAt', async () => {
        await service.findPublished({ page: 1, limit: 20, from });
        expectWhere({ ...publishedWhere, startsAt: { gte: from } });
      });

      it('filters by an upper bound on startsAt', async () => {
        await service.findPublished({ page: 1, limit: 20, to });
        expectWhere({ ...publishedWhere, startsAt: { lte: to } });
      });

      it('combines every filter with AND', async () => {
        await service.findPublished({
          page: 1,
          limit: 20,
          q: 'jazz',
          category: 'CONCERTS',
          from,
          to,
        });
        expectWhere({
          ...publishedWhere,
          category: 'CONCERTS',
          startsAt: { gte: from, lte: to },
          ...textMatch('jazz'),
        });
      });
    });
  });

  describe('unpublish', () => {
    it('reverts a published event to draft when no tickets exist', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({
          id: 'event-1',
          organizationId: 'org-1',
          status: 'PUBLISHED',
        }),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });
      prisma.ticket.count.mockResolvedValue(0);
      prisma.event.update.mockResolvedValue(
        createEvent({ id: 'event-1', status: 'DRAFT' }),
      );

      const event = await service.unpublish('organizer-1', 'event-1');

      expect(prisma.ticket.count).toHaveBeenCalledWith({
        where: { eventId: 'event-1' },
      });
      expect(prisma.event.update).toHaveBeenCalledWith({
        where: { id: 'event-1' },
        data: { status: 'DRAFT' },
      });
      expect(event.status).toBe('DRAFT');
    });

    it('returns conflict when tickets have already been issued', async () => {
      prisma.event.findUnique.mockResolvedValue({
        id: 'event-1',
        organizationId: 'org-1',
        status: 'PUBLISHED',
        organization: { stellarAccount: 'GORG' },
      });
      prisma.ticket.count.mockResolvedValue(1);

      await expect(
        service.unpublish('organizer-1', 'event-1'),
      ).rejects.toMatchObject({ status: 409 });
      expect(prisma.event.update).not.toHaveBeenCalled();
    });
  });

  describe('summarizeForOrganization', () => {
    it('requires membership before counting events', async () => {
      organizations.assertMember.mockRejectedValue(new Error('not a member'));

      await expect(
        service.summarizeForOrganization('outsider-1', 'org-1'),
      ).rejects.toThrow('not a member');
      expect(prisma.event.groupBy).not.toHaveBeenCalled();
    });

    it('returns a count for every status, zero where there are no events', async () => {
      prisma.event.groupBy.mockResolvedValue([
        { status: 'DRAFT', _count: { _all: 3 } },
        { status: 'PUBLISHED', _count: { _all: 1 } },
      ]);

      const summary = await service.summarizeForOrganization(
        'organizer-1',
        'org-1',
      );

      expect(summary).toEqual({
        total: 4,
        byStatus: { DRAFT: 3, PUBLISHED: 1, CANCELLED: 0 },
      });
    });

    it('excludes soft-deleted events from the counts', async () => {
      prisma.event.groupBy.mockResolvedValue([]);

      await service.summarizeForOrganization('organizer-1', 'org-1');

      expect(prisma.event.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: { organizationId: 'org-1', deletedAt: null },
        _count: { _all: true },
      });
    });
  });

  describe('findForOrganization', () => {
    it('requires membership before listing an organization’s events', async () => {
      organizations.assertMember.mockRejectedValue(new Error('not a member'));

      await expect(
        service.findForOrganization('outsider-1', 'org-1'),
      ).rejects.toThrow('not a member');
      expect(prisma.event.findMany).not.toHaveBeenCalled();
    });

    it('returns the organization’s events, drafts included, as a page', async () => {
      prisma.event.findMany.mockResolvedValue([
        { id: 'event-1', status: 'DRAFT' },
      ]);
      prisma.event.count.mockResolvedValue(1);

      const page = await service.findForOrganization('organizer-1', 'org-1');

      expect(organizations.assertMember).toHaveBeenCalledWith(
        'org-1',
        'organizer-1',
      );
      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org-1', deletedAt: null },
          skip: 0,
          take: 20,
        }),
      );
      expect(page).toEqual({
        items: [
          {
            id: 'event-1',
            status: 'DRAFT',
            settlementAsset: { code: 'XLM', decimals: 7 },
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
      });
    });

    it('narrows the listing to a single status when one is given', async () => {
      prisma.event.findMany.mockResolvedValue([]);

      await service.findForOrganization('organizer-1', 'org-1', {
        status: 'PUBLISHED',
      });

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: 'org-1',
            deletedAt: null,
            status: 'PUBLISHED',
          },
        }),
      );
    });

    it('skips the preceding pages and caps the page at the requested limit', async () => {
      prisma.event.findMany.mockResolvedValue([]);

      const page = await service.findForOrganization('organizer-1', 'org-1', {
        page: 3,
        limit: 10,
      });

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
      expect(page).toMatchObject({ page: 3, limit: 10 });
    });

    it('reports the total across all pages, counted with the same filter', async () => {
      prisma.event.findMany.mockResolvedValue([{ id: 'event-1' }]);
      prisma.event.count.mockResolvedValue(45);

      const page = await service.findForOrganization('organizer-1', 'org-1', {
        status: 'DRAFT',
        limit: 1,
      });

      expect(prisma.event.count).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', deletedAt: null, status: 'DRAFT' },
      });
      expect(page.total).toBe(45);
      expect(page.items).toHaveLength(1);
    });

    it('orders by createdAt then id so pages stay stable when timestamps tie', async () => {
      prisma.event.findMany.mockResolvedValue([]);

      await service.findForOrganization('organizer-1', 'org-1');

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('excludes soft-deleted events from organization listings (#207)', async () => {
      prisma.event.findMany.mockResolvedValue([]);
      prisma.event.count.mockResolvedValue(0);

      await service.findForOrganization('organizer-1', 'org-1');

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null }) as never,
        }),
      );
      expect(prisma.event.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null }) as never,
        }),
      );
    });
  });

  describe('soft-delete (#207)', () => {
    it('treats a soft-deleted event as not found', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({ id: 'event-1', organizationId: 'org-1' }),
        deletedAt: new Date('2026-09-26T00:00:00.000Z'),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });

      await expect(service.getWithOrg('event-1')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('soft-deletes by setting deletedAt instead of hard-deleting', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({ id: 'event-1', organizationId: 'org-1' }),
        deletedAt: null,
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });
      prisma.event.update.mockResolvedValue({ id: 'event-1' });

      await service.softDelete('organizer-1', 'event-1');

      expect(prisma.event.update).toHaveBeenCalledWith({
        where: { id: 'event-1' },
        data: { deletedAt: expect.any(Date) as never },
      });
    });

    it('restores a soft-deleted event by clearing deletedAt', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({ id: 'event-1', organizationId: 'org-1' }),
        deletedAt: new Date('2026-09-26T00:00:00.000Z'),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });
      prisma.event.update.mockResolvedValue({ id: 'event-1' });

      await service.restore('organizer-1', 'event-1');

      expect(prisma.event.update).toHaveBeenCalledWith({
        where: { id: 'event-1' },
        data: { deletedAt: null },
      });
    });

    it('rejects restoration with 404 when the associated organization is soft-deleted (#566)', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({ id: 'event-1', organizationId: 'org-1' }),
        deletedAt: new Date('2026-09-26T00:00:00.000Z'),
        organization: {
          ...createOrganization({ stellarAccount: 'GORG' }),
          deletedAt: new Date('2026-09-25T00:00:00.000Z'),
        },
      });

      await expect(service.restore('organizer-1', 'event-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.event.update).not.toHaveBeenCalled();
    });
  });

  describe('cache invalidation', () => {
    it('invalidates cache on create', async () => {
      prisma.event.create.mockResolvedValue({ id: 'event-1' });
      prisma.event.findUniqueOrThrow.mockResolvedValue({ ticketTypes: [] });
      await service.create('user-1', 'org-1', {
        name: 'Test',
        category: 'CONCERTS',
        startsAt: new Date(),
      } as never);
      expect(cache.delete).toHaveBeenCalledWith('cache:/v1/events');
    });

    it('invalidates cache on confirmPublish', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({
          id: 'event-1',
          organizationId: 'org-1',
          chainEventId: 99n,
        }),
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });
      prisma.event.update.mockResolvedValue({ id: 'event-1' });
      await service.confirmPublish('organizer-1', 'event-1', 'signed-xdr');
      expect(cache.delete).toHaveBeenCalledWith('cache:/v1/events');
    });

    it('invalidates cache on softDelete', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...createEvent({ id: 'event-1', organizationId: 'org-1' }),
        deletedAt: null,
        organization: createOrganization({ stellarAccount: 'GORG' }),
      });
      prisma.event.update.mockResolvedValue({ id: 'event-1' });
      await service.softDelete('organizer-1', 'event-1');
      expect(cache.delete).toHaveBeenCalledWith('cache:/v1/events');
    });
  });
});
