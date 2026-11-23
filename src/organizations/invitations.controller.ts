import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../auth/guards/email-verified.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { InvitationsService } from './invitations.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post('invitations/accept')
  accept(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: AcceptInvitationDto,
  ) {
    return this.invitationsService.accept(user.userId, dto.token);
  }

  @Post(':id/invitations')
  @UseGuards(EmailVerifiedGuard)
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() dto: CreateInvitationDto,
  ) {
    return this.invitationsService.create(user.userId, id, dto);
  }
}
