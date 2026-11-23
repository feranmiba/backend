import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../auth/guards/email-verified.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { OrganizationsService } from './organizations.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Post()
  @UseGuards(EmailVerifiedGuard)
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateOrganizationDto,
  ) {
    return this.organizationsService.create(user.userId, dto);
  }

  @Get('mine')
  findMine(@CurrentUser() user: CurrentUserPayload) {
    return this.organizationsService.findMine(user.userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.organizationsService.findOne(id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationsService.update(user.userId, id, dto);
  }

  @Delete(':id')
  softDelete(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.organizationsService.softDelete(user.userId, id);
  }

  @Post(':id/restore')
  restore(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.organizationsService.restore(user.userId, id);
  }
}
