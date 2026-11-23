import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { OrgMemberRole, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { nextAvailableSlug, slugify } from '../common/utils/slug';
import {
  consumeStellarProof,
  STELLAR_PROOF_PURPOSE,
} from '../common/stellar-proof';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  async create(userId: string, dto: CreateOrganizationDto) {
    const slug = await this.resolveSlug(dto);
    await consumeStellarProof(
      this.prisma,
      userId,
      STELLAR_PROOF_PURPOSE.ORGANIZATION_ACCOUNT,
      dto.stellarAccount,
      dto.stellarAccountSignature,
    );

    const org = await this.prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({
        data: {
          name: dto.name,
          slug,
          industry: dto.industry,
          stellarAccount: dto.stellarAccount,
          logoUrl: dto.logoUrl,
          websiteUrl: dto.websiteUrl,
          defaultMaxResaleMultiplierBps: dto.defaultMaxResaleMultiplierBps,
          defaultRoyaltyBps: dto.defaultRoyaltyBps,
        },
      });
      await tx.organizationMember.create({
        data: { organizationId: created.id, userId, role: OrgMemberRole.OWNER },
      });
      await tx.user.updateMany({
        where: { id: userId, role: UserRole.ATTENDEE },
        data: { role: UserRole.ORGANIZER },
      });
      return created;
    });

    // #209 — audit org creation (best-effort, never blocks the response).
    await this.audit?.record(
      userId,
      'organization.create',
      'Organization',
      org.id,
      {
        slug: org.slug,
      },
    );
    return org;
  }

  /**
   * An explicit slug must be free. Without one, the slug is derived from the
   * name and suffixed `-2`, `-3`, … until it no longer collides.
   */
  private async resolveSlug(dto: CreateOrganizationDto): Promise<string> {
    if (dto.slug) {
      const existingSlug = await this.prisma.organization.findUnique({
        where: { slug: dto.slug },
      });
      if (existingSlug) {
        throw new ConflictException('That organization slug is already taken');
      }
      return dto.slug;
    }

    const base = slugify(dto.name);
    const taken = await this.prisma.organization.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });
    return nextAvailableSlug(base, new Set(taken.map((o) => o.slug)));
  }

  async findMine(userId: string) {
    return this.prisma.organization.findMany({
      // #207 — hide soft-deleted orgs.
      where: { members: { some: { userId } }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    // #207 — soft-deleted rows read as not-found.
    if (!org || (org as { deletedAt?: Date | null }).deletedAt) {
      throw new NotFoundException('Organization not found');
    }
    return org;
  }

  /** Edits an organization's mutable fields. Only OWNER/ADMIN members may update; `slug` is immutable. */
  async update(userId: string, id: string, dto: UpdateOrganizationDto) {
    await this.findOne(id);
    await this.assertRole(id, userId, [
      OrgMemberRole.OWNER,
      OrgMemberRole.ADMIN,
    ]);
    if (dto.stellarAccount !== undefined) {
      if (!dto.stellarAccountSignature) {
        throw new BadRequestException(
          'stellarAccountSignature is required when changing stellarAccount',
        );
      }
      await consumeStellarProof(
        this.prisma,
        userId,
        STELLAR_PROOF_PURPOSE.ORGANIZATION_ACCOUNT,
        dto.stellarAccount,
        dto.stellarAccountSignature,
      );
    }
    const org = await this.prisma.organization.update({
      where: { id },
      // Fields are listed explicitly so `slug` can never be written here.
      data: {
        name: dto.name,
        industry: dto.industry,
        stellarAccount: dto.stellarAccount,
        logoUrl: dto.logoUrl,
        websiteUrl: dto.websiteUrl,
        defaultMaxResaleMultiplierBps: dto.defaultMaxResaleMultiplierBps,
        defaultRoyaltyBps: dto.defaultRoyaltyBps,
      },
    });
    await this.audit?.record(
      userId,
      'organization.update',
      'Organization',
      id,
      {
        fields: Object.keys(dto),
      },
    );
    return org;
  }

  /** #207 — soft-delete: sets `deletedAt` instead of hard-deleting. */
  async softDelete(userId: string, id: string) {
    await this.findOne(id);
    await this.assertMember(id, userId);
    const org = await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.organization.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      // #390 — an ORGANIZER is a member of at least one live organization.
      // Demote this org's members that no longer are, in one statement.
      await tx.user.updateMany({
        where: {
          role: UserRole.ORGANIZER,
          memberships: {
            some: { organizationId: id },
            none: { organization: { deletedAt: null } },
          },
        },
        data: { role: UserRole.ATTENDEE },
      });
      return deleted;
    });
    await this.audit?.record(userId, 'organization.delete', 'Organization', id);
    return org;
  }

  /** #207 — restore a soft-deleted organization. */
  async restore(userId: string, id: string) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) {
      throw new NotFoundException('Organization not found');
    }
    await this.assertMember(id, userId);
    const restored = await this.prisma.$transaction(async (tx) => {
      const live = await tx.organization.update({
        where: { id },
        data: { deletedAt: null },
      });
      // #390 — members regain ORGANIZER once the organization is live again.
      await tx.user.updateMany({
        where: {
          role: UserRole.ATTENDEE,
          memberships: { some: { organizationId: id } },
        },
        data: { role: UserRole.ORGANIZER },
      });
      return live;
    });
    await this.audit?.record(
      userId,
      'organization.restore',
      'Organization',
      id,
    );
    return restored;
  }

  /** True when `userId` belongs to `organizationId`. Never throws. */
  async isMember(organizationId: string, userId: string): Promise<boolean> {
    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    return membership !== null;
  }

  /** Throws unless `userId` is a member of `organizationId`. Used by Events/Tickets services to authorize writes. */
  async assertMember(organizationId: string, userId: string): Promise<void> {
    if (!(await this.isMember(organizationId, userId))) {
      throw new ForbiddenException('You are not a member of this organization');
    }
  }

  /** Throws unless `userId` holds one of `roles` in `organizationId`. */
  async assertRole(
    organizationId: string,
    userId: string,
    roles: OrgMemberRole[],
  ): Promise<void> {
    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this organization');
    }
    if (!roles.includes(membership.role)) {
      throw new ForbiddenException(
        'Only organization owners and admins can perform this action',
      );
    }
  }
}
