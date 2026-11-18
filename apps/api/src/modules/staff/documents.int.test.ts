import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import type { FileStore } from '../../core/files.ts';
import { purgeStaffDocuments } from './documents.ts';

// Staff documents (PRD M7-09 "As HR, I store staff documents (contract, guarantor form, ID)
// with restricted access and retention", staff.docs; T-140).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

/** Records what the purge deletes from storage. */
const deleted: string[] = [];
const store = {
  delete: (key: string) => {
    deleted.push(key);
    return Promise.resolve();
  },
} as unknown as FileStore;

beforeEach(async () => {
  deleted.length = 0;
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Doc = { id: string; type: string; scan: string; keptUntil: string | null };
type Upload = { send: (path: string, body?: object) => Promise<{ status: number; body: unknown }> };

async function hotel() {
  const h = await inHouse(db, clock);
  const bisi = await h.ok<{ id: string }>(
    h.gm.send('/staff', {
      name: 'Bisi Cook',
      jobTitle: 'Cook',
      employmentType: 'MONTHLY_SALARY',
      startDate: '2026-01-05',
    }),
  );
  const upload = async (as: Upload = h.gm) =>
    (
      await h.ok<{ fileId: string }>(
        as.send('/files/upload-url', {
          entityType: 'StaffDocument',
          contentType: 'application/pdf',
          sizeBytes: 120_000,
        }),
      )
    ).fileId;
  const file = (type: string, title: string, fileId: string) =>
    h.gm.send(`/staff/${bisi.id}/documents`, { type, title, fileId });
  return { ...h, bisi, upload, file, owner: await h.as(h.owner.id) };
}

describe('staff documents (M7-09)', () => {
  it('keeps documents restricted, and audits every look', async () => {
    const h = await hotel();
    const path = `/staff/${h.bisi.id}/documents`;
    expect((await h.fd.get(path)).status).toBe(403);
    expect(
      (
        await h.fd.send('/files/upload-url', {
          entityType: 'StaffDocument',
          contentType: 'application/pdf',
          sizeBytes: 1000,
        })
      ).status,
    ).toBe(403);

    const fileId = await h.upload();
    const contract = await h.ok<Doc>(h.file('CONTRACT', 'Employment contract', fileId));
    expect(contract).toMatchObject({ type: 'CONTRACT', scan: 'PENDING', keptUntil: null });
    // Filed once; someone else's upload, or an old one, is refused.
    expect(errorOf(await h.file('ID', 'Again', fileId)).code).toBe('VALIDATION_ERROR');
    expect(errorOf(await h.file('ID', 'Theirs', await h.upload(h.owner))).code).toBe(
      'VALIDATION_ERROR',
    );
    const old = await h.upload();
    now = new Date('2026-11-10T09:20:00Z');
    expect(errorOf(await h.file('ID', 'Old', old)).code).toBe('VALIDATION_ERROR');

    // Not through the generic file link; through its own, once the scan passed.
    expect((await h.gm.get(`/files/${fileId}/download-url`)).status).toBe(403);
    const link = `${path}/${contract.id}/download-url`;
    expect(errorOf(await h.gm.get(link)).code).toBe('FILE_NOT_READY');
    await db.fileObject.update({ where: { id: fileId }, data: { scan: 'CLEAN' } });
    const opened = await h.ok<{ url: string }>(h.gm.get(link));
    expect(opened.url).toBeTruthy();
    expect(await db.auditEvent.count({ where: { action: 'staff_document.viewed' } })).toBe(1);

    // Removing deletes the file row too, with an audit entry.
    await h.ok(h.gm.delete(`${path}/${contract.id}`));
    expect(await db.fileObject.count({ where: { id: fileId } })).toBe(0);
    expect(await db.auditEvent.count({ where: { action: 'staff_document.removed' } })).toBe(1);
    expect((await h.ok<{ data: unknown[] }>(h.gm.get(path))).data).toEqual([]);
  });

  it('deletes each type once its retention after the last day has passed', async () => {
    const h = await hotel();
    const path = `/staff/${h.bisi.id}/documents`;
    const contract = await h.ok<Doc>(h.file('CONTRACT', 'Contract', await h.upload()));
    const id = await h.ok<Doc>(h.file('ID', 'National ID', await h.upload()));
    expect(
      errorOf(
        await h.gm.put('/staff-documents/settings', {
          retention: { CONTRACT: 0, GUARANTOR: 72, ID: 12, CERTIFICATE: 24, OTHER: 24 },
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');

    // Nothing is deleted while they work here.
    now = new Date('2030-01-01T09:00:00Z');
    expect(await purgeStaffDocuments(db, store, clock)).toBe(0);

    now = new Date('2026-11-10T09:00:00Z');
    const gm = await h.as(h.gmId);
    await h.ok(gm.patch(`/staff/${h.bisi.id}`, { endDate: '2026-11-01' }));
    const listed = await h.ok<{ data: Doc[] }>(gm.get(path));
    expect(Object.fromEntries(listed.data.map((d) => [d.type, d.keptUntil]))).toEqual({
      CONTRACT: '2032-11-01',
      ID: '2027-11-01',
    });

    now = new Date('2027-11-01T12:00:00Z');
    expect(await purgeStaffDocuments(db, store, clock)).toBe(0); // kept through that day
    now = new Date('2027-11-02T12:00:00Z');
    expect(await purgeStaffDocuments(db, store, clock)).toBe(1);
    const left = await db.staffDocument.findMany();
    expect(left.map((d) => d.id)).toEqual([contract.id]);
    expect(await db.staffDocument.count({ where: { id: id.id } })).toBe(0);
    expect(deleted).toHaveLength(1);
    const purged = await db.auditEvent.findFirstOrThrow({
      where: { action: 'staff_document.purged' },
    });
    expect(purged.actorUserId).toBeNull();

    // A shorter retention takes effect on the next run; bringing them back keeps everything.
    const gm2 = await h.as(h.gmId);
    await h.ok(
      gm2.put('/staff-documents/settings', {
        retention: { CONTRACT: 6, GUARANTOR: 72, ID: 12, CERTIFICATE: 24, OTHER: 24 },
      }),
    );
    await h.ok(gm2.patch(`/staff/${h.bisi.id}`, { endDate: null }));
    expect(await purgeStaffDocuments(db, store, clock)).toBe(0);
    await h.ok(gm2.patch(`/staff/${h.bisi.id}`, { endDate: '2026-11-01' }));
    expect(await purgeStaffDocuments(db, store, clock)).toBe(1);
    expect(await db.staffDocument.count()).toBe(0);
  });
});
