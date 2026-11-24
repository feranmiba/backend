import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { StellarModule } from '../stellar/stellar.module';
import { AuditModule } from '../audit/audit.module';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { OfflineTokenService } from './offline-token.service';
import { QrTokenService } from './qr-token.service';
import { ResaleExpiryService } from './resale-expiry.service';
import { ScanRateLimitGuard } from '../common/guards/scan-rate-limit.guard';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { PromoCodesModule } from '../promo-codes/promo-codes.module';
import { GatesModule } from '../gates/gates.module';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { JwtSecretModule } from '../auth/jwt-secret.module';
import { WaitlistModule } from '../waitlist/waitlist.module';

@Module({
  imports: [
    OrganizationsModule,
    StellarModule,
    AuditModule,
    NotificationsModule,
    PromoCodesModule,
    GatesModule,
    RateLimitModule,
    JwtSecretModule,
    WaitlistModule,
  ],
  controllers: [TicketsController],
  providers: [
    TicketsService,
    OfflineTokenService,
    QrTokenService,
    ResaleExpiryService,
    ScanRateLimitGuard,
    IdempotencyInterceptor,
  ],
  exports: [TicketsService, ResaleExpiryService],
})
export class TicketsModule {}
