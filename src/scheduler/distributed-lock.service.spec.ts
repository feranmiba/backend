import { DistributedLockService } from './distributed-lock.service';
import type { PrismaService } from '../prisma/prisma.service';

describe('DistributedLockService', () => {
  let lockService: DistributedLockService;
  let prisma: {
    $executeRawUnsafe: jest.Mock;
    $queryRawUnsafe: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      $queryRawUnsafe: jest.fn(),
    };
    lockService = new DistributedLockService(prisma as unknown as PrismaService);
  });

  it('initializes table on module init', async () => {
    await lockService.onModuleInit();
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS "distributed_locks"'),
    );
  });

  it('acquires lock when atomic query returns the owner row', async () => {
    prisma.$queryRawUnsafe.mockImplementation(
      async (_sql: string, name: string, ownerToken: string) => [
        { name, owner: ownerToken },
      ],
    );

    const lock = await lockService.acquire('test-lock', 10000);

    expect(lock).not.toBeNull();
    expect(lock?.lockName).toBe('test-lock');
    expect(lock?.ownerToken).toBeDefined();
  });

  it('returns null when lock is currently held by another replica', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([]);

    const lock = await lockService.acquire('held-lock', 10000);

    expect(lock).toBeNull();
  });

  it('fails closed and returns null on database error', async () => {
    prisma.$queryRawUnsafe.mockRejectedValue(new Error('Connection lost'));

    const lock = await lockService.acquire('error-lock', 10000);

    expect(lock).toBeNull();
  });

  it('releases lock matching owner token safely', async () => {
    prisma.$executeRawUnsafe.mockResolvedValue(1);

    const released = await lockService.release({
      lockName: 'my-lock',
      ownerToken: 'owner-abc',
    });

    expect(released).toBe(true);
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM "distributed_locks"'),
      'my-lock',
      'owner-abc',
    );
  });
});
