# Acceptance Criteria Checklist

## Issue #541: Receipt Email Failure Fails Purchase Confirm

**Acceptance Criteria:** An email error does not fail confirm.

- [x] Email sending changed to fire-and-forget pattern
- [x] Errors are caught and logged
- [x] Purchase confirmation returns successfully even if email fails
- [x] Code reference: `src/tickets/tickets.service.ts` line ~368-380

**Status:** ✅ COMPLETE

---

## Issue #547: Webhook Endpoints Never Auto-Disabled After Repeated Failures

**Acceptance Criteria:** Failing endpoints are disabled.

- [x] Database schema updated with failure tracking fields
  - `consecutiveFailureCount` (default 0)
  - `lastFailureReason` (nullable)
  - `lastFailedAt` (nullable)
- [x] Migration created: `20261125000000_add_webhook_failure_tracking`
- [x] Failure callback mechanism implemented
- [x] Endpoints disabled after 5 consecutive failures
- [x] Failure details logged
- [x] Code references:
  - Schema: `prisma/schema.prisma` lines 435-450
  - Callback: `src/webhooks/webhooks.module.ts` lines 85-110
  - Type: `src/webhooks/bullmq-webhook-queue.ts` lines 17-20

**Status:** ✅ COMPLETE

---

## Issue #561: Waitlist Users Not Notified of Offers

**Acceptance Criteria:** A notification is sent.

- [x] `sendWaitlistOffer()` method added to NotificationService
- [x] Email includes:
  - User name
  - Event name
  - Ticket type
  - Expiration time
- [x] `offerNext()` sends notifications to all offered users
- [x] Email failures don't block offer creation (fire-and-forget)
- [x] NotificationsModule imported in WaitlistModule
- [x] Code references:
  - Notification: `src/notifications/notifications.service.ts` lines 53-68
  - Sending: `src/waitlist/waitlist.service.ts` lines 134-150
  - Module: `src/waitlist/waitlist.module.ts`

**Status:** ✅ COMPLETE

---

## Issue #562: Unpublish Leaves On-Chain Event In Place

**Acceptance Criteria:** An unpublish then publish round-trip works.

- [x] `unpublish()` clears `chainEventId`
- [x] `unpublish()` clears `chainEventIdReservedAt`
- [x] `unpublish()` clears `publishedTxHash`
- [x] Republishing after unpublish works without `EventAlreadyExists` error
- [x] Comment explains the approach (on-chain event stays, DB reset)
- [x] Code reference: `src/events/events.service.ts` lines 283-308

**Status:** ✅ COMPLETE

---

## Overall Status

✅ **ALL ACCEPTANCE CRITERIA MET**

All 4 issues have been successfully resolved:
- #541: Email failures don't block purchases
- #547: Webhooks auto-disable after repeated failures
- #561: Waitlist users receive offer notifications
- #562: Unpublish/republish round-trips work correctly
