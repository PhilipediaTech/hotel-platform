import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// ID scan at check-in (PRD M14-14 "As front desk, I photograph a guest's ID and the
// registration card fields fill in for me to check", reservation.checkin; M14 rules: AI never
// changes data without a person's confirmation, and its use counts against the plan's monthly
// allowance; T-150). The guest is Ada Obi, arriving today, not checked in yet.

const db = testDb();
const now = new Date('2026-11-10T09:00:00Z');
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
});

type Scan = {
  fields: {
    nationality: string | null;
    idType: string | null;
    idNumber: string | null;
    idExpiry: string | null;
    address: string | null;
  };
  nameOnId: { firstName: string; lastName: string } | null;
  nameMatchesGuest: boolean | null;
  expired: boolean | null;
  readable: boolean;
};

async function desk() {
  const h = await inHouse(db, clock, { checkIn: false });
  /** An uploaded ID photo with some bytes in storage. */
  const photo = async (contentType = 'image/jpeg') => {
    const { fileId } = await h.ok<{ fileId: string }>(
      h.fd.send('/files/upload-url', { entityType: 'IdDocument', contentType, sizeBytes: 4 }),
    );
    const file = await db.fileObject.findUniqueOrThrow({ where: { id: fileId } });
    await h.files.put(file.storageKey, Buffer.from([0xff, 0xd8, 0xff, 0xe0]), contentType);
    return fileId;
  };
  const scan = (fileId: string) => h.fd.post(`/stays/${h.stayId}/id-scan`, { fileId });
  return { ...h, photo, scan };
}

const PASSPORT = JSON.stringify({
  documentType: 'PASSPORT',
  documentNumber: 'A12345678',
  expiryDate: '2031-05-01',
  nationality: 'ng',
  firstName: 'ADA CHIOMA',
  lastName: 'OBI',
  address: null,
});

describe('ID scan at check-in (M14-14)', () => {
  it('reads the photo and answers the registration fields; nothing is saved but the audit', async () => {
    const h = await desk();
    h.ai.respond = () => `Here is what I can read:\n${PASSPORT}`;
    const fileId = await h.photo();
    const res = await h.ok<Scan>(h.scan(fileId));
    expect(res).toEqual({
      fields: {
        nationality: 'NG',
        idType: 'PASSPORT',
        idNumber: 'A12345678',
        idExpiry: '2031-05-01',
        address: null,
      },
      nameOnId: { firstName: 'ADA CHIOMA', lastName: 'OBI' },
      nameMatchesGuest: true,
      expired: false,
      readable: true,
    });
    // The photo went to the AI as a picture, with the fixed instructions.
    const sent = h.ai.requests.at(-1);
    expect(sent?.images).toEqual([{ mediaType: 'image/jpeg', data: '/9j/4A==' }]);
    expect(sent?.system).toContain('Never guess');
    // Nothing on the stay changed; the scan is audited without the ID's values.
    expect(await db.idDocument.count()).toBe(0);
    expect((await db.stay.findUniqueOrThrow({ where: { id: h.stayId } })).status).toBe('CONFIRMED');
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'stay.id_scanned' } });
    expect(audit.after).toEqual({
      fileId,
      found: ['nationality', 'idType', 'idNumber', 'idExpiry'],
      nameMatchesGuest: true,
      expired: false,
    });
    expect(JSON.stringify(audit.after)).not.toContain('A12345678');
    // One use of the month's AI allowance.
    const use = await db.usageCounter.findFirstOrThrow({ where: { metric: 'AI_ID_SCAN' } });
    expect(use.count).toBe(1);
  });

  it('flags another person’s or an expired ID, and drops anything malformed', async () => {
    const h = await desk();
    h.ai.respond = () =>
      JSON.stringify({
        documentType: 'MEMBERSHIP_CARD',
        documentNumber: 'X',
        expiryDate: '2025-13-40',
        nationality: 'Nigeria',
        firstName: 'Ngozi',
        lastName: 'Obi',
        address: '12 Marina, Lagos',
      });
    const other = await h.ok<Scan>(h.scan(await h.photo()));
    expect(other).toMatchObject({
      fields: {
        nationality: null,
        idType: null,
        idNumber: null,
        idExpiry: null,
        address: '12 Marina, Lagos',
      },
      nameMatchesGuest: false,
      expired: null,
      readable: true,
    });
    h.ai.respond = () => JSON.stringify({ ...JSON.parse(PASSPORT), expiryDate: '2026-11-09' });
    expect(await h.ok<Scan>(h.scan(await h.photo()))).toMatchObject({ expired: true });
  });

  it('says when nothing could be read', async () => {
    const h = await desk();
    h.ai.respond = () => 'This is a picture of a cat.';
    expect(await h.ok<Scan>(h.scan(await h.photo()))).toMatchObject({
      readable: false,
      nameOnId: null,
      nameMatchesGuest: null,
    });
  });

  it('refuses a PDF, a file that is not an ID photo, and a used-up allowance', async () => {
    const h = await desk();
    const pdf = await h.scan(await h.photo('application/pdf'));
    expect(errorOf(pdf).details).toMatchObject({ issues: [{ path: 'body.fileId' }] });
    const { fileId: other } = await h
      .ok<{ fileId: string }>(
        h.fd.send('/files/upload-url', {
          entityType: 'Visitor',
          contentType: 'image/jpeg',
          sizeBytes: 4,
        }),
      )
      .catch(() => ({ fileId: '00000000-0000-4000-8000-000000000000' }));
    expect(errorOf(await h.scan(other)).code).toBe('VALIDATION_ERROR');
    await db.subscription.create({
      data: {
        organisationId: h.org.id,
        plan: 'ESSENTIALS',
        pricePerRoomMinor: 100n,
        minimumMinor: 0n,
        currency: 'NGN',
        status: 'ACTIVE',
        currentPeriodEnd: new Date('2026-11-30T00:00:00Z'),
        // Essentials: no AI allowance (Strategy plan table).
        aiAllowance: 0,
      },
    });
    const usedUp = await h.scan(await h.photo());
    expect(errorOf(usedUp).code).toBe('ALLOWANCE_USED_UP');
    expect(h.ai.requests).toHaveLength(0);
  });
});
