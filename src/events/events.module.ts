import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { StellarModule } from '../stellar/stellar.module';
import { AuditModule } from '../audit/audit.module';
import { CacheModule } from '../common/cache/cache.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { EventReminderService } from './event-reminder.service';

@Module({
  imports: [
    OrganizationsModule,
    StellarModule,
    AuditModule,
    CacheModule,
    NotificationsModule,
  ],
  controllers: [EventsController],
  providers: [EventsService, EventReminderService],
  exports: [EventsService, EventReminderService],
})
export class EventsModule {}
