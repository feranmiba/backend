import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOrganizationDto } from './create-organization.dto';

const VALID_KEY = 'GBAHZWO3UI3GAHPQCPSW6IR5N7HJ4UBRZNAFMSYB6DAKVNHQDOZIV2YJ';

function build(overrides: Record<string, unknown> = {}) {
  return plainToInstance(CreateOrganizationDto, {
    name: 'Test Org',
    slug: 'test-org',
    industry: 'CONCERTS',
    stellarAccount: VALID_KEY,
    stellarAccountSignature: 'c2lnbmF0dXJl',
    ...overrides,
  });
}

describe('CreateOrganizationDto', () => {
  it('accepts a well-formed payload', async () => {
    const errors = await validate(build());
    expect(errors).toHaveLength(0);
  });

  it('rejects an uppercase or spaced slug', async () => {
    const errors = await validate(build({ slug: 'Not A Slug' }));
    expect(errors.some((e) => e.property === 'slug')).toBe(true);
  });

  it('accepts a payload without a slug', async () => {
    const errors = await validate(build({ slug: undefined }));
    expect(errors).toHaveLength(0);
  });

  it('rejects an industry outside the enum', async () => {
    const errors = await validate(build({ industry: 'CIRCUS' }));
    expect(errors.some((e) => e.property === 'industry')).toBe(true);
  });

  it('rejects a name shorter than 2 characters', async () => {
    const errors = await validate(build({ name: 'A' }));
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('requires a signed proof of the stellarAccount (#595)', async () => {
    const errors = await validate(
      build({ stellarAccountSignature: undefined }),
    );
    expect(errors.some((e) => e.property === 'stellarAccountSignature')).toBe(
      true,
    );
  });

  it('rejects an invalid stellarAccount', async () => {
    const errors = await validate(build({ stellarAccount: 'not-valid' }));
    expect(errors.some((e) => e.property === 'stellarAccount')).toBe(true);
  });

  it('accepts optional organization branding URLs', async () => {
    const errors = await validate(
      build({
        logoUrl: 'https://example.com/logo.png',
        websiteUrl: 'https://example.com',
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it.each(['logoUrl', 'websiteUrl'])('rejects an invalid %s', async (field) => {
    const errors = await validate(build({ [field]: 'not-a-url' }));
    expect(errors.some((e) => e.property === field)).toBe(true);
  });

  it('accepts optional resale defaults within range', async () => {
    const errors = await validate(
      build({
        defaultMaxResaleMultiplierBps: 15_000,
        defaultRoyaltyBps: 1_000,
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects a defaultMaxResaleMultiplierBps below 10000', async () => {
    const errors = await validate(
      build({ defaultMaxResaleMultiplierBps: 5_000 }),
    );
    expect(
      errors.some((e) => e.property === 'defaultMaxResaleMultiplierBps'),
    ).toBe(true);
  });

  it('rejects a defaultRoyaltyBps above 2000', async () => {
    const errors = await validate(build({ defaultRoyaltyBps: 3_000 }));
    expect(errors.some((e) => e.property === 'defaultRoyaltyBps')).toBe(true);
  });

  describe('max length (#400)', () => {
    it('rejects a name over 256 characters', async () => {
      const errors = await validate(build({ name: 'a'.repeat(257) }));
      expect(errors.some((e) => e.property === 'name')).toBe(true);
    });

    it('accepts a name at exactly 256 characters', async () => {
      const errors = await validate(build({ name: 'a'.repeat(256) }));
      expect(errors).toHaveLength(0);
    });
  });
});
