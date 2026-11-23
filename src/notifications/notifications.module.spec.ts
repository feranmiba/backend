import { ConfigService } from '@nestjs/config';
import { createEmailProvider } from './notifications.module';
import { LogEmailProvider } from './notifications.service';
import { SmtpEmailProvider } from './smtp-email.provider';

describe('createEmailProvider (#540)', () => {
  it('defaults to LogEmailProvider in development/test', () => {
    const config = {
      get: jest.fn((key: string, fallback?: string) => {
        if (key === 'NODE_ENV') return 'development';
        if (key === 'EMAIL_PROVIDER') return undefined;
        return fallback;
      }),
    } as unknown as ConfigService;

    const provider = createEmailProvider(config);
    expect(provider).toBeInstanceOf(LogEmailProvider);
  });

  it('instantiates SmtpEmailProvider when EMAIL_PROVIDER=smtp and config is valid', () => {
    const config = {
      get: jest.fn((key: string, fallback?: string) => {
        if (key === 'NODE_ENV') return 'development';
        if (key === 'EMAIL_PROVIDER') return 'smtp';
        if (key === 'SMTP_HOST') return 'smtp.example.com';
        if (key === 'SMTP_PORT') return 587;
        if (key === 'SMTP_FROM') return 'tickets@example.com';
        return fallback;
      }),
    } as unknown as ConfigService;

    const provider = createEmailProvider(config);
    expect(provider).toBeInstanceOf(SmtpEmailProvider);
  });

  it('throws on startup when EMAIL_PROVIDER=smtp is missing required config', () => {
    const config = {
      get: jest.fn((key: string, fallback?: string) => {
        if (key === 'NODE_ENV') return 'development';
        if (key === 'EMAIL_PROVIDER') return 'smtp';
        // missing SMTP_HOST, SMTP_PORT, SMTP_FROM
        return fallback;
      }),
    } as unknown as ConfigService;

    expect(() => createEmailProvider(config)).toThrow(
      /Missing required SMTP configuration/,
    );
  });

  it('rejects LogEmailProvider in production', () => {
    const config = {
      get: jest.fn((key: string, fallback?: string) => {
        if (key === 'NODE_ENV') return 'production';
        if (key === 'EMAIL_PROVIDER') return 'log';
        return fallback;
      }),
    } as unknown as ConfigService;

    expect(() => createEmailProvider(config)).toThrow(
      /LogEmailProvider is not permitted in production/,
    );
  });
});
