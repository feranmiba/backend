import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UsersService } from './users.service';
import type { PrismaService } from '../prisma/prisma.service';
import { consumeStellarProof } from '../common/stellar-proof';

// #596 — the cryptographic check is covered in stellar-proof.spec.ts; here we
// only assert that connectWallet requires it before writing.
jest.mock('../common/stellar-proof', () => ({
  ...jest.requireActual<typeof import('../common/stellar-proof')>(
    '../common/stellar-proof',
  ),
  consumeStellarProof: jest.fn(),
}));

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    ticket: { count: jest.Mock };
    resaleListing: { count: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      ticket: { count: jest.fn().mockResolvedValue(0) },
      resaleListing: { count: jest.fn().mockResolvedValue(0) },
    };
    prisma.user.findUnique.mockResolvedValue({ stellarPublicKey: null });
    service = new UsersService(prisma as unknown as PrismaService);
  });

  describe('findMe', () => {
    it('throws NotFoundException when the user no longer exists', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findMe('user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the profile projection', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'a@b.com',
      });

      const result = await service.findMe('user-1');
      expect(result).toEqual({ id: 'user-1', email: 'a@b.com' });
    });
  });

  describe('connectWallet', () => {
    it('rejects changing wallets while the user owns tickets', async () => {
      prisma.user.findUnique.mockResolvedValue({ stellarPublicKey: 'GOLD' });
      prisma.ticket.count.mockResolvedValue(1);

      await expect(
        service.connectWallet('user-1', 'GNEW', 'sig'),
      ).rejects.toMatchObject({ status: 409 });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('allows connecting or changing wallets when no assets are held', async () => {
      prisma.user.findUnique.mockResolvedValue({ stellarPublicKey: null });
      prisma.user.update.mockResolvedValue({
        id: 'user-1',
        stellarPublicKey: 'GNEW',
      });

      await expect(
        service.connectWallet('user-1', 'GNEW', 'sig'),
      ).resolves.toEqual({
        id: 'user-1',
        stellarPublicKey: 'GNEW',
      });
    });

    it('rejects a wallet already connected to another account', async () => {
      prisma.user.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );

      await expect(
        service.connectWallet('user-1', 'GABC', 'sig'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('responds with a 409 and a friendly, non-technical message', async () => {
      prisma.user.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );

      try {
        await service.connectWallet('user-1', 'GABC', 'sig');
        throw new Error('expected connectWallet to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const exception = err as ConflictException;
        expect(exception.getStatus()).toBe(409);
        expect(exception.message).toBe(
          'That wallet is already connected to another account',
        );
      }
    });

    it('rethrows unrelated errors', async () => {
      prisma.user.update.mockRejectedValue(new Error('connection lost'));

      await expect(
        service.connectWallet('user-1', 'GABC', 'sig'),
      ).rejects.toThrow('connection lost');
    });

    it('verifies the signed challenge for this user and key before writing (#596)', async () => {
      prisma.user.update.mockResolvedValue({
        id: 'user-1',
        stellarPublicKey: 'GNEW',
      });

      await service.connectWallet('user-1', 'GNEW', 'sig-base64');

      expect(consumeStellarProof).toHaveBeenCalledWith(
        prisma,
        'user-1',
        'wallet-connect',
        'GNEW',
        'sig-base64',
      );
      expect(
        (consumeStellarProof as jest.Mock).mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.user.update.mock.invocationCallOrder[0]);
    });

    it('does not link the wallet when the proof is rejected (#596)', async () => {
      (consumeStellarProof as jest.Mock).mockRejectedValueOnce(
        new BadRequestException('bad proof'),
      );

      await expect(
        service.connectWallet('user-1', 'GNEW', 'forged'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('updateProfile', () => {
    it('updates and returns the profile projection', async () => {
      prisma.user.update.mockResolvedValue({
        id: 'user-1',
        name: 'Ada Lovelace',
      });

      await expect(
        service.updateProfile('user-1', 'Ada Lovelace'),
      ).resolves.toEqual({ id: 'user-1', name: 'Ada Lovelace' });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { name: 'Ada Lovelace' },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          stellarPublicKey: true,
          createdAt: true,
        },
      });
    });

    it('returns not-found when the account no longer exists', async () => {
      prisma.user.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Record not found', {
          code: 'P2025',
          clientVersion: '6.19.3',
        }),
      );

      await expect(
        service.updateProfile('missing', 'Ada Lovelace'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('lookupByEmail', () => {
    it('throws NotFoundException when no account matches', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.lookupByEmail('nobody@example.com'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('normalizes email to trimmed lowercase before querying (#387)', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', name: 'Ana' });

      const result = await service.lookupByEmail('  Ana@Example.Com  ');

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'ana@example.com' },
        select: { id: true, name: true },
      });
      expect(result).toEqual({ id: 'user-1', name: 'Ana' });
    });
  });
});
