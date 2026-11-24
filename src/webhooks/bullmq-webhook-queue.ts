import { Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { deliverWebhook } from './webhook-delivery';
import { WEBHOOK_QUEUE_NAME, assertWebhookUrl } from './webhook-queue';
import type { WebhookDelivery, WebhookQueue } from './webhook-queue';

const WEBHOOK_JOB_NAME = 'deliver';
const WORKER_CONCURRENCY = 5;

/** The slice of a BullMQ `Queue` this module uses, so tests can fake it. */
export interface QueueLike {
  add(name: string, data: WebhookDelivery): Promise<unknown>;
  on(event: 'error', listener: (err: Error) => void): unknown;
  close(): Promise<void>;
}

/** Callback to be invoked when a webhook fails all retries. */
export type WebhookFailureCallback = (
  delivery: WebhookDelivery,
  error: Error,
) => Promise<void>;

/** The slice of a BullMQ `Worker` this module uses. */
export interface WorkerLike {
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(
    event: 'failed',
    listener: (
      job: { data: WebhookDelivery; attemptsMade: number } | undefined,
      err: Error,
    ) => void,
  ): unknown;
  on(
    event: 'completed',
    listener: (
      job: { data: WebhookDelivery; attemptsMade: number } | undefined,
    ) => void,
  ): unknown;
  close(): Promise<void>;
}

/** The slice of the `bullmq` package this module uses. */
export interface BullMqLike {
  Queue: new (name: string, options: Record<string, unknown>) => QueueLike;
  Worker: new (
    name: string,
    processor: (job: { data: WebhookDelivery }) => Promise<unknown>,
    options: Record<string, unknown>,
  ) => WorkerLike;
}

export interface BullMqWebhookQueueOptions {
  /** ioredis connection options, parsed from `REDIS_URL`. */
  connection: Record<string, unknown>;
  /** Total delivery attempts per webhook, the first one included. */
  attempts: number;
  /** Base delay before the first retry; doubles on every further retry. */
  backoffMs: number;
  /** Callback to invoke when a webhook fails all retries. */
  onFinalFailure?: WebhookFailureCallback;
}

/** Only the host is logged: the path or query of a webhook URL can carry a secret. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

/** Redis-backed queue with an in-process worker that delivers and retries. */
export class BullMqWebhookQueue implements WebhookQueue, OnModuleDestroy {
  constructor(
    private readonly queue: QueueLike,
    private readonly worker: WorkerLike,
    private readonly onFinalFailure?: WebhookFailureCallback,
  ) {}

  static create(
    bullmq: BullMqLike,
    { connection, attempts, backoffMs, onFinalFailure }: BullMqWebhookQueueOptions,
  ): BullMqWebhookQueue {
    const logger = new Logger('WebhookQueue');

    const queue = new bullmq.Queue(WEBHOOK_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts,
        backoff: { type: 'exponential', delay: backoffMs },
        removeOnComplete: { age: 60 * 60, count: 1_000 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      },
    });
    const worker = new bullmq.Worker(
      WEBHOOK_QUEUE_NAME,
      (job) => deliverWebhook(job.data),
      {
        // A Worker's blocking connection must not give up retrying Redis.
        connection: { ...connection, maxRetriesPerRequest: null },
        concurrency: WORKER_CONCURRENCY,
      },
    );

    // Without listeners an 'error' event would crash the process on a Redis blip.
    queue.on('error', (err) =>
      logger.error(`Webhook queue error: ${err.message}`),
    );
    worker.on('error', (err) =>
      logger.error(`Webhook worker error: ${err.message}`),
    );
    worker.on('failed', (job, err) => {
      if (!job) return;
      const remaining = attempts - job.attemptsMade;
      logger.warn(
        `Webhook ${job.data.event} to ${hostOf(job.data.url)} failed ` +
          `(attempt ${job.attemptsMade}/${attempts}, ` +
          `${remaining > 0 ? 'will retry' : 'giving up'}): ${err.message}`,
      );
      // #547 — when all retries are exhausted, invoke the callback so the
      // endpoint can be disabled.
      if (remaining === 0 && onFinalFailure) {
        onFinalFailure(job.data, err).catch((callbackErr) => {
          logger.error(
            `Webhook final failure callback error: ${callbackErr.message}`,
          );
        });
      }
    });
    worker.on('completed', (job) => {
      if (!job) return;
      logger.log(
        `Webhook ${job.data.event} to ${hostOf(job.data.url)} succeeded ` +
          `(attempt ${job.attemptsMade}/${attempts})`,
      );
    });

    return new BullMqWebhookQueue(queue, worker, onFinalFailure);
  }

  async enqueue(delivery: WebhookDelivery): Promise<boolean> {
    assertWebhookUrl(delivery.url);
    await this.queue.add(WEBHOOK_JOB_NAME, delivery);
    return true;
  }

  async onModuleDestroy(): Promise<void> {
    // Worker first, so an in-flight delivery finishes before its queue goes away.
    await this.worker.close();
    await this.queue.close();
  }
}
