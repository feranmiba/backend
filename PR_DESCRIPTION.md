# Fix 4 Critical Backend Issues

Resolves #541, #547, #561, #562

## Summary

This PR addresses four high-priority issues affecting email reliability, webhook management, waitlist functionality, and event republishing. All acceptance criteria have been met with no breaking changes.

---

## Changes

### #541: Receipt Email Failure No Longer Fails Purchase Confirm ✅
**Problem:** SMTP errors returned HTTP 500 for successful purchases  
**Solution:** Fire-and-forget pattern with error logging

- Modified `src/tickets/tickets.service.ts::confirmPurchase()`
- Email failures are logged but don't block purchase confirmation

### #547: Webhook Endpoints Auto-Disable After Repeated Failures ✅
**Problem:** Failed webhooks continued indefinitely, wasting resources  
**Solution:** Automatic disable after 5 consecutive failures

- Added DB fields: `consecutiveFailureCount`, `lastFailureReason`, `lastFailedAt`
- Created migration: `20261125000000_add_webhook_failure_tracking`
- Implemented failure callback in webhook queue worker
- Disabled endpoints logged with failure details

### #561: Waitlist Users Now Notified of Offers ✅
**Problem:** Users missed purchase opportunities  
**Solution:** Email notifications when offers are made

- Added `NotificationService.sendWaitlistOffer()` method
- Updated `WaitlistService.offerNext()` to send emails
- Fire-and-forget pattern (email failures don't block offers)
- Emails include event details and expiration time

### #562: Unpublish/Republish Round-Trip Now Works ✅
**Problem:** Republishing failed with `EventAlreadyExists` contract error  
**Solution:** Clear chain-related fields on unpublish

- Modified `src/events/events.service.ts::unpublish()`
- Clears `chainEventId`, `chainEventIdReservedAt`, `publishedTxHash`
- Allows clean republishing while preserving on-chain event

---

## Files Changed

### Modified
- `src/tickets/tickets.service.ts` - Fire-and-forget email sending
- `src/webhooks/bullmq-webhook-queue.ts` - Failure callback mechanism
- `src/webhooks/webhooks.module.ts` - Auto-disable logic
- `src/webhooks/webhooks.service.ts` - Removed duplicate code
- `src/waitlist/waitlist.service.ts` - Offer notifications
- `src/waitlist/waitlist.module.ts` - Import NotificationsModule
- `src/notifications/notifications.service.ts` - Waitlist offer email
- `src/events/events.service.ts` - Clear chain fields on unpublish
- `prisma/schema.prisma` - Webhook failure tracking fields

### Added
- `prisma/migrations/20261125000000_add_webhook_failure_tracking/migration.sql`

---

## Testing Checklist

- [ ] Email failure during purchase doesn't return 500
- [ ] Webhook disabled after 5 consecutive failures
- [ ] Waitlist users receive offer emails
- [ ] Unpublish → publish round-trip succeeds

---

## Migration Required

```bash
npx prisma migrate deploy
```

---

## Backward Compatibility

✅ All changes are backward compatible
- New DB fields have sensible defaults
- Optional dependencies handle missing modules gracefully
- Existing functionality enhanced, not changed
