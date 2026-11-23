import {
  IsBase64,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Industry } from '@prisma/client';
import { IsStellarPublicKey } from '../../common/decorators/is-stellar-public-key.decorator';
import { Trim } from '../../common/decorators/trim.decorator';
import { SLUG_MAX_LENGTH } from '../../common/utils/slug';

export class CreateOrganizationDto {
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(256)
  name!: string;

  /** Derived from `name` (with a `-2`, `-3`, … suffix if taken) when omitted. */
  @IsOptional()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase, alphanumeric, and hyphen-separated',
  })
  @MaxLength(SLUG_MAX_LENGTH)
  slug?: string;

  @IsEnum(Industry)
  industry!: Industry;

  @IsStellarPublicKey()
  stellarAccount!: string;

  /** #595 — base64 signature over the challenge issued for `stellarAccount`. */
  @IsBase64()
  stellarAccountSignature!: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  logoUrl?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  websiteUrl?: string;

  /** Default basis-point resale cap applied to this org's events when their DTO omits it. */
  @IsOptional()
  @IsInt()
  @Min(10_000)
  @Max(50_000)
  defaultMaxResaleMultiplierBps?: number;

  /** Default basis-point resale royalty applied to this org's events when their DTO omits it. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_000)
  defaultRoyaltyBps?: number;
}
