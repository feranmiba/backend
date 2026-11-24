import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Off-chain refund records for primary-sale tickets (#141). */
@Injectable()
export class RefundsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ticketId: string, now: Date = new Date()) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { event: true, refund: true },
    });
    if (!ticket) throw new NotFoundException(`Ticket ${ticketId} not found`);

    if (ticket.refund) {
      throw new BadRequestException(
        `Refund already requested for ticket ${ticketId}`,
      );
    }

    if (ticket.status === 'USED') {
      throw new BadRequestException('Used tickets cannot be refunded');
    }

    const isRevoked = ticket.status === 'REVOKED';
    const isEventCancelled = ticket.event?.status === 'CANCELLED';
    const isWithinRefundWindow =
      ticket.status === 'VALID' &&
      ticket.event?.startsAt != null &&
      now < new Date(ticket.event.startsAt);

    if (!isRevoked && !isEventCancelled && !isWithinRefundWindow) {
      if (ticket.event?.startsAt && now >= new Date(ticket.event.startsAt)) {
        throw new BadRequestException(
          'Refund window has closed for this event',
        );
      }
      throw new BadRequestException('Ticket is not eligible for a refund');
    }

    return this.prisma.refund.create({ data: { ticketId } });
  }

  async complete(id: string) {
    const refund = await this.prisma.refund.findUnique({ where: { id } });
    if (!refund) throw new NotFoundException(`Refund ${id} not found`);
    return this.prisma.refund.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
  }
}
