import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import express, { type Router } from 'express';
import type { Clock } from './clock.ts';

// FileStore interface (tab 2 "Files" and "Integrations", ADR-013; T-023): Cloudflare R2
// through presigned URLs in production, a private bucket. The R2 adapter arrives with the
// Cloudflare account; until then the local store below stands in for it in tests and local
// development, with the same flow: the API signs a short-lived link, the browser sends the
// file straight to it, and the worker reads the object back to scan it.

export interface PresignedRequest {
  method: 'PUT' | 'GET';
  url: string;
  /** Headers the caller must send with the request (they are part of the signature). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface StoredObjectInfo {
  sizeBytes: number;
  contentType: string;
}

export interface FileStore {
  /** A link to upload exactly `sizeBytes` of `contentType` to `key`. */
  presignUpload(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresInSeconds: number;
  }): Promise<PresignedRequest>;
  /** A link to download `key`, served as an attachment. */
  presignDownload(input: {
    key: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<PresignedRequest>;
  /** Null when nothing was uploaded to `key`. */
  head(key: string): Promise<StoredObjectInfo | null>;
  read(key: string): Promise<Buffer>;
  /** Writes an object directly (the worker stores the scanned bytes). */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Keys are made by the API from IDs only: `org/<uuid>/property/<uuid>/<uuid>`. */
const KEY = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

export function fileStorageKey(organisationId: string, propertyId: string, fileId: string): string {
  return `org/${organisationId}/property/${propertyId}/${fileId}`;
}

/**
 * Where the browser uploads a file. The scan job reads it from here and writes the scanned
 * bytes to the file's storage key, so nothing sent with the upload link after the scan can
 * reach a download. Objects left under `incoming/` are removed by a bucket lifecycle rule.
 */
export function incomingKey(storageKey: string): string {
  return `incoming/${storageKey}`;
}

// ---------------------------------------------------------------------------------------
// Local store (fake). Files live in a directory shared by the API and the worker; the API
// serves the signed links itself under LOCAL_FILES_PATH. Never used in production.

export const LOCAL_FILES_PATH = '/api/v1/local-files';

interface LinkClaims {
  /** Storage key. */
  k: string;
  o: 'put' | 'get';
  /** Expiry, epoch milliseconds. */
  e: number;
  /** Content type. */
  t: string;
  /** Exact size for uploads. */
  n?: number;
}

export interface LocalFileStore extends FileStore {
  /** Serves the signed links; mount at LOCAL_FILES_PATH. */
  router(): Router;
}

export function createLocalFileStore(options: {
  dir: string;
  secret: string;
  clock: Clock;
}): LocalFileStore {
  const { dir, secret, clock } = options;

  const sign = (payload: string) =>
    createHmac('sha256', secret).update(`local-file:${payload}`).digest('base64url');

  function link(claims: LinkClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${LOCAL_FILES_PATH}/${payload}.${sign(payload)}`;
  }

  /** The claims of a valid, unexpired link for `op`, or null. */
  function verify(token: string, op: LinkClaims['o']): LinkClaims | null {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as LinkClaims;
    if (claims.o !== op || claims.e <= clock().getTime() || !KEY.test(claims.k)) return null;
    return claims;
  }

  function pathOf(key: string): string {
    if (!KEY.test(key)) throw new Error(`Invalid storage key: ${key}`);
    return path.join(dir, ...key.split('/'));
  }

  const metaPath = (key: string) => `${pathOf(key)}.meta.json`;

  const store: LocalFileStore = {
    presignUpload({ key, contentType, sizeBytes, expiresInSeconds }) {
      const expiresAt = new Date(clock().getTime() + expiresInSeconds * 1000);
      const url = link({ k: key, o: 'put', e: expiresAt.getTime(), t: contentType, n: sizeBytes });
      return Promise.resolve({
        method: 'PUT',
        url,
        headers: { 'Content-Type': contentType },
        expiresAt,
      });
    },
    presignDownload({ key, contentType, expiresInSeconds }) {
      const expiresAt = new Date(clock().getTime() + expiresInSeconds * 1000);
      const url = link({ k: key, o: 'get', e: expiresAt.getTime(), t: contentType });
      return Promise.resolve({ method: 'GET', url, headers: {}, expiresAt });
    },
    async head(key) {
      try {
        const [info, meta] = await Promise.all([
          stat(pathOf(key)),
          readFile(metaPath(key), 'utf8'),
        ]);
        return {
          sizeBytes: info.size,
          contentType: (JSON.parse(meta) as StoredObjectInfo).contentType,
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async read(key) {
      return readFile(pathOf(key));
    },
    async put(key, body, contentType) {
      await mkdir(path.dirname(pathOf(key)), { recursive: true });
      await writeFile(metaPath(key), JSON.stringify({ contentType }));
      await writeFile(pathOf(key), body);
    },
    async delete(key) {
      await Promise.all([rm(pathOf(key), { force: true }), rm(metaPath(key), { force: true })]);
    },
    router() {
      const router = express.Router();

      router.put('/:token', async (req, res) => {
        const claims = verify(req.params.token, 'put');
        if (!claims) return void res.status(403).type('text').send('Link invalid or expired');
        if (req.get('content-type') !== claims.t) {
          return void res.status(403).type('text').send('Content-Type does not match the link');
        }
        const declared = Number(req.get('content-length'));
        if (req.get('content-length') !== undefined && declared !== claims.n) {
          return void res.status(403).type('text').send('Size does not match the link');
        }
        const target = pathOf(claims.k);
        const partial = `${target}.${randomUUID()}.part`;
        await mkdir(path.dirname(target), { recursive: true });
        let received = 0;
        const limit = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            received += chunk.length;
            done(received > (claims.n ?? 0) ? new Error('Too large') : null, chunk);
          },
        });
        try {
          await pipeline(req, limit, createWriteStream(partial));
        } catch {
          await rm(partial, { force: true });
          return void res.status(400).type('text').send('Upload failed or too large');
        }
        if (received !== claims.n) {
          await rm(partial, { force: true });
          return void res.status(400).type('text').send('Size does not match the link');
        }
        await writeFile(metaPath(claims.k), JSON.stringify({ contentType: claims.t }));
        await rename(partial, target);
        res.status(200).end();
      });

      router.get('/:token', async (req, res) => {
        const claims = verify(req.params.token, 'get');
        if (!claims) return void res.status(403).type('text').send('Link invalid or expired');
        let body: Buffer;
        try {
          body = await readFile(pathOf(claims.k));
        } catch {
          return void res.status(404).type('text').send('Not found');
        }
        res
          .status(200)
          .set({
            'Content-Type': claims.t,
            'Content-Disposition': 'attachment',
            'Cache-Control': 'private, max-age=60',
            'X-Content-Type-Options': 'nosniff',
          })
          .send(body);
      });

      return router;
    },
  };
  return store;
}
