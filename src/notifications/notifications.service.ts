import { Inject, Injectable, Logger } from '@nestjs/common';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}
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
    @Inject(LogEmailProvider) private readonly provider: EmailProvider,
  ) {}

  /** #599 — sends the one-time token that proves the recipient controls `to`. */
  sendEmailVerification(to: string, token: string): Promise<void> {
    return this.provider.send({
      to,
      subject: 'Verify your email address',
      text: `Use this token to verify your email address (valid for 24 hours):\n\n${token}\n`,
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
