import { NotificationService, LogEmailProvider } from './notifications.service';
import type { EmailProvider } from './notifications.service';

describe('NotificationService', () => {
  let service: NotificationService;
  let mockProvider: { send: jest.Mock };

  beforeEach(() => {
    mockProvider = {
      send: jest.fn().mockResolvedValue(undefined),
    };
    service = new NotificationService(mockProvider as EmailProvider);
  });

  it('sends email verification', async () => {
    await service.sendEmailVerification('user@example.com', 'token-123');

    expect(mockProvider.send).toHaveBeenCalledWith({
      to: 'user@example.com',
      subject: 'Verify your email address',
      text: expect.stringContaining('token-123'),
      metadata: { type: 'verification' },
    });
  });

  it('sends ticket receipt', async () => {
    await service.sendTicketReceipt({
      to: 'user@example.com',
      buyerName: 'Alice',
      eventName: 'Concert A',
      ticketType: 'VIP',
      seat: 'Row 1',
    });

    expect(mockProvider.send).toHaveBeenCalledWith({
      to: 'user@example.com',
      subject: 'Your Concert A ticket',
      text: expect.stringContaining('Alice'),
      metadata: expect.objectContaining({
        type: 'ticket_receipt',
        eventName: 'Concert A',
      }),
    });
  });

  it('sends event reminder (#537)', async () => {
    const startsAt = new Date('2026-10-01T20:00:00Z');
    await service.sendEventReminder({
      to: 'attendee@example.com',
      recipientName: 'Bob',
      eventName: 'Festival B',
      startsAt,
      venue: 'Open Air Grounds',
      seat: 'Gate 2',
    });

    expect(mockProvider.send).toHaveBeenCalledWith({
      to: 'attendee@example.com',
      subject: 'Reminder: Festival B is coming up soon!',
      text: expect.stringContaining('Festival B'),
      metadata: expect.objectContaining({
        type: 'event_reminder',
        eventName: 'Festival B',
      }),
    });
  });
});

describe('LogEmailProvider', () => {
  it('logs email without throwing', async () => {
    const provider = new LogEmailProvider();
    await expect(
      provider.send({
        to: 'test@example.com',
        subject: 'Test Subject',
        text: 'Test Body',
      }),
    ).resolves.toBeUndefined();
  });
});
