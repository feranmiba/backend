import { IsBase64 } from 'class-validator';
import { IsStellarPublicKey } from '../../common/decorators/is-stellar-public-key.decorator';

export class ConnectWalletDto {
  @IsStellarPublicKey()
  stellarPublicKey!: string;

  /** #596 — base64 signature over the challenge issued for this key. */
  @IsBase64()
  signature!: string;
}
