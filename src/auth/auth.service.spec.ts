import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';

jest.mock('bcrypt', () => {
  const actual = jest.requireActual<typeof import('bcrypt')>('bcrypt');
  return {
    ...actual,
    compare: jest.fn((data: string | Buffer, encrypted: string) =>
      actual.compare(data, encrypted),
    ),
  };
});

import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let jwt: { sign: jest.Mock };
  let notifications: { sendEmailVerification: jest.Mock };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    jwt = { sign: jest.fn().mockReturnValue('signed.jwt.token') };
    notifications = {
      sendEmailVerification: jest.fn().mockResolvedValue(undefined),
    };
    service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as JwtService,
      notifications as unknown as NotificationService,
    );
  });

  const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');

  describe('register', () => {
    it('hashes the password and issues a token for a new email', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'user-1', role: 'ATTENDEE', ...data }),
      );

      const result = await service.register({
        email: 'attendee@example.com',
        password: 'correct-horse-battery',
        name: 'Ada Lovelace',
      });

      expect(prisma.user.create).toHaveBeenCalledTimes(1);
      const createCall = prisma.user.create.mock.calls[0] as [
        { data: { passwordHash: string } },
      ];
      const storedHash = createCall[0].data.passwordHash;
      expect(storedHash).not.toBe('correct-horse-battery');
      expect(await bcrypt.compare('correct-horse-battery', storedHash)).toBe(
        true,
      );
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.user.email).toBe('attendee@example.com');
    });

    it('turns a concurrent duplicate insert (P2002) into 409, not 500 (#601)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.register({
          email: 'race@example.com',
          password: 'correct-horse-battery',
          name: 'Racer',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(notifications.sendEmailVerification).not.toHaveBeenCalled();
    });

    it('rethrows unrelated database errors unchanged', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const boom = new Error('connection lost');
      prisma.user.create.mockRejectedValue(boom);

      await expect(
        service.register({
          email: 'x@example.com',
          password: 'correct-horse-battery',
          name: 'X',
        }),
      ).rejects.toBe(boom);
    });

    it('emails a verification token and stores only its hash (#599)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'user-1', role: 'ATTENDEE', ...data }),
      );

      await service.register({
        email: 'verify@example.com',
        password: 'correct-horse-battery',
        name: 'Verify Me',
      });

      const [createCall] = prisma.user.create.mock.calls as [
        [
          {
            data: {
              emailVerificationTokenHash: string;
              emailVerificationExpiresAt: Date;
            };
          },
        ],
      ];
      const { data } = createCall[0];
      const [to, token] = notifications.sendEmailVerification.mock.calls[0] as [
        string,
        string,
      ];
      expect(to).toBe('verify@example.com');
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(data.emailVerificationTokenHash).toBe(sha256(token));
      expect(data.emailVerificationTokenHash).not.toBe(token);
      expect(data.emailVerificationExpiresAt.getTime()).toBeGreaterThan(
        Date.now() + 23 * 60 * 60 * 1000,
      );
    });

    it('rejects a duplicate email', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(
        service.register({
          email: 'dup@example.com',
          password: 'x'.repeat(12),
          name: 'Dup',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('normalizes email to trimmed lowercase on register (#387)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'user-1', role: 'ATTENDEE', ...data }),
      );

      const result = await service.register({
        email: '  Ada.Lovelace@EXAMPLE.COM  ',
        password: 'correct-horse-battery',
        name: 'Ada Lovelace',
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'ada.lovelace@example.com' },
      });
      const createCall = prisma.user.create.mock.calls[0] as [
        { data: { email: string } },
      ];
      expect(createCall[0].data.email).toBe('ada.lovelace@example.com');
      expect(result.user.email).toBe('ada.lovelace@example.com');
    });
  });

  describe('login', () => {
    it('issues a token when the password matches', async () => {
      const passwordHash = await bcrypt.hash('correct-horse-battery', 4);
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'attendee@example.com',
        name: 'Ada Lovelace',
        role: 'ATTENDEE',
        passwordHash,
      });

      const result = await service.login({
        email: 'attendee@example.com',
        password: 'correct-horse-battery',
      });

      expect(result.accessToken).toBe('signed.jwt.token');
    });

    it('rejects a wrong password without leaking which field was wrong', async () => {
      const passwordHash = await bcrypt.hash('correct-horse-battery', 4);
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'attendee@example.com',
        passwordHash,
      });

      await expect(
        service.login({
          email: 'attendee@example.com',
          password: 'wrong-password',
        }),
      ).rejects.toThrow(new UnauthorizedException('Invalid email or password'));
    });

    it('rejects an unknown email', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nobody@example.com', password: 'whatever12' }),
      ).rejects.toThrow(new UnauthorizedException('Invalid email or password'));
    });

    it('gives an unknown email and a wrong password the exact same message', async () => {
      const passwordHash = await bcrypt.hash('correct-horse-battery', 4);

      prisma.user.findUnique.mockResolvedValueOnce(null);
      const unknownEmail = await service
        .login({ email: 'nobody@example.com', password: 'whatever12' })
        .catch((e: UnauthorizedException) => e.message);

      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        email: 'attendee@example.com',
        passwordHash,
      });
      const wrongPassword = await service
        .login({ email: 'attendee@example.com', password: 'wrong-password' })
        .catch((e: UnauthorizedException) => e.message);

      expect(unknownEmail).toBe(wrongPassword);
    });

    it('calls bcrypt.compare even when user is not found to prevent timing attacks (#385)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      (bcrypt.compare as unknown as jest.Mock).mockClear();

      await expect(
        service.login({ email: 'nobody@example.com', password: 'password123' }),
      ).rejects.toThrow(new UnauthorizedException('Invalid email or password'));

      expect(bcrypt.compare).toHaveBeenCalledWith(
        'password123',
        expect.any(String),
      );
    });

    it('normalizes email on login so registering with mixed case and logging in with lowercase succeeds (#387)', async () => {
      const passwordHash = await bcrypt.hash('correct-horse-battery', 4);
      prisma.user.findUnique.mockImplementation(
        ({ where }: { where: { email: string } }) => {
          if (where.email === 'ana@example.com') {
            return Promise.resolve({
              id: 'user-1',
              email: 'ana@example.com',
              name: 'Ana',
              role: 'ATTENDEE',
              passwordHash,
            });
          }
          return Promise.resolve(null);
        },
      );

      const result = await service.login({
        email: '  Ana@EXAMPLE.COM  ',
        password: 'correct-horse-battery',
      });

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.user.email).toBe('ana@example.com');
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'ana@example.com' },
      });
    });
  });

  describe('verifyEmail (#599)', () => {
    it('marks the email verified and clears the token when it matches and has not expired', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.verifyEmail({ token: 'a'.repeat(64) }),
      ).resolves.toEqual({ emailVerified: true });

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: {
          emailVerificationTokenHash: sha256('a'.repeat(64)),
          emailVerificationExpiresAt: { gt: expect.any(Date) as Date },
        },
        data: {
          emailVerifiedAt: expect.any(Date) as Date,
          emailVerificationTokenHash: null,
          emailVerificationExpiresAt: null,
        },
      });
    });

    it('rejects an unknown, expired, or already-used token', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.verifyEmail({ token: 'b'.repeat(64) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('resendVerification (#599)', () => {
    it('issues a new token and emails it to an unverified user', async () => {
      prisma.user.findUnique.mockResolvedValue({
        email: 'pending@example.com',
        emailVerifiedAt: null,
      });

      await expect(service.resendVerification('user-1')).resolves.toEqual({
        emailVerified: false,
      });

      const [to, token] = notifications.sendEmailVerification.mock.calls[0] as [
        string,
        string,
      ];
      expect(to).toBe('pending@example.com');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: {
          emailVerificationTokenHash: sha256(token),
          emailVerificationExpiresAt: expect.any(Date) as Date,
        },
      });
    });

    it('does nothing for a user who is already verified', async () => {
      prisma.user.findUnique.mockResolvedValue({
        email: 'done@example.com',
        emailVerifiedAt: new Date(),
      });

      await expect(service.resendVerification('user-1')).resolves.toEqual({
        emailVerified: true,
      });
      expect(notifications.sendEmailVerification).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
