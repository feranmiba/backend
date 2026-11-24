import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';
import { RevokeBatchDto } from './revoke-batch.dto';

export class ConfirmRevokeBatchDto extends RevokeBatchDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(100)
  @MaxLength(4_000, {
    each: true,
    message: 'Each signed XDR must not exceed 4000 characters',
  })
  signedXdrs!: string[];
}
