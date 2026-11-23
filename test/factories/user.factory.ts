import type { User } from '@prisma/client';

let counter = 0;

/** Returns a fully-valid `User` row, with realistic defaults, merged with `overrides`. */
export function createUser(overrides: Partial<User> = {}): User {
  const n = ++counter;
  return {
    id: `user-${n}`,
    email: `user${n}@example.com`,
    passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV',
    name: `Test User ${n}`,
    role: 'ATTENDEE',
    stellarPublicKey: null,
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    emailVerificationTokenHash: null,
    emailVerificationExpiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}
