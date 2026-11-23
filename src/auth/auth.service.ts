import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';

const BCRYPT_ROUNDS = 12;

/**
 * #385 — fixed dummy bcrypt hash used when an email is unknown, ensuring
 * `bcrypt.compare` executes and takes equivalent computation time regardless
 * of whether the account exists.
 */
const DUMMY_HASH =
  '$2b$12$Mm25jOsvB1cT9TlV02n5tebZEwmESUQ0Vuyz2bg9GmInAxSoKG5ae';

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** #599 — how long an email verification token stays valid. */
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/** Fresh verification token plus the columns that store its hash and expiry. */
const newVerification = () => {
  const token = randomBytes(32).toString('hex');
  return {
    token,
    fields: {
      emailVerificationTokenHash: hashToken(token),
      emailVerificationExpiresAt: new Date(
        Date.now() + EMAIL_VERIFICATION_TTL_MS,
      ),
    },
  };
};

export interface AuthResult {
  accessToken: string;
  user: { id: string; email: string; name: string; role: string };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly notifications: NotificationService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const email = normalizeEmail(dto.email);
    const existing = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const verification = newVerification();
    let user;
    try {
      user = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          name: dto.name,
          ...verification.fields,
        },
      });
    } catch (err) {
      // #601 — a concurrent register for the same email loses the race here.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'An account with this email already exists',
        );
      }
      throw err;
    }

    await this.notifications.sendEmailVerification(
      user.email,
      verification.token,
    );
    return this.buildAuthResult(user.id, user.email, user.name, user.role);
  }

  /** #599 — consumes a verification token. Single use: the hash is cleared on success. */
  async verifyEmail(dto: VerifyEmailDto) {
    const now = new Date();
    const { count } = await this.prisma.user.updateMany({
      where: {
        emailVerificationTokenHash: hashToken(dto.token),
        emailVerificationExpiresAt: { gt: now },
      },
      data: {
        emailVerifiedAt: now,
        emailVerificationTokenHash: null,
        emailVerificationExpiresAt: null,
      },
    });
    if (count !== 1) {
      throw new BadRequestException('Invalid or expired verification token');
    }
    return { emailVerified: true };
  }

  /** #599 — issues a new verification token for the signed-in user. */
  async resendVerification(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!user) {
      throw new UnauthorizedException();
    }
    if (user.emailVerifiedAt) {
      return { emailVerified: true };
    }

    const verification = newVerification();
    await this.prisma.user.update({
      where: { id: userId },
      data: verification.fields,
    });
    await this.notifications.sendEmailVerification(
      user.email,
      verification.token,
    );
    return { emailVerified: false };
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    const hashToCompare = user ? user.passwordHash : DUMMY_HASH;
    const passwordValid = await bcrypt.compare(dto.password, hashToCompare);

    if (!user || !passwordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.buildAuthResult(user.id, user.email, user.name, user.role);
  }

  private buildAuthResult(
    id: string,
    email: string,
    name: string,
    role: string,
  ): AuthResult {
    const accessToken = this.jwt.sign({ sub: id, email, role });
    return { accessToken, user: { id, email, name, role } };
  }
}
