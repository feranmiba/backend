import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';

export class RevokeBatchDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, {
    each: true,
    message: 'Each ticket ID must not exceed 100 characters',
  })
  ticketIds!: string[];
}
