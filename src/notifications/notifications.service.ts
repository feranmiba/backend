import { Inject, Injectable, Logger } from '@nestjs/common';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  metadata?: Record<string, unknown>;
}

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

@Injectable()
export class LogEmailProvider implements EmailProvider {
  private readonly logger = new Logger(LogEmailProvider.name);
  send(message: EmailMessage): Promise<void> {
    this.logger.log(
      `Email to ${message.to}: ${message.subject}\n${message.text}`,
    );
    return Promise.resolve();
  }
}

@Injectable()
export class NotificationService {
  constructor(
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
  ) {}

  /** #599 — sends the one-time token that proves the recipient controls `to`. */
  sendEmailVerification(to: string, token: string): Promise<void> {
    return this.provider.send({
      to,
      subject: 'Verify your email address',
      text: `Use this token to verify your email address (valid for 24 hours):\n\n${token}\n`,
      metadata: { type: 'verification' },
    });
  }

  sendTicketReceipt(input: {
    to: string;
    buyerName: string;
    eventName: string;
    ticketType: string;
    seat: string;
  }): Promise<void> {
    return this.provider.send({
      to: input.to,
      subject: `Your ${input.eventName} ticket`,
      text: `Hi ${input.buyerName},\n\nYour ${input.ticketType} ticket for ${input.eventName} is confirmed.\nSeat: ${input.seat}\n`,
      metadata: {
        type: 'ticket_receipt',
        eventName: input.eventName,
        ticketType: input.ticketType,
        seat: input.seat,
      },
    });
  }

  /** #537 — sends event reminder notifications to attendees. */
  sendEventReminder(input: {
    to: string;
    recipientName?: string;
    eventName: string;
    startsAt: Date;
    venue: string;
    seat?: string;
  }): Promise<void> {
    const formattedDate = input.startsAt.toUTCString();
    const greeting = input.recipientName ? `Hi ${input.recipientName},\n\n` : '';
    const seatInfo =
      input.seat && input.seat !== 'unassigned' ? `Seat: ${input.seat}\n` : '';

    return this.provider.send({
      to: input.to,
      subject: `Reminder: ${input.eventName} is coming up soon!`,
      text: `${greeting}This is a reminder that ${input.eventName} is starting soon.\n\nDate & Time: ${formattedDate}\nVenue: ${input.venue}\n${seatInfo}\nWe look forward to seeing you there!\n`,
      metadata: {
        type: 'event_reminder',
        eventName: input.eventName,
        startsAt: input.startsAt,
        venue: input.venue,
        seat: input.seat,
      },
    });
  }

  /** #561 — notifies a waitlist user that they've been offered a purchase window. */
  sendWaitlistOffer(input: {
    to: string;
    userName: string;
    eventName: string;
    ticketType: string;
    expiresAt: Date;
  }): Promise<void> {
    const expiresFormatted = input.expiresAt.toLocaleString();
    return this.provider.send({
      to: input.to,
      subject: `Ticket available: ${input.eventName}`,
      text: `Hi ${input.userName},\n\nGood news! A ${input.ticketType} ticket for ${input.eventName} is now available for you to purchase.\n\nThis offer expires at ${expiresFormatted}. Don't miss out!\n`,
    });
  }
}
