// Tenancy + identity schema (first migration): defaults, uniqueness, cross-tenant foreign
// keys and the raw-SQL CHECK constraints.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrganisation, makeProperty, makeRole, makeTenant, makeUser } from './factories.ts';
import { expectViolation, resetDb, SQLSTATE, testDb } from './db.ts';

const db = testDb();

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('migrations', () => {
  it('create every tenancy and identity table', async () => {
    const rows = await db.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
    expect(rows.map((r) => r.tablename)).toEqual([
      '_prisma_migrations',
      'approval_policies',
      'approval_requests',
      'audit_events',
      'auth_tokens',
      'business_days',
      'cancellation_policies',
      'cash_counts',
      'cash_handovers',
      'cashier_shifts',
      'companies',
      'departments',
      'domain_events',
      'feature_flags',
      'files',
      'folio_lines',
      'folio_windows',
      'folios',
      'guests',
      'id_documents',
      'idempotency_keys',
      'import_jobs',
      'invitations',
      'key_issues',
      'leakage_alerts',
      'memberships',
      'mfa_recovery_codes',
      'organisations',
      'package_components',
      'payments',
      'properties',
      'property_counters',
      'quotes',
      'rate_days',
      'rate_limit_hits',
      'rate_plans',
      'registration_cards',
      'reservation_status_history',
      'reservations',
      'revenue_codes',
      'roles',
      'room_allocations',
      'room_blocks',
      'room_type_inventory',
      'room_types',
      'rooms',
      'routing_rules',
      'sessions',
      'stay_nights',
      'stays',
      'tax_rule_versions',
      'tax_rules',
      'users',
    ]);
  });
});

describe('properties', () => {
  it('start in SETUP with the Lagos defaults from the spec', async () => {
    const org = await makeOrganisation(db);
    const property = await makeProperty(db, org.id);
    expect(property).toMatchObject({
      status: 'SETUP',
      timeZone: 'Africa/Lagos',
      baseCurrency: 'NGN',
      locale: 'en-NG',
      checkInTime: '14:00',
      checkOutTime: '12:00',
      nightAuditTime: '03:00',
      taxRegistration: {},
      settings: {},
    });
  });

  it('have a unique code within an organisation, but not across organisations', async () => {
    const a = await makeOrganisation(db);
    const b = await makeOrganisation(db);
    await makeProperty(db, a.id, { code: 'LAG' });
    await expectViolation(
      makeProperty(db, a.id, { code: 'LAG' }),
      SQLSTATE.UNIQUE,
      'properties_organisation_id_code_key',
    );
    await expect(makeProperty(db, b.id, { code: 'LAG' })).resolves.toMatchObject({ code: 'LAG' });
  });

  it.each([
    ['base currency', { baseCurrency: 'ngn' }, 'properties_base_currency_iso4217'],
    ['check-in time', { checkInTime: '2pm' }, 'properties_times_hhmm'],
    ['night audit time', { nightAuditTime: '24:00' }, 'properties_times_hhmm'],
  ])('reject a malformed %s', async (_label, data, constraint) => {
    const org = await makeOrganisation(db);
    await expectViolation(
      db.property.create({
        data: { organisationId: org.id, code: 'X', name: 'X', address: {}, ...data },
      }),
      SQLSTATE.CHECK,
      constraint,
    );
  });

  it('reject an organisation country that is not upper-case ISO 3166 alpha-2', async () => {
    // CHAR(2) already rejects 'NGA' (length); the CHECK catches the right length, wrong form.
    await expectViolation(
      makeOrganisation(db, { country: 'ng' }),
      SQLSTATE.CHECK,
      'organisations_country_iso2',
    );
  });
});

describe('users', () => {
  it('need an email or a phone', async () => {
    await expectViolation(
      db.user.create({ data: { name: 'Nobody' } }),
      SQLSTATE.CHECK,
      'users_contact_present',
    );
  });

  it('can be phone-only (invited by phone, M1-04)', async () => {
    await expect(makeUser(db, { phone: '+2348012345678' })).resolves.toMatchObject({
      email: null,
      phone: '+2348012345678',
    });
  });

  it('store email lower-case so uniqueness is case-insensitive', async () => {
    await expectViolation(
      makeUser(db, { email: 'Ada@Example.test' }),
      SQLSTATE.CHECK,
      'users_email_lowercase',
    );
  });

  it('have unique emails', async () => {
    await makeUser(db, { email: 'ada@example.test' });
    await expectViolation(
      makeUser(db, { email: 'ada@example.test' }),
      SQLSTATE.UNIQUE,
      'users_email_key',
    );
  });

  it.each(['08012345678', '+234 801 234 5678', '+0123456789'])(
    'reject phone %j that is not E.164',
    async (phone) => {
      await expectViolation(makeUser(db, { phone }), SQLSTATE.CHECK, 'users_phone_e164');
    },
  );

  it('default to INVITED with MFA off and no failed logins', async () => {
    await expect(makeUser(db)).resolves.toMatchObject({
      status: 'INVITED',
      mfaEnabled: false,
      failedLogins: 0,
      lockedUntil: null,
    });
  });
});

describe('memberships: tenant boundaries in the database', () => {
  it('link a user to a role at a property of the same organisation', async () => {
    const { organisation, property, role } = await makeTenant(db);
    const user = await makeUser(db);
    await expect(
      db.membership.create({
        data: {
          userId: user.id,
          organisationId: organisation.id,
          propertyId: property.id,
          roleId: role.id,
        },
      }),
    ).resolves.toMatchObject({ active: true });
  });

  it('reject a property from another organisation', async () => {
    const a = await makeTenant(db);
    const b = await makeTenant(db);
    const user = await makeUser(db);
    await expectViolation(
      db.membership.create({
        data: {
          userId: user.id,
          organisationId: a.organisation.id,
          propertyId: b.property.id,
          roleId: a.role.id,
        },
      }),
      SQLSTATE.FOREIGN_KEY,
      'memberships_organisation_id_property_id_fkey',
    );
  });

  it('reject a role from another organisation', async () => {
    const a = await makeTenant(db);
    const b = await makeTenant(db);
    const user = await makeUser(db);
    await expectViolation(
      db.membership.create({
        data: {
          userId: user.id,
          organisationId: a.organisation.id,
          propertyId: a.property.id,
          roleId: b.role.id,
        },
      }),
      SQLSTATE.FOREIGN_KEY,
      'memberships_organisation_id_role_id_fkey',
    );
  });

  it('reject a department from another property', async () => {
    const { organisation, property, role } = await makeTenant(db);
    const other = await makeProperty(db, organisation.id);
    const dept = await db.department.create({
      data: { organisationId: organisation.id, propertyId: other.id, code: 'HK', name: 'HK' },
    });
    const user = await makeUser(db);
    await expectViolation(
      db.membership.create({
        data: {
          userId: user.id,
          organisationId: organisation.id,
          propertyId: property.id,
          roleId: role.id,
          departmentId: dept.id,
        },
      }),
      SQLSTATE.FOREIGN_KEY,
      'memberships_property_id_department_id_fkey',
    );
  });

  it('reject a department on an organisation-wide membership', async () => {
    const { organisation, property, role } = await makeTenant(db);
    const dept = await db.department.create({
      data: { organisationId: organisation.id, propertyId: property.id, code: 'HK', name: 'HK' },
    });
    const user = await makeUser(db);
    await expectViolation(
      db.membership.create({
        data: {
          userId: user.id,
          organisationId: organisation.id,
          propertyId: null,
          roleId: role.id,
          departmentId: dept.id,
        },
      }),
      SQLSTATE.CHECK,
      'memberships_department_needs_property',
    );
  });

  it('allow an organisation-wide role only once per user (NULLS NOT DISTINCT)', async () => {
    const { organisation, role } = await makeTenant(db);
    const user = await makeUser(db);
    const data = {
      userId: user.id,
      organisationId: organisation.id,
      propertyId: null,
      roleId: role.id,
    };
    await db.membership.create({ data });
    await expectViolation(
      db.membership.create({ data }),
      SQLSTATE.UNIQUE,
      'memberships_user_id_organisation_id_property_id_role_id_key',
    );
  });

  it('allow the same role at two properties', async () => {
    const { organisation, property, role } = await makeTenant(db);
    const second = await makeProperty(db, organisation.id);
    const user = await makeUser(db);
    for (const p of [property, second]) {
      await db.membership.create({
        data: {
          userId: user.id,
          organisationId: organisation.id,
          propertyId: p.id,
          roleId: role.id,
        },
      });
    }
    await expect(db.membership.count({ where: { userId: user.id } })).resolves.toBe(2);
  });
});

describe('roles', () => {
  it('default to no permissions, no limits and no MFA', async () => {
    const org = await makeOrganisation(db);
    await expect(makeRole(db, org.id)).resolves.toMatchObject({
      permissions: [],
      limits: {},
      requiresMfa: false,
      isSystem: false,
    });
  });

  it('have unique names within an organisation', async () => {
    const org = await makeOrganisation(db);
    await makeRole(db, org.id, { name: 'Front Desk' });
    await expectViolation(
      makeRole(db, org.id, { name: 'Front Desk' }),
      SQLSTATE.UNIQUE,
      'roles_organisation_id_name_key',
    );
  });
});

describe('invitations', () => {
  async function inviteData(overrides: { email?: string | null; phone?: string | null }) {
    const { organisation, property, role } = await makeTenant(db);
    const inviter = await makeUser(db);
    return {
      organisationId: organisation.id,
      propertyId: property.id,
      roleId: role.id,
      invitedById: inviter.id,
      tokenHash: `hash-${Math.random()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      email: 'new.staff@example.test',
      ...overrides,
    };
  }

  it('accept an email invitation', async () => {
    await expect(db.invitation.create({ data: await inviteData({}) })).resolves.toMatchObject({
      acceptedAt: null,
    });
  });

  it('need an email or a phone', async () => {
    await expectViolation(
      db.invitation.create({ data: await inviteData({ email: null }) }),
      SQLSTATE.CHECK,
      'invitations_contact_present',
    );
  });

  it('reject a role from another organisation', async () => {
    const data = await inviteData({});
    const other = await makeTenant(db);
    await expectViolation(
      db.invitation.create({ data: { ...data, roleId: other.role.id } }),
      SQLSTATE.FOREIGN_KEY,
      'invitations_organisation_id_role_id_fkey',
    );
  });
});

describe('sessions', () => {
  async function session(
    userId: string,
    extra: { parentSessionId?: string; sharedDevice?: boolean } = {},
  ) {
    return db.session.create({
      data: {
        userId,
        tokenHash: `t-${Math.random()}`,
        expiresAt: new Date(Date.now() + 3_600_000),
        lastSeenAt: new Date(),
        ...extra,
      },
    });
  }

  it('remove PIN sessions when their shared-device session is deleted', async () => {
    const manager = await makeUser(db);
    const clerk = await makeUser(db);
    const device = await session(manager.id, { sharedDevice: true });
    await session(clerk.id, { parentSessionId: device.id });
    await db.session.delete({ where: { id: device.id } });
    await expect(db.session.count({ where: { userId: clerk.id } })).resolves.toBe(0);
  });

  it('never mark a PIN session as a shared device', async () => {
    const manager = await makeUser(db);
    const device = await session(manager.id, { sharedDevice: true });
    await expectViolation(
      session(manager.id, { parentSessionId: device.id, sharedDevice: true }),
      SQLSTATE.CHECK,
      'sessions_child_not_shared',
    );
  });

  it('have unique token hashes', async () => {
    const user = await makeUser(db);
    const data = {
      userId: user.id,
      tokenHash: 'same',
      expiresAt: new Date(Date.now() + 1000),
      lastSeenAt: new Date(),
    };
    await db.session.create({ data });
    await expectViolation(db.session.create({ data }), SQLSTATE.UNIQUE, 'sessions_token_hash_key');
  });
});

describe('auth tokens', () => {
  it('are single-use records keyed by a unique hash', async () => {
    const user = await makeUser(db);
    const data = {
      userId: user.id,
      purpose: 'PASSWORD_RESET' as const,
      tokenHash: 'h1',
      expiresAt: new Date(Date.now() + 1000),
    };
    await expect(db.authToken.create({ data })).resolves.toMatchObject({ usedAt: null });
    await expectViolation(
      db.authToken.create({ data }),
      SQLSTATE.UNIQUE,
      'auth_tokens_token_hash_key',
    );
  });
});
