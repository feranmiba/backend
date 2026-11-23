import { BadRequestException } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import {
  buildChallengeMessage,
  consumeStellarProof,
  issueStellarChallenge,
  STELLAR_PROOF_PURPOSE,
  verifySignedMessage,
} from './stellar-proof';
import { PrismaService } from '../prisma/prisma.service';

/** Signs the way Freighter's signMessage does: SEP-53 digest, base64 output. */
const sign = (keypair: Keypair, message: string) =>
  keypair
    .sign(
      createHash('sha256')
        .update('Stellar Signed Message:\n' + message)
        .digest(),
    )
    .toString('base64');

describe('stellar-proof (#595 / #596)', () => {
  const owner = Keypair.random();
  const other = Keypair.random();
  const purpose = STELLAR_PROOF_PURPOSE.WALLET_CONNECT;
  let prisma: {
    stellarChallenge: {
      create: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      stellarChallenge: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
  });

  const asPrisma = () => prisma as unknown as PrismaService;

  describe('verifySignedMessage', () => {
    it('accepts a signature by the account over the message', () => {
      const message = buildChallengeMessage(purpose, owner.publicKey(), 'n1');
      expect(
        verifySignedMessage(owner.publicKey(), message, sign(owner, message)),
      ).toBe(true);
    });

    it('rejects a signature by a different key', () => {
      const message = buildChallengeMessage(purpose, owner.publicKey(), 'n1');
      expect(
        verifySignedMessage(owner.publicKey(), message, sign(other, message)),
      ).toBe(false);
    });

    it('rejects a signature over a different message', () => {
      const signed = buildChallengeMessage(purpose, owner.publicKey(), 'n1');
      const claimed = buildChallengeMessage(purpose, owner.publicKey(), 'n2');
      expect(
        verifySignedMessage(owner.publicKey(), claimed, sign(owner, signed)),
      ).toBe(false);
    });

    it('returns false for garbage input instead of throwing', () => {
      expect(verifySignedMessage('not-a-key', 'msg', 'AAAA')).toBe(false);
      expect(
        verifySignedMessage(owner.publicKey(), 'msg', 'not base64 at all!'),
      ).toBe(false);
    });
  });

  describe('issueStellarChallenge', () => {
    it('stores a nonce bound to user, purpose and key, and returns the message to sign', async () => {
      const { message, expiresAt } = await issueStellarChallenge(
        asPrisma(),
        'user-1',
        purpose,
        owner.publicKey(),
      );

      const [createCall] = prisma.stellarChallenge.create.mock.calls as [
        [{ data: { nonce: string; expiresAt: Date } }],
      ];
      const { data } = createCall[0];
      expect(data).toMatchObject({
        userId: 'user-1',
        purpose,
        stellarPublicKey: owner.publicKey(),
        expiresAt,
      });
      expect(data.nonce).toMatch(/^[0-9a-f]{64}$/);
      expect(message).toBe(
        buildChallengeMessage(purpose, owner.publicKey(), data.nonce),
      );
      const ttl = expiresAt.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(4 * 60 * 1000);
      expect(ttl).toBeLessThanOrEqual(5 * 60 * 1000);
    });
  });

  describe('consumeStellarProof', () => {
    const issue = () => {
      const nonce = 'a'.repeat(64);
      prisma.stellarChallenge.findMany.mockResolvedValue([{ id: 'c1', nonce }]);
      return buildChallengeMessage(purpose, owner.publicKey(), nonce);
    };

    it('accepts a valid signature and marks the challenge used', async () => {
      const message = issue();

      await consumeStellarProof(
        asPrisma(),
        'user-1',
        purpose,
        owner.publicKey(),
        sign(owner, message),
      );

      expect(prisma.stellarChallenge.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'user-1',
            purpose,
            stellarPublicKey: owner.publicKey(),
            usedAt: null,
            expiresAt: { gt: expect.any(Date) as Date },
          }) as object,
        }),
      );
      expect(prisma.stellarChallenge.updateMany).toHaveBeenCalledWith({
        where: { id: 'c1', usedAt: null },
        data: { usedAt: expect.any(Date) as Date },
      });
    });

    it('rejects a signature from a different account', async () => {
      const message = issue();

      await expect(
        consumeStellarProof(
          asPrisma(),
          'user-1',
          purpose,
          owner.publicKey(),
          sign(other, message),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.stellarChallenge.updateMany).not.toHaveBeenCalled();
    });

    it('rejects when there is no outstanding challenge (never issued, used or expired)', async () => {
      prisma.stellarChallenge.findMany.mockResolvedValue([]);

      await expect(
        consumeStellarProof(
          asPrisma(),
          'user-1',
          purpose,
          owner.publicKey(),
          sign(owner, 'anything'),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a replay: the challenge is already consumed by a concurrent request', async () => {
      const message = issue();
      prisma.stellarChallenge.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        consumeStellarProof(
          asPrisma(),
          'user-1',
          purpose,
          owner.publicKey(),
          sign(owner, message),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
