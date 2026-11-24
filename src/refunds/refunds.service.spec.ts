import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RefundsService } from './refunds.service';

describe('RefundsService (#141)', () => {
  let prisma: {
    ticket: { findUnique: jest.Mock };
    refund: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  };
  let service: RefundsService;

  beforeEach(() => {
    prisma = {
      ticket: { findUnique: jest.fn() },
      refund: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };
    service = new RefundsService(prisma as never);
  });

  it('creates a refund for a REVOKED ticket', async () => {
    prisma.ticket.findUnique.mockResolvedValue({ id: 't1', status: 'REVOKED' });
    prisma.refund.create.mockResolvedValue({
      id: 'r1',
      ticketId: 't1',
      status: 'PENDING',
    });

    const result = await service.create('t1');

    expect(prisma.refund.create).toHaveBeenCalledWith({
      data: { ticketId: 't1' },
    });
    expect(result.status).toBe('PENDING');
  });

  it('creates a refund for a ticket when the event is CANCELLED', async () => {
    prisma.ticket.findUnique.mockResolvedValue({
      id: 't1',
      status: 'VALID',
      event: { status: 'CANCELLED', startsAt: new Date(Date.now() - 1000) },
    });
    prisma.refund.create.mockResolvedValue({
      id: 'r1',
      ticketId: 't1',
      status: 'PENDING',
    });

    const result = await service.create('t1');

    expect(prisma.refund.create).toHaveBeenCalledWith({
      data: { ticketId: 't1' },
    });
    expect(result.status).toBe('PENDING');
  });

  it('creates a refund for a VALID ticket within the refund window (before event starts)', async () => {
    const futureDate = new Date(Date.now() + 86400000);
    prisma.ticket.findUnique.mockResolvedValue({
      id: 't1',
      status: 'VALID',
      event: { status: 'PUBLISHED', startsAt: futureDate },
    });
    prisma.refund.create.mockResolvedValue({
      id: 'r1',
      ticketId: 't1',
      status: 'PENDING',
    });

    const result = await service.create('t1');

    expect(prisma.refund.create).toHaveBeenCalledWith({
      data: { ticketId: 't1' },
    });
    expect(result.status).toBe('PENDING');
  });

  it('rejects a refund for a VALID ticket after the refund window has closed', async () => {
    const pastDate = new Date(Date.now() - 86400000);
    prisma.ticket.findUnique.mockResolvedValue({
      id: 't1',
      status: 'VALID',
      event: { status: 'PUBLISHED', startsAt: pastDate },
    });

    await expect(service.create('t1')).rejects.toThrow(
      new BadRequestException('Refund window has closed for this event'),
    );
    expect(prisma.refund.create).not.toHaveBeenCalled();
  });

  it('rejects a refund for a USED ticket even if event is cancelled', async () => {
    prisma.ticket.findUnique.mockResolvedValue({
      id: 't1',
      status: 'USED',
      event: { status: 'CANCELLED' },
    });

    await expect(service.create('t1')).rejects.toThrow(
      new BadRequestException('Used tickets cannot be refunded'),
    );
    expect(prisma.refund.create).not.toHaveBeenCalled();
  });

  it('rejects a refund if a refund already exists for the ticket', async () => {
    prisma.ticket.findUnique.mockResolvedValue({
      id: 't1',
      status: 'REVOKED',
      refund: { id: 'r1', status: 'PENDING' },
    });

    await expect(service.create('t1')).rejects.toThrow(
      new BadRequestException('Refund already requested for ticket t1'),
    );
    expect(prisma.refund.create).not.toHaveBeenCalled();
  });

  it('rejects a refund for a non-REVOKED ticket with no event or ineligible state', async () => {
    prisma.ticket.findUnique.mockResolvedValue({ id: 't1', status: 'VALID' });

    await expect(service.create('t1')).rejects.toThrow(BadRequestException);
    expect(prisma.refund.create).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for an unknown ticket', async () => {
    prisma.ticket.findUnique.mockResolvedValue(null);

    await expect(service.create('missing')).rejects.toThrow(NotFoundException);
  });

  it('completes a pending refund', async () => {
    prisma.refund.findUnique.mockResolvedValue({ id: 'r1', status: 'PENDING' });
    prisma.refund.update.mockResolvedValue({
      id: 'r1',
      status: 'COMPLETED',
      completedAt: new Date(),
    });

    const result = (await service.complete('r1')) as { status: string };

    expect(prisma.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r1' },
      }),
    );
    expect(result.status).toBe('COMPLETED');
  });

  it('throws NotFoundException when completing an unknown refund', async () => {
    prisma.refund.findUnique.mockResolvedValue(null);

    await expect(service.complete('missing')).rejects.toThrow(
      NotFoundException,
    );
  });
});
