import {
  Body,
  Controller,
  ForbiddenException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { RefundsService } from './refunds.service';
import { CreateRefundDto } from './dto/create-refund.dto';

/** Admin-only refund endpoints for primary sales (#141). */
@Controller('refunds')
@UseGuards(JwtAuthGuard)
export class RefundsController {
  constructor(private readonly refundsService: RefundsService) {}

  @Post()
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateRefundDto,
  ) {
    this.requireAdmin(user);
    return this.refundsService.create(dto.ticketId);
  }

  @Patch(':id/complete')
  complete(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.requireAdmin(user);
    return this.refundsService.complete(id);
  }

  private requireAdmin(user: CurrentUserPayload): void {
    if (user.role !== 'PLATFORM_ADMIN') {
      throw new ForbiddenException('Only a platform admin can manage refunds');
    }
  }
}
