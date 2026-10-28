import { FILE_DOWNLOAD_URL_TTL_SECONDS, FILE_UPLOAD_URL_TTL_SECONDS } from '@hotel/shared';
import { pino } from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeFileScanner, EICAR } from '../../core/file-scan.ts';
import { incomingKey } from '../../core/files.ts';
import { expectViolation, resetDb, SQLSTATE, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { ABANDON_AFTER_MS, scanPendingFiles } from './service.ts';

// Files (tab 2 "Files"; tab 4 row "Files"; T-023): presigned upload → scan → presigned
// download for clean files only, valid 5 minutes. Local file store and fake scanner.

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const logger = pino({ level: 'silent' });

const CSV = Buffer.from('number,type\n101,Deluxe\n102,Standard\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

beforeEach(async () => {
  await resetDb(db);
  now = new Date();
});

async function hotel() {
  const h = await makeHotel(db, now);
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => c.as(await sessionCookie(db, userId));
  const scan = () =>
    scanPendingFiles({ db, store: c.files, scanner: createFakeFileScanner(), clock, logger });
  return { ...h, c, as, scan };
}

type Link = { fileId: string; method: 'PUT'; url: string; headers: Record<string, string> };

async function reserve(
  client: Awaited<ReturnType<Awaited<ReturnType<typeof hotel>>['as']>>,
  body: Buffer,
  contentType = 'text/csv',
  entityType = 'ImportJob',
) {
  const res = await client.post('/files/upload-url', {
    entityType,
    contentType,
    sizeBytes: body.length,
  });
  expect(res.status).toBe(201);
  return res.body as Link & { expiresAt: string };
}

function put(h: Awaited<ReturnType<typeof hotel>>, link: Link, body: Buffer) {
  return request(h.c.app)
    .put(link.url)
    .set('Content-Type', link.headers['Content-Type'] ?? '')
    .send(body);
}

describe('upload link', () => {
  it('reserves a PENDING file and returns a short-lived signed link', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    const link = await reserve(owner, CSV);
    expect(link).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'text/csv' } });
    expect(new Date(link.expiresAt).getTime() - now.getTime()).toBe(
      FILE_UPLOAD_URL_TTL_SECONDS * 1000,
    );
    const file = await db.fileObject.findUniqueOrThrow({ where: { id: link.fileId } });
    expect(file).toMatchObject({
      organisationId: h.org.id,
      propertyId: h.p1.id,
      contentType: 'text/csv',
      sizeBytes: CSV.length,
      scan: 'PENDING',
      entityType: 'ImportJob',
      entityId: null,
      retentionClass: 'STANDARD',
      uploadedById: h.owner.id,
      storageKey: `org/${h.org.id}/property/${h.p1.id}/${link.fileId}`,
    });
    // The link carries no session: storage checks only its signature.
    expect((await put(h, link, CSV)).status).toBe(200);
    expect(await h.c.files.head(incomingKey(file.storageKey))).toEqual({
      sizeBytes: CSV.length,
      contentType: 'text/csv',
    });
  });

  it('needs the permission of the file kind ("per entity")', async () => {
    const h = await hotel();
    const fd = await h.as(h.fd.id);
    const res = await fd.post('/files/upload-url', {
      entityType: 'ImportJob',
      contentType: 'text/csv',
      sizeBytes: 10,
    });
    expect(res.status).toBe(403);
    expect(errorOf(res)).toMatchObject({
      code: 'FORBIDDEN',
      details: { permission: 'import.run' },
    });
    expect(await db.fileObject.count()).toBe(0);
  });

  it('accepts only the types and sizes of the file kind', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    const wrongType = await owner.post('/files/upload-url', {
      entityType: 'ImportJob',
      contentType: 'image/png',
      sizeBytes: 10,
    });
    expect(wrongType.status).toBe(400);
    expect(errorOf(wrongType).details).toMatchObject({
      issues: [{ path: 'body.contentType' }],
    });
    const tooBig = await owner.post('/files/upload-url', {
      entityType: 'RoomType',
      contentType: 'image/png',
      sizeBytes: 5 * 1024 * 1024 + 1,
    });
    expect(tooBig.status).toBe(400);
    expect(errorOf(tooBig).details).toMatchObject({ issues: [{ path: 'body.sizeBytes' }] });
    const unknown = await owner.post('/files/upload-url', {
      entityType: 'Folio',
      contentType: 'application/pdf',
      sizeBytes: 10,
    });
    expect(unknown.status).toBe(400);
    const html = await owner.post('/files/upload-url', {
      entityType: 'RoomType',
      contentType: 'text/html',
      sizeBytes: 10,
    });
    expect(html.status).toBe(400);
    expect(await db.fileObject.count()).toBe(0);
  });

  it('the signed link refuses another type or size than reserved', async () => {
    const h = await hotel();
    const link = await reserve(await h.as(h.owner.id), CSV);
    const longer = Buffer.concat([CSV, Buffer.from('103,Suite\n')]);
    expect((await put(h, link, longer)).status).toBe(403);
    const asHtml = await request(h.c.app).put(link.url).set('Content-Type', 'text/html').send(CSV);
    expect(asHtml.status).toBe(403);
  });
});

describe('scan and download', () => {
  it('only a CLEAN file gets a download link, valid 5 minutes', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    const link = await reserve(owner, CSV);
    await put(h, link, CSV);

    const early = await owner.get(`/files/${link.fileId}/download-url`);
    expect(early.status).toBe(409);
    expect(errorOf(early)).toMatchObject({ code: 'FILE_NOT_READY', details: { scan: 'PENDING' } });

    expect(await h.scan()).toEqual({ clean: 1, blocked: 0, abandoned: 0, waiting: 0 });
    const file = await db.fileObject.findUniqueOrThrow({ where: { id: link.fileId } });
    expect(file.scan).toBe('CLEAN');
    // The upload is moved: only the scanned bytes remain, under the storage key.
    expect(await h.c.files.head(incomingKey(file.storageKey))).toBeNull();

    const res = await owner.get(`/files/${link.fileId}/download-url`);
    expect(res.status).toBe(200);
    const body = res.body as { url: string; expiresAt: string };
    expect(res.body).toMatchObject({ contentType: 'text/csv', sizeBytes: CSV.length });
    expect(new Date(body.expiresAt).getTime() - now.getTime()).toBe(
      FILE_DOWNLOAD_URL_TTL_SECONDS * 1000,
    );
    const download = await request(h.c.app).get(body.url).buffer(true);
    expect(download.status).toBe(200);
    expect(download.text).toBe(CSV.toString());

    now = new Date(now.getTime() + FILE_DOWNLOAD_URL_TTL_SECONDS * 1000);
    expect((await request(h.c.app).get(body.url)).status).toBe(403);
  });

  it('blocks malware: INFECTED, never downloadable, audited', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    const infected = Buffer.from(`number,type\n${EICAR}\n`);
    const link = await reserve(owner, infected);
    await put(h, link, infected);

    expect(await h.scan()).toMatchObject({ clean: 0, blocked: 1 });
    const file = await db.fileObject.findUniqueOrThrow({ where: { id: link.fileId } });
    expect(file.scan).toBe('INFECTED');
    expect(await h.c.files.head(incomingKey(file.storageKey))).toBeNull();
    expect(await h.c.files.head(file.storageKey)).toBeNull();

    const res = await owner.get(`/files/${link.fileId}/download-url`);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: 'FILE_NOT_READY', details: { scan: 'INFECTED' } });

    const [event] = await db.auditEvent.findMany({ where: { action: 'file.blocked' } });
    expect(event).toMatchObject({
      organisationId: h.org.id,
      propertyId: h.p1.id,
      actorType: 'SYSTEM',
      actorUserId: null,
      entityType: 'file',
      entityId: link.fileId,
      reason: 'MALWARE',
      after: { scan: 'INFECTED', reason: 'MALWARE', signature: 'EICAR-Test-File' },
    });
  });

  it('blocks a file whose content is not its declared type', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    const fake = Buffer.from('<svg onload="alert(1)">!'.padEnd(PNG.length, ' '));
    const link = await reserve(owner, fake, 'image/png', 'RoomType');
    await put(h, link, fake);
    expect(await h.scan()).toMatchObject({ blocked: 1 });
    const [event] = await db.auditEvent.findMany({ where: { action: 'file.blocked' } });
    expect(event?.reason).toBe('TYPE_MISMATCH');
  });

  it('serves the scanned bytes even if the link is used again after the scan', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    const link = await reserve(owner, CSV);
    await put(h, link, CSV);
    await h.scan();
    const swapped = Buffer.from(EICAR.slice(0, CSV.length).padEnd(CSV.length, 'x'));
    expect((await put(h, link, swapped)).status).toBe(200);

    expect(await h.scan()).toEqual({ clean: 0, blocked: 0, abandoned: 0, waiting: 0 });
    const res = await owner.get(`/files/${link.fileId}/download-url`);
    const download = await request(h.c.app)
      .get((res.body as { url: string }).url)
      .buffer(true);
    expect(download.text).toBe(CSV.toString());
  });

  it('waits for uploads in progress and gives up on links never used', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    const link = await reserve(owner, CSV);
    expect(await h.scan()).toEqual({ clean: 0, blocked: 0, abandoned: 0, waiting: 1 });
    now = new Date(now.getTime() + ABANDON_AFTER_MS - 1000);
    expect(await h.scan()).toMatchObject({ waiting: 1 });
    now = new Date(now.getTime() + 2000);
    expect(await h.scan()).toMatchObject({ abandoned: 1, waiting: 0 });
    expect(await db.fileObject.findUnique({ where: { id: link.fileId } })).toBeNull();
  });

  it('two scans at once scan each file once', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    for (let i = 0; i < 3; i += 1) {
      const link = await reserve(owner, CSV);
      await put(h, link, CSV);
    }
    const [a, b] = await Promise.all([h.scan(), h.scan()]);
    expect((a?.clean ?? 0) + (b?.clean ?? 0)).toBe(3);
    expect(await db.fileObject.count({ where: { scan: 'CLEAN' } })).toBe(3);
  });
});

describe('download permissions', () => {
  it('follows the file kind: import files need import.run, room photos any member', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    const csv = await reserve(owner, CSV);
    await put(h, csv, CSV);
    const photo = await reserve(owner, PNG, 'image/png', 'RoomType');
    await put(h, photo, PNG);
    await h.scan();

    const fd = await h.as(h.fd.id);
    const refused = await fd.get(`/files/${csv.fileId}/download-url`);
    expect(refused.status).toBe(403);
    expect(errorOf(refused).details).toEqual({ permission: 'import.run' });
    expect((await fd.get(`/files/${photo.fileId}/download-url`)).status).toBe(200);
  });

  it("another property's file is not found, even in the same organisation", async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    const link = await reserve(owner, PNG, 'image/png', 'RoomType');
    await put(h, link, PNG);
    await h.scan();
    const atP2 = hotelClient(db, clock, h.p2.id).as(await sessionCookie(db, h.owner.id));
    const res = await atP2.get(`/files/${link.fileId}/download-url`);
    expect(res.status).toBe(404);
  });
});

describe('files table', () => {
  async function row(data: Record<string, unknown> = {}) {
    const h = await makeHotel(db, now);
    const id = crypto.randomUUID();
    return db.fileObject.create({
      data: {
        id,
        organisationId: h.org.id,
        propertyId: h.p1.id,
        storageKey: `k/${id}`,
        contentType: 'text/csv',
        sizeBytes: 10,
        entityType: 'ImportJob',
        uploadedById: h.owner.id,
        ...data,
      },
    });
  }

  it('checks size, type, retention class and entity link', async () => {
    await expectViolation(row({ sizeBytes: 0 }), SQLSTATE.CHECK, 'files_size_check');
    await resetDb(db);
    await expectViolation(row({ sizeBytes: 26_214_401 }), SQLSTATE.CHECK, 'files_size_check');
    await resetDb(db);
    await expectViolation(
      row({ contentType: 'text/csv; charset=x' }),
      SQLSTATE.CHECK,
      'files_content_type_check',
    );
    await resetDb(db);
    await expectViolation(
      row({ retentionClass: 'FOREVER' }),
      SQLSTATE.CHECK,
      'files_retention_class_check',
    );
    await resetDb(db);
    await expectViolation(
      row({ entityType: null, entityId: 'x' }),
      SQLSTATE.CHECK,
      'files_entity_check',
    );
  });

  it("can't point at another organisation's property", async () => {
    const other = await makeHotel(db, now);
    await expectViolation(
      row({ propertyId: other.p1.id }),
      SQLSTATE.FOREIGN_KEY,
      'files_organisation_id_property_id_fkey',
    );
  });
});
