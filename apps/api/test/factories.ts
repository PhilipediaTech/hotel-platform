import { randomUUID } from 'node:crypto';
import type { Db } from '../src/core/db.ts';

/** Short unique suffix so factories never collide inside one test. */
function uid(): string {
  return randomUUID().slice(0, 8);
}

export function makeOrganisation(db: Db, data: { name?: string; country?: string } = {}) {
  return db.organisation.create({
    data: { name: data.name ?? `Org ${uid()}`, country: data.country ?? 'NG' },
  });
}

export function makeProperty(db: Db, organisationId: string, data: { code?: string } = {}) {
  return db.property.create({
    data: {
      organisationId,
      code: data.code ?? `P${uid()}`,
      name: `Property ${uid()}`,
      address: { city: 'Lagos', country: 'NG' },
    },
  });
}

export function makeRole(db: Db, organisationId: string, data: { name?: string } = {}) {
  return db.role.create({ data: { organisationId, name: data.name ?? `Role ${uid()}` } });
}

export function makeUser(db: Db, data: { email?: string; phone?: string } = {}) {
  const email = data.email ?? (data.phone ? undefined : `user-${uid()}@example.test`);
  return db.user.create({
    data: {
      name: `User ${uid()}`,
      ...(email ? { email } : {}),
      ...(data.phone ? { phone: data.phone } : {}),
    },
  });
}

/** An organisation with one property and one role: the usual starting point. */
export async function makeTenant(db: Db) {
  const organisation = await makeOrganisation(db);
  const property = await makeProperty(db, organisation.id);
  const role = await makeRole(db, organisation.id);
  return { organisation, property, role };
}

export function makeRoomType(
  db: Db,
  property: { id: string; organisationId: string },
  data: { code?: string; name?: string } = {},
) {
  return db.roomType.create({
    data: {
      organisationId: property.organisationId,
      propertyId: property.id,
      code: data.code ?? `T${uid().slice(0, 6).toUpperCase()}`,
      name: data.name ?? `Type ${uid()}`,
    },
  });
}

export function makeRoom(
  db: Db,
  roomType: { id: string; propertyId: string; organisationId: string },
  data: { number?: string } = {},
) {
  return db.room.create({
    data: {
      organisationId: roomType.organisationId,
      propertyId: roomType.propertyId,
      roomTypeId: roomType.id,
      number: data.number ?? uid().slice(0, 6),
      qrToken: `qr-${uid()}`,
    },
  });
}
