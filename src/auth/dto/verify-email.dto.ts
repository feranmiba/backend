import { IsString, Length } from 'class-validator';

export class VerifyEmailDto {
  /** Raw token from the verification email (64 hex characters). */
  @IsString()
  @Length(64, 64)
  token!: string;
}
