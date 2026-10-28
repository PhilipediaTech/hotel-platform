import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createLocalFileStore,
  fileStorageKey,
  incomingKey,
  LOCAL_FILES_PATH,
  type LocalFileStore,
} from './files.ts';

// The local file store: the fake behind the FileStore interface (ADR-013), with signed,
// expiring upload and download links like R2's presigned URLs.

const KEY = fileStorageKey(
  '11111111-0000-4000-8000-000000000001',
  '22222222-0000-4000-8000-000000000002',
  '33333333-0000-4000-8000-000000000003',
);
const BODY = Buffer.from('room,type\n101,Deluxe\n');

let now: Date;
let store: LocalFileStore;
let app: express.Express;

beforeEach(() => {
  now = new Date('2026-10-28T10:00:00Z');
  store = createLocalFileStore({
    dir: mkdtempSync(path.join(os.tmpdir(), 'hotel-files-unit-')),
    secret: 'unit-test-secret',
    clock: () => now,
  });
  app = express();
  app.use(LOCAL_FILES_PATH, store.router());
});

const uploadLink = (sizeBytes = BODY.length) =>
  store.presignUpload({ key: KEY, contentType: 'text/csv', sizeBytes, expiresInSeconds: 900 });

describe('local file store', () => {
  it('uploads through a signed link and reads the object back', async () => {
    const link = await uploadLink();
    expect(link).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'text/csv' } });
    expect(link.expiresAt).toEqual(new Date('2026-10-28T10:15:00Z'));
    expect(await store.head(KEY)).toBeNull();

    await request(app).put(link.url).set('Content-Type', 'text/csv').send(BODY).expect(200);
    expect(await store.head(KEY)).toEqual({ sizeBytes: BODY.length, contentType: 'text/csv' });
    expect((await store.read(KEY)).equals(BODY)).toBe(true);
  });

  it('refuses tampered, expired or download-only links', async () => {
    const link = await uploadLink();
    const tampered = link.url.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    await request(app).put(tampered).set('Content-Type', 'text/csv').send(BODY).expect(403);

    const download = await store.presignDownload({
      key: KEY,
      contentType: 'text/csv',
      expiresInSeconds: 300,
    });
    await request(app).put(download.url).set('Content-Type', 'text/csv').send(BODY).expect(403);

    now = new Date('2026-10-28T10:15:00Z');
    await request(app).put(link.url).set('Content-Type', 'text/csv').send(BODY).expect(403);
    expect(await store.head(KEY)).toBeNull();
  });

  it('accepts only the signed content type and exact size', async () => {
    const link = await uploadLink();
    await request(app).put(link.url).set('Content-Type', 'text/html').send(BODY).expect(403);
    const short = await uploadLink(BODY.length - 1);
    await request(app).put(short.url).set('Content-Type', 'text/csv').send(BODY).expect(403);
    const long = await uploadLink(BODY.length + 1);
    await request(app).put(long.url).set('Content-Type', 'text/csv').send(BODY).expect(403);
    expect(await store.head(KEY)).toBeNull();
  });

  it('serves downloads as attachments until the link expires', async () => {
    await store.put(KEY, BODY, 'text/csv');
    const link = await store.presignDownload({
      key: KEY,
      contentType: 'text/csv',
      expiresInSeconds: 300,
    });
    const res = await request(app).get(link.url).buffer(true).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(res.text).equals(BODY)).toBe(true);

    now = new Date('2026-10-28T10:05:00Z');
    await request(app).get(link.url).expect(403);
  });

  it('deletes objects and keeps keys inside its directory', async () => {
    await store.put(incomingKey(KEY), BODY, 'text/csv');
    await store.delete(incomingKey(KEY));
    expect(await store.head(incomingKey(KEY))).toBeNull();
    await expect(store.read('../outside')).rejects.toThrow(/Invalid storage key/);
  });
});
