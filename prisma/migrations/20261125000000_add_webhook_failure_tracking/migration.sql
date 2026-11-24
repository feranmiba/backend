-- #547: webhook endpoint failure tracking and auto-disable
ALTER TABLE "WebhookEndpoint"
ADD COLUMN "consecutiveFailureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastFailureReason" TEXT,
ADD COLUMN "lastFailedAt" TIMESTAMP(3);
