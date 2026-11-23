import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  consumeStellarProof,
  issueStellarChallenge,
  STELLAR_PROOF_PURPOSE,
} from '../common/stellar-proof';
import { StellarChallengeDto } from './dto/stellar-challenge.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        stellarPublicKey: true,
        createdAt: true,
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async updateProfile(userId: string, name: string) {
    try {
      return await this.prisma.user.update({
        where: { id: userId },
        data: { name },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          stellarPublicKey: true,
          createdAt: true,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('User not found');
      }
      throw err;
    }
  }

  /** #596 — issues the message the user must sign to prove control of `stellarPublicKey`. */
  createStellarChallenge(userId: string, dto: StellarChallengeDto) {
    return issueStellarChallenge(
      this.prisma,
      userId,
      dto.purpose,
      dto.stellarPublicKey,
    );
  }

  async connectWallet(
    userId: string,
    stellarPublicKey: string,
    signature: string,
  ) {
    try {
      const [user, ticketCount, activeListingCount] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { stellarPublicKey: true },
        }),
        this.prisma.ticket.count({ where: { ownerId: userId } }),
        this.prisma.resaleListing.count({
          where: { sellerId: userId, status: 'ACTIVE' },
        }),
      ]);

      if (!user) {
        throw new NotFoundException('User not found');
      }
      if (
        user.stellarPublicKey &&
        user.stellarPublicKey !== stellarPublicKey &&
        (ticketCount > 0 || activeListingCount > 0)
      ) {
        throw new ConflictException(
          'You cannot change your wallet while holding tickets or active listings',
        );
      }

      await consumeStellarProof(
        this.prisma,
        userId,
        STELLAR_PROOF_PURPOSE.WALLET_CONNECT,
        stellarPublicKey,
        signature,
      );

      return await this.prisma.user.update({
        where: { id: userId },
        data: { stellarPublicKey },
        select: { id: true, stellarPublicKey: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'That wallet is already connected to another account',
        );
      }
      throw err;
    }
  }

  /** Used by organizers/attendees to resolve a recipient before issuing or transferring a ticket. */
  async lookupByEmail(email: string) {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
      select: { id: true, name: true },
    });
    if (!user) {
      throw new NotFoundException('No account found with that email');
    }
    return user;
  }
}
