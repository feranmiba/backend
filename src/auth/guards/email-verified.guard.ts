import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { CurrentUserPayload } from '../decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * #599 — blocks sensitive actions until the signed-in user has verified their
 * email. Must run after JwtAuthGuard, which populates `request.user`.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context
      .switchToHttp()
      .getRequest<{ user: CurrentUserPayload }>();
    const row = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { emailVerifiedAt: true },
    });
    if (!row?.emailVerifiedAt) {
      throw new ForbiddenException(
        'Verify your email address before doing this',
      );
    }
    return true;
  }
}
