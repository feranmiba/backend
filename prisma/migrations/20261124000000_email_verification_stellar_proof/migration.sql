-- #599: email verification state on User.
ALTER TABLE "User"
ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN "emailVerificationTokenHash" TEXT,
ADD COLUMN "emailVerificationExpiresAt" TIMESTAMP(3);

-- Accounts created before verification existed are treated as verified so
-- they are not locked out of invitations and organization creation.
UPDATE "User" SET "emailVerifiedAt" = CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "User_emailVerificationTokenHash_key" ON "User"("emailVerificationTokenHash");

-- #595 / #596: single-use signed-nonce challenges for Stellar account ownership.
CREATE TABLE "StellarChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "stellarPublicKey" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StellarChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StellarChallenge_userId_purpose_stellarPublicKey_idx" ON "StellarChallenge"("userId", "purpose", "stellarPublicKey");

ALTER TABLE "StellarChallenge" ADD CONSTRAINT "StellarChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
