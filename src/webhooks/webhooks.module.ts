import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullMqWebhookQueue } from './bullmq-webhook-queue';
import type { BullMqLike, WebhookFailureCallback } from './bullmq-webhook-queue';
import { DisabledWebhookQueue } from './disabled-webhook-queue';
import { WEBHOOK_QUEUE } from './webhook-queue';
import type { WebhookQueue } from './webhook-queue';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationsModule } from '../organizations/organizations.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 5_000;
const CONSECUTIVE_FAILURES_THRESHOLD = 5;

/**
 * `bullmq` is loaded only when `WEBHOOK_QUEUE_ENABLED=true`, so a deployment
 * that leaves the queue off doesn't need it (or Redis) installed.
 */
export async function loadBullMq(): Promise<BullMqLike> {
  const moduleName = 'bullmq';
  let loaded: Partial<BullMqLike> & { default?: BullMqLike };
  try {
    loaded = (await import(moduleName)) as typeof loaded;
  } catch {
    throw new Error(
      "WEBHOOK_QUEUE_ENABLED=true requires the 'bullmq' package — run `npm install bullmq`.",
    );
  }
  return (loaded.Queue ? loaded : loaded.default) as BullMqLike;
}

/** Turns `redis://user:pass@host:6379/2` (or `rediss://`) into ioredis options. */
export function redisConnectionFromUrl(url: string): Record<string, unknown> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('REDIS_URL is not a valid URL');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must start with redis:// or rediss://');
  }

  const db = Number(parsed.pathname.slice(1));
  return {
    host: parsed.hostname.replace(/^\[|\]$/g, ''),
    port: parsed.port ? Number(parsed.port) : 6379,
    ...(parsed.username
      ? { username: decodeURIComponent(parsed.username) }
      : {}),
    ...(parsed.password
      ? { password: decodeURIComponent(parsed.password) }
      : {}),
    ...(parsed.pathname.length > 1 && Number.isInteger(db) ? { db } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export async function createWebhookQueue(
  config: ConfigService,
  prisma: PrismaService,
  load: () => Promise<BullMqLike> = loadBullMq,
): Promise<WebhookQueue> {
  const enabled =
    config.get<string>('WEBHOOK_QUEUE_ENABLED')?.trim().toLowerCase() ===
    'true';
  if (!enabled) {
    return new DisabledWebhookQueue();
  }

  const url = config.get<string>('REDIS_URL');
  if (!url) {
    throw new Error('REDIS_URL is required when WEBHOOK_QUEUE_ENABLED=true');
  }

  // #547 — callback to disable endpoints after N consecutive failures
  const onFinalFailure: WebhookFailureCallback = async (delivery, error) => {
    const logger = new Logger('WebhookQueue');
    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: { url: delivery.url, isActive: true },
    });

    if (!endpoint) {
      return;
    }

    const newCount = endpoint.consecutiveFailureCount + 1;
    const shouldDisable = newCount >= CONSECUTIVE_FAILURES_THRESHOLD;

    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: {
        consecutiveFailureCount: newCount,
        lastFailureReason: error.message.slice(0, 500),
        lastFailedAt: new Date(),
        isActive: shouldDisable ? false : true,
      },
    });

    if (shouldDisable) {
      logger.warn(
        `Webhook endpoint ${endpoint.id} (${delivery.url}) disabled after ${newCount} consecutive failures: ${error.message}`,
      );
    }
  };

  const queue = BullMqWebhookQueue.create(await load(), {
    connection: redisConnectionFromUrl(url),
    attempts: positiveInt(
      config.get<number>('WEBHOOK_QUEUE_ATTEMPTS'),
      DEFAULT_ATTEMPTS,
    ),
    backoffMs: positiveInt(
      config.get<number>('WEBHOOK_QUEUE_BACKOFF_MS'),
      DEFAULT_BACKOFF_MS,
    ),
    onFinalFailure,
  });
  new Logger('WebhookQueue').log('Using Redis-backed webhook queue');
  return queue;
}

@Module({
  imports: [PrismaModule, OrganizationsModule],
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    {
      provide: WEBHOOK_QUEUE,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        createWebhookQueue(config, prisma),
    },
  ],
  exports: [WEBHOOK_QUEUE, WebhooksService],
})
export class WebhooksModule {}
