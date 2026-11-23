import { BadRequestException } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * #595 / #596 — proof that a user controls a Stellar account. The server
 * issues a single-use nonce; the user signs the challenge message with the
 * account's key (SEP-53 "Stellar Signed Message" format, as produced by
 * wallets such as Freighter) and the server verifies it before linking the key.
 */
export const STELLAR_PROOF_PURPOSE = {
  WALLET_CONNECT: 'wallet-connect',
  ORGANIZATION_ACCOUNT: 'organization-account',
} as const;

export type StellarProofPurpose =
  (typeof STELLAR_PROOF_PURPOSE)[keyof typeof STELLAR_PROOF_PURPOSE];

export const STELLAR_PROOF_PURPOSES: string[] = Object.values(
  STELLAR_PROOF_PURPOSE,
);

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SIGNED_MESSAGE_PREFIX = 'Stellar Signed Message:\n';

export function buildChallengeMessage(
  purpose: string,
  publicKey: string,
  nonce: string,
): string {
  return [
    'StellarTickets account proof',
    `Purpose: ${purpose}`,
    `Account: ${publicKey}`,
    `Nonce: ${nonce}`,
  ].join('\n');
}

/** Verifies a base64 ed25519 signature over a SEP-53 signed message. */
export function verifySignedMessage(
  publicKey: string,
  message: string,
  signatureBase64: string,
): boolean {
  try {
    const digest = createHash('sha256')
      .update(SIGNED_MESSAGE_PREFIX + message)
      .digest();
    return Keypair.fromPublicKey(publicKey).verify(
      digest,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

/** Creates a challenge for `userId` to sign and returns the exact message to sign. */
export async function issueStellarChallenge(
  prisma: PrismaService,
  userId: string,
  purpose: string,
  publicKey: string,
): Promise<{ message: string; expiresAt: Date }> {
  const nonce = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await prisma.stellarChallenge.create({
    data: { userId, purpose, stellarPublicKey: publicKey, nonce, expiresAt },
  });
  return {
    message: buildChallengeMessage(purpose, publicKey, nonce),
    expiresAt,
  };
}

/**
 * Throws unless `signature` is a valid signature by `publicKey` over an
 * unused, unexpired challenge issued to `userId` for `purpose`. A matching
 * challenge is marked used, so each proof can be redeemed only once.
 */
export async function consumeStellarProof(
  prisma: PrismaService,
  userId: string,
  purpose: string,
  publicKey: string,
  signature: string,
): Promise<void> {
  const now = new Date();
  const candidates = await prisma.stellarChallenge.findMany({
    where: {
      userId,
      purpose,
      stellarPublicKey: publicKey,
      usedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
  });
  const match = candidates.find((c) =>
    verifySignedMessage(
      publicKey,
      buildChallengeMessage(purpose, publicKey, c.nonce),
      signature,
    ),
  );
  const invalid = new BadRequestException(
    'Signature does not prove control of this Stellar account; request a new challenge and sign it',
  );
  if (!match) {
    throw invalid;
  }

  const { count } = await prisma.stellarChallenge.updateMany({
    where: { id: match.id, usedAt: null },
    data: { usedAt: now },
  });
  if (count !== 1) {
    throw invalid;
  }
}
