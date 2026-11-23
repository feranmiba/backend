import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  EMAIL_PROVIDER,
  EmailProvider,
  LogEmailProvider,
  NotificationService,
} from './notifications.service';
import { SmtpEmailProvider } from './smtp-email.provider';

export function createEmailProvider(config: ConfigService): EmailProvider {
  const nodeEnv = config.get<string>('NODE_ENV', 'development');
  const providerKind = config.get<string>('EMAIL_PROVIDER')?.trim().toLowerCase();

  const isProduction = nodeEnv === 'production';
  const effectiveKind = providerKind ?? (isProduction ? 'smtp' : 'log');

  if (effectiveKind === 'smtp') {
    const host = config.get<string>('SMTP_HOST');
    const port = config.get<number>('SMTP_PORT');
    const from = config.get<string>('SMTP_FROM');
    const user = config.get<string>('SMTP_USER');
    const password = config.get<string>('SMTP_PASSWORD');
    const secureStr = config.get<string>('SMTP_SECURE');
    const secure = secureStr !== undefined ? secureStr === 'true' : undefined;

    if (!host || port === undefined || !from) {
      throw new Error(
        'Missing required SMTP configuration (SMTP_HOST, SMTP_PORT, SMTP_FROM are required when EMAIL_PROVIDER=smtp)',
      );
    }

    if (user && !password) {
      throw new Error('SMTP_PASSWORD is required when SMTP_USER is set');
    }

    new Logger('NotificationsModule').log(
      `Using SmtpEmailProvider with host ${host}:${port} (from: ${from})`,
    );

    return new SmtpEmailProvider({
      host,
      port: Number(port),
      from,
      user,
      password,
      secure,
    });
  }

  if (effectiveKind === 'log') {
    if (isProduction) {
      throw new Error(
        'LogEmailProvider is not permitted in production. Configure a real email provider (EMAIL_PROVIDER=smtp).',
      );
    }
    return new LogEmailProvider();
  }

  throw new Error(
    `Unsupported EMAIL_PROVIDER: "${providerKind}". Supported providers: log, smtp`,
  );
}

@Module({
  imports: [ConfigModule],
  providers: [
    NotificationService,
    LogEmailProvider,
    {
      provide: EMAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: createEmailProvider,
    },
  ],
  exports: [NotificationService, EMAIL_PROVIDER, LogEmailProvider],
})
export class NotificationsModule {}
