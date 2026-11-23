import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateOrganizationDto } from './update-organization.dto';

function build(payload: Record<string, unknown>) {
  return plainToInstance(UpdateOrganizationDto, payload);
}

describe('UpdateOrganizationDto', () => {
  it('accepts an empty payload', async () => {
    const errors = await validate(build({}));
    expect(errors).toHaveLength(0);
  });

  it('accepts a stellarAccount change that carries a signature', async () => {
    const errors = await validate(
      build({
        stellarAccount:
          'GBAHZWO3UI3GAHPQCPSW6IR5N7HJ4UBRZNAFMSYB6DAKVNHQDOZIV2YJ',
        stellarAccountSignature: 'c2lnbmF0dXJl',
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts a partial update', async () => {
    const errors = await validate(
      build({ name: 'Renamed Org', websiteUrl: 'https://example.com' }),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects slug as a non-whitelisted property', async () => {
    const errors = await validate(build({ slug: 'new-slug' }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.some((e) => e.property === 'slug')).toBe(true);
  });

  it('rejects a name shorter than 2 characters', async () => {
    const errors = await validate(build({ name: 'A' }));
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('rejects an industry outside the enum', async () => {
    const errors = await validate(build({ industry: 'CIRCUS' }));
    expect(errors.some((e) => e.property === 'industry')).toBe(true);
  });

  it('rejects an invalid stellarAccount', async () => {
    const errors = await validate(build({ stellarAccount: 'not-valid' }));
    expect(errors.some((e) => e.property === 'stellarAccount')).toBe(true);
  });

  it('rejects a defaultRoyaltyBps above 2000', async () => {
    const errors = await validate(build({ defaultRoyaltyBps: 3_000 }));
    expect(errors.some((e) => e.property === 'defaultRoyaltyBps')).toBe(true);
  });
});
