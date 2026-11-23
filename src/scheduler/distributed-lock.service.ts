import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

export interface LockHandle {
  lockName: string;
  ownerToken: string;
}

@Injectable()
export class DistributedLockService implements OnModuleInit {
  private readonly logger = new Logger(DistributedLockService.name);
  private tableInitialized = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.ensureTable();
  }

  async ensureTable(): Promise<void> {
    if (this.tableInitialized) return;
    try {
      if (this.prisma.$executeRawUnsafe) {
        await this.prisma.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS "distributed_locks" (
            "name" VARCHAR(255) PRIMARY KEY,
            "owner" VARCHAR(255) NOT NULL,
            "acquired_at" TIMESTAMPTZ NOT NULL,
            "expires_at" TIMESTAMPTZ NOT NULL
          )
        `);
        this.tableInitialized = true;
      }
    } catch (err) {
      this.logger.warn(
        `Failed to initialize distributed_locks table: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Atomically acquires a cluster-wide distributed lock using the database (#536).
   * If a lock with `name` exists and has not expired, returns null.
   * If the previous lock has expired, safely acquires it with a new owner token.
   */
  async acquire(
    name: string,
    ttlMs: number = 240_000,
  ): Promise<LockHandle | null> {
    await this.ensureTable();
    const ownerToken = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    try {
      if (this.prisma.$queryRawUnsafe) {
        const rows = await this.prisma.$queryRawUnsafe<
          Array<{ name: string; owner: string }>
        >(
          `
          INSERT INTO "distributed_locks" ("name", "owner", "acquired_at", "expires_at")
          VALUES ($1, $2, $3, $4)
          ON CONFLICT ("name") DO UPDATE
            SET "owner" = EXCLUDED."owner",
                "acquired_at" = EXCLUDED."acquired_at",
                "expires_at" = EXCLUDED."expires_at"
            WHERE "distributed_locks"."expires_at" < $3
          RETURNING "name", "owner"
          `,
          name,
          ownerToken,
          now,
          expiresAt,
        );

        if (rows && rows.length > 0 && rows[0].owner === ownerToken) {
          return { lockName: name, ownerToken };
        }
      }
      return null;
    } catch (err) {
      this.logger.error(
        `Database error while acquiring lock "${name}": ${(err as Error).message}`,
      );
      // On database errors, fail closed to avoid uncontrolled concurrent execution
      return null;
    }
  }

  /**
   * Safely releases the lock only if the current owner token matches.
   * Prevents an expired lock holder from inadvertently releasing a newer owner's lock (#536).
   */
  async release(lock: LockHandle): Promise<boolean> {
    try {
      if (this.prisma.$executeRawUnsafe) {
        const rowsDeleted = await this.prisma.$executeRawUnsafe(
          `
          DELETE FROM "distributed_locks"
          WHERE "name" = $1 AND "owner" = $2
          `,
          lock.lockName,
          lock.ownerToken,
        );
        return rowsDeleted > 0;
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `Failed to release distributed lock "${lock.lockName}": ${(err as Error).message}`,
      );
      return false;
    }
  }
}
