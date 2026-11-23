import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { UsersService } from './users.service';
import { ConnectWalletDto } from './dto/connect-wallet.dto';
import { LookupQuery } from './dto/lookup-query.dto';
import { StellarChallengeDto } from './dto/stellar-challenge.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  findMe(@CurrentUser() user: CurrentUserPayload) {
    return this.usersService.findMe(user.userId);
  }

  @Patch('me')
  updateProfile(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(user.userId, dto.name);
  }

  @Patch('me/wallet')
  connectWallet(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: ConnectWalletDto,
  ) {
    return this.usersService.connectWallet(
      user.userId,
      dto.stellarPublicKey,
      dto.signature,
    );
  }

  /** #595 / #596 — step 1 of any Stellar key claim: get the message to sign. */
  @Post('me/stellar-challenge')
  createStellarChallenge(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: StellarChallengeDto,
  ) {
    return this.usersService.createStellarChallenge(user.userId, dto);
  }

  @Get('lookup')
  lookupByEmail(@Query() query: LookupQuery) {
    return this.usersService.lookupByEmail(query.email);
  }
}
