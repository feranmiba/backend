import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import type { PrismaService } from '../prisma/prisma.service';
import { createOrganization } from '../../test/factories';
import { consumeStellarProof } from '../common/stellar-proof';

// #595 — the signature check itself is covered in stellar-proof.spec.ts; here
// we assert the service demands and checks a proof before writing.
jest.mock('../common/stellar-proof', () => ({
  ...jest.requireActual<typeof import('../common/stellar-proof')>(
    '../common/stellar-proof',
  ),
  consumeStellarProof: jest.fn().mockResolvedValue(undefined),
}));

describe('OrganizationsService', () => {
  let service: OrganizationsService;
  let prisma: {
    organization: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    organizationMember: { create: jest.Mock; findUnique: jest.Mock };
    user: { updateMany: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      organization: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      organizationMember: { create: jest.fn(), findUnique: jest.fn() },
      user: { updateMany: jest.fn() },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
    };
    service = new OrganizationsService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('rejects a slug that is already taken', async () => {
      prisma.organization.findUnique.mockResolvedValue(
        createOrganization({ id: 'existing-org' }),
      );

      await expect(
        service.create(
          'user-1',
          createOrganization({
            name: 'Test Org',
            slug: 'test-org',
            industry: 'CONCERTS',
          }) as never,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.organization.create).not.toHaveBeenCalled();
    });

    it('creates the org, an OWNER membership, and promotes an ATTENDEE to ORGANIZER', async () => {
      prisma.organization.findUnique.mockResolvedValue(null);
      prisma.organization.create.mockResolvedValue(
        createOrganization({ id: 'org-1', slug: 'test-org' }),
      );

      const org = await service.create(
        'user-1',
        createOrganization({
          name: 'Test Org',
          slug: 'test-org',
          industry: 'CONCERTS',
        }) as never,
      );

      expect(prisma.organizationMember.create).toHaveBeenCalledWith({
        data: { organizationId: 'org-1', userId: 'user-1', role: 'OWNER' },
      });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'user-1', role: 'ATTENDEE' },
        data: { role: 'ORGANIZER' },
      });
      expect(org).toMatchObject({ id: 'org-1', slug: 'test-org' });
    });

    describe('auto-generated slug', () => {
      // A tiny in-memory slug table so successive creates see earlier ones.
      let slugs: string[];

      beforeEach(() => {
        slugs = [];
        prisma.organization.findMany.mockImplementation(
          ({ where }: { where: { slug: { startsWith: string } } }) =>
            Promise.resolve(
              slugs
                .filter((s) => s.startsWith(where.slug.startsWith))
                .map((slug) => ({ slug })),
            ),
        );
        prisma.organization.create.mockImplementation(
          ({ data }: { data: { slug: string } }) => {
            slugs.push(data.slug);
            return Promise.resolve(createOrganization({ slug: data.slug }));
          },
        );
      });

      const sameName = () =>
        ({
          name: 'Acme Events',
          industry: 'CONCERTS',
          stellarAccount: 'G'.repeat(56),
        }) as never;

      it('gives three same-name orgs deterministic, distinct slugs', async () => {
        const first = await service.create('user-1', sameName());
        const second = await service.create('user-2', sameName());
        const third = await service.create('user-3', sameName());

        expect([first.slug, second.slug, third.slug]).toEqual([
          'acme-events',
          'acme-events-2',
          'acme-events-3',
        ]);
        expect(prisma.organization.findUnique).not.toHaveBeenCalled();
      });

      it('ignores unrelated slugs that merely share the prefix', async () => {
        slugs.push('acme-events-europe');

        const org = await service.create('user-1', sameName());

        expect(org.slug).toBe('acme-events');
      });
    });

    it('rolls back when a write inside the transaction fails', async () => {
      prisma.organization.findUnique.mockResolvedValue(null);
      prisma.organization.create.mockResolvedValue(
        createOrganization({ id: 'org-1', slug: 'test-org' }),
      );
      prisma.organizationMember.create.mockRejectedValue(
        new Error('membership write failed'),
      );

      await expect(
        service.create(
          'user-1',
          createOrganization({
            name: 'Test Org',
            slug: 'test-org',
            industry: 'CONCERTS',
          }) as never,
        ),
      ).rejects.toThrow('membership write failed');

      // The role promotion must never run once an earlier write in the same
      // transaction has failed, and the caller must never see the org that
      // $transaction's rejection means was rolled back.
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('stellarAccount proof (#595)', () => {
    const account = 'G'.repeat(56);

    beforeEach(() => {
      (consumeStellarProof as jest.Mock).mockClear();
    });

    it('verifies the organizer signed for this account before creating the org', async () => {
      prisma.organization.findUnique.mockResolvedValue(null);
      prisma.organization.create.mockResolvedValue(createOrganization());

      await service.create('user-1', {
        ...createOrganization({
          name: 'Proven Org',
          slug: 'proven-org',
          stellarAccount: account,
        }),
        stellarAccountSignature: 'sig-b64',
      } as never);

      expect(consumeStellarProof).toHaveBeenCalledWith(
        prisma,
        'user-1',
        'organization-account',
        account,
        'sig-b64',
      );
    });

    it('creates nothing when the proof is rejected', async () => {
      prisma.organization.findUnique.mockResolvedValue(null);
      (consumeStellarProof as jest.Mock).mockRejectedValueOnce(
        new BadRequestException('bad proof'),
      );

      await expect(
        service.create('user-1', {
          ...createOrganization({
            name: 'Hijacked Org',
            slug: 'hijacked-org',
            stellarAccount: account,
          }),
          stellarAccountSignature: 'forged',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.organization.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('requires a signature when an update changes stellarAccount', async () => {
      prisma.organization.findUnique.mockResolvedValue(
        createOrganization({ id: 'org-1', deletedAt: null }),
      );
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'OWNER' });

      await expect(
        service.update('user-1', 'org-1', { stellarAccount: account }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.organization.update).not.toHaveBeenCalled();
    });

    it('verifies the new account when an update changes stellarAccount', async () => {
      prisma.organization.findUnique.mockResolvedValue(
        createOrganization({ id: 'org-1', deletedAt: null }),
      );
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'OWNER' });
      prisma.organization.update.mockResolvedValue({ id: 'org-1' });

      await service.update('user-1', 'org-1', {
        stellarAccount: account,
        stellarAccountSignature: 'sig-b64',
      });

      expect(consumeStellarProof).toHaveBeenCalledWith(
        prisma,
        'user-1',
        'organization-account',
        account,
        'sig-b64',
      );
      expect(prisma.organization.update).toHaveBeenCalled();
    });

    it('does not ask for a proof when stellarAccount is not part of the update', async () => {
      prisma.organization.findUnique.mockResolvedValue(
        createOrganization({ id: 'org-1', deletedAt: null }),
      );
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'OWNER' });
      prisma.organization.update.mockResolvedValue({ id: 'org-1' });

      await service.update('user-1', 'org-1', { name: 'Renamed Org' });

      expect(consumeStellarProof).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('throws NotFoundException for a missing organization', async () => {
      prisma.organization.findUnique.mockResolvedValue(null);

      await expect(service.findOne('missing-id')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws NotFoundException for a soft-deleted organization (#207)', async () => {
      prisma.organization.findUnique.mockResolvedValue({
        ...createOrganization({ id: 'org-1' }),
        deletedAt: new Date('2026-09-26T00:00:00.000Z'),
      });

      await expect(service.findOne('org-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    beforeEach(() => {
      prisma.organization.findUnique.mockResolvedValue(
        createOrganization({ id: 'org-1', deletedAt: null }),
      );
      prisma.organization.update.mockResolvedValue({ id: 'org-1' });
    });

    it.each(['OWNER', 'ADMIN'])(
      'lets an %s update the organization',
      async (role) => {
        prisma.organizationMember.findUnique.mockResolvedValue({ role });

        await service.update('user-1', 'org-1', { name: 'Renamed Org' });

        expect(prisma.organization.update).toHaveBeenCalledWith({
          where: { id: 'org-1' },
          data: expect.objectContaining({ name: 'Renamed Org' }) as object,
        });
      },
    );

    it('rejects a STAFF member', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'STAFF' });

      await expect(
        service.update('user-1', 'org-1', { name: 'Renamed Org' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.organization.update).not.toHaveBeenCalled();
    });

    it('rejects a non-member', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(null);

      await expect(
        service.update('user-1', 'org-1', { name: 'Renamed Org' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.organization.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a missing organization', async () => {
      prisma.organization.findUnique.mockResolvedValue(null);

      await expect(
        service.update('user-1', 'missing', { name: 'Renamed Org' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never writes the slug, even if one slips through', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'OWNER' });

      await service.update('user-1', 'org-1', {
        name: 'Renamed Org',
        slug: 'hijacked',
      } as never);

      const [[{ data }]] = prisma.organization.update.mock.calls as [
        [{ data: Record<string, unknown> }],
      ];
      expect(data).not.toHaveProperty('slug');
    });
  });

  describe('soft-delete (#207)', () => {
    it('soft-deletes by setting deletedAt instead of hard-deleting', async () => {
      prisma.organization.findUnique.mockResolvedValue(
        createOrganization({ id: 'org-1', deletedAt: null }),
      );
      prisma.organizationMember.findUnique.mockResolvedValue({
        id: 'membership-1',
      });
      prisma.organization.update.mockResolvedValue({ id: 'org-1' });

      await service.softDelete('user-1', 'org-1');

      expect(prisma.organization.update).toHaveBeenCalledWith({
        where: { id: 'org-1' },
        data: { deletedAt: expect.any(Date) as Date },
      });
    });

    it('restores a soft-deleted organization by clearing deletedAt', async () => {
      prisma.organization.findUnique.mockResolvedValue({
        ...createOrganization({ id: 'org-1' }),
        deletedAt: new Date('2026-09-26T00:00:00.000Z'),
      });
      prisma.organizationMember.findUnique.mockResolvedValue({
        id: 'membership-1',
      });
      prisma.organization.update.mockResolvedValue({ id: 'org-1' });

      await service.restore('user-1', 'org-1');

      expect(prisma.organization.update).toHaveBeenCalledWith({
        where: { id: 'org-1' },
        data: { deletedAt: null },
      });
    });
  });

  describe('organizer role lifecycle (#390)', () => {
    beforeEach(() => {
      prisma.organizationMember.findUnique.mockResolvedValue({
        id: 'membership-1',
      });
      prisma.organization.update.mockResolvedValue({ id: 'org-1' });
    });

    it('demotes members left without any live organization on soft-delete', async () => {
      prisma.organization.findUnique.mockResolvedValue(
        createOrganization({ id: 'org-1', deletedAt: null }),
      );

      await service.softDelete('user-1', 'org-1');

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: {
          role: 'ORGANIZER',
          memberships: {
            some: { organizationId: 'org-1' },
            none: { organization: { deletedAt: null } },
          },
        },
        data: { role: 'ATTENDEE' },
      });
      // The org must be marked deleted first, inside the same transaction,
      // so the "no live membership" filter already excludes it.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(
        prisma.organization.update.mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.user.updateMany.mock.invocationCallOrder[0]);
    });

    it('re-promotes ATTENDEE members to ORGANIZER on restore', async () => {
      prisma.organization.findUnique.mockResolvedValue({
        ...createOrganization({ id: 'org-1' }),
        deletedAt: new Date('2026-09-26T00:00:00.000Z'),
      });

      await service.restore('user-1', 'org-1');

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: {
          role: 'ATTENDEE',
          memberships: { some: { organizationId: 'org-1' } },
        },
        data: { role: 'ORGANIZER' },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('does not demote anyone when the soft-delete write fails', async () => {
      prisma.organization.findUnique.mockResolvedValue(
        createOrganization({ id: 'org-1', deletedAt: null }),
      );
      prisma.organization.update.mockRejectedValue(new Error('write failed'));

      await expect(service.softDelete('user-1', 'org-1')).rejects.toThrow(
        'write failed',
      );
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('assertMember', () => {
    it('throws ForbiddenException when the user is not a member', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(null);

      await expect(
        service.assertMember('org-1', 'user-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('resolves silently when the user is a member', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({
        id: 'membership-1',
      });

      await expect(
        service.assertMember('org-1', 'user-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('isMember (#372)', () => {
    it('returns true when a membership row exists', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({
        id: 'membership-1',
      });

      await expect(service.isMember('org-1', 'user-1')).resolves.toBe(true);
      expect(prisma.organizationMember.findUnique).toHaveBeenCalledWith({
        where: {
          organizationId_userId: { organizationId: 'org-1', userId: 'user-1' },
        },
      });
    });

    it('returns false instead of throwing when there is no membership', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(null);

      await expect(service.isMember('org-1', 'user-1')).resolves.toBe(false);
    });
  });
});
