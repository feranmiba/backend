import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { EmailVerifiedGuard } from './email-verified.guard';
import type { PrismaService } from '../../prisma/prisma.service';

describe('EmailVerifiedGuard (#599)', () => {
  let prisma: { user: { findUnique: jest.Mock } };
  let guard: EmailVerifiedGuard;

  const contextFor = (userId: string): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          user: { userId, email: 'a@b.c', role: 'ATTENDEE' },
        }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn() } };
    guard = new EmailVerifiedGuard(prisma as unknown as PrismaService);
  });

  it('allows a user whose email is verified', async () => {
    prisma.user.findUnique.mockResolvedValue({ emailVerifiedAt: new Date() });

    await expect(guard.canActivate(contextFor('user-1'))).resolves.toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { emailVerifiedAt: true },
    });
  });

  it('blocks a user who has not verified their email', async () => {
    prisma.user.findUnique.mockResolvedValue({ emailVerifiedAt: null });

    await expect(
      guard.canActivate(contextFor('user-1')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks when the user row is missing', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(guard.canActivate(contextFor('ghost'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
