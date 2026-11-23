import {
  IsBase64,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Industry } from '@prisma/client';
import { IsStellarPublicKey } from '../../common/decorators/is-stellar-public-key.decorator';
import { Trim } from '../../common/decorators/trim.decorator';

/**
 * Editable organization fields. `slug` is deliberately absent: it is immutable
 * once created, and the global whitelist pipe rejects it as an unknown field.
 */
export class UpdateOrganizationDto {
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(256)
  name?: string;

  @IsOptional()
  @IsEnum(Industry)
  industry?: Industry;

  @IsOptional()
  @IsStellarPublicKey()
  stellarAccount?: string;

  /** #595 — required whenever `stellarAccount` is changed. */
  @IsOptional()
  @IsBase64()
  stellarAccountSignature?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  logoUrl?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  websiteUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(10_000)
  @Max(50_000)
  defaultMaxResaleMultiplierBps?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_000)
  defaultRoyaltyBps?: number;
}
