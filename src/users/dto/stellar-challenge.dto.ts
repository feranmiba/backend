import { IsIn } from 'class-validator';
import { IsStellarPublicKey } from '../../common/decorators/is-stellar-public-key.decorator';
import { STELLAR_PROOF_PURPOSES } from '../../common/stellar-proof';

export class StellarChallengeDto {
  @IsStellarPublicKey()
  stellarPublicKey!: string;

  @IsIn(STELLAR_PROOF_PURPOSES)
  purpose!: string;
}
