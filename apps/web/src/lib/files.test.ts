import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './api.ts';
import { FileUploadError, uploadFile } from './files.ts';

const PROPERTY_ID = '0d0d0d0d-0000-4000-8000-000000000002';
const FILE_ID = '3f2b8a4e-7d9a-4b1c-8d3e-4f5a6b7c8d9e';
const LINK = {
  fileId: FILE_ID,
  method: 'PUT',
  url: 'https://storage.example.test/incoming/x?signature=abc',
  headers: { 'Content-Type': 'text/csv' },
  expiresAt: '2026-10-28T10:15:00Z',
};

function setup(storageStatus = 200) {
  const fetch = vi.fn((url: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      (url as string).startsWith('https://storage.')
        ? new Response(null, { status: storageStatus })
        : new Response(JSON.stringify(LINK), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
    ),
  );
  const client = createApiClient({ baseUrl: '/api/v1', propertyId: () => PROPERTY_ID, fetch });
  return { fetch, client };
}

const csv = () => new File(['number,type\n101,Deluxe\n'], 'rooms.csv', { type: 'text/csv' });

describe('uploadFile', () => {
  it('reserves the file, then sends it to the signed link without the session', async () => {
    const { fetch, client } = setup();
    const file = csv();
    expect(await uploadFile('ImportJob', file, { client, fetch })).toBe(FILE_ID);

    const [reserveUrl, reserve] = fetch.mock.calls[0] ?? [];
    expect(reserveUrl).toBe('/api/v1/files/upload-url');
    expect(JSON.parse(reserve?.body as string)).toEqual({
      entityType: 'ImportJob',
      contentType: 'text/csv',
      sizeBytes: file.size,
    });
    expect(new Headers(reserve?.headers).get('X-Property-Id')).toBe(PROPERTY_ID);

    const [uploadUrl, upload] = fetch.mock.calls[1] ?? [];
    expect(uploadUrl).toBe(LINK.url);
    expect(upload).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body: file,
      credentials: 'omit',
    });
  });

  it('refuses unsupported types before calling the API', async () => {
    const { fetch, client } = setup();
    const html = new File(['<html>'], 'page.html', { type: 'text/html' });
    await expect(uploadFile('ImportJob', html, { client, fetch })).rejects.toMatchObject({
      reason: 'UNSUPPORTED_TYPE',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a failed upload to storage', async () => {
    const { fetch, client } = setup(403);
    const err = await uploadFile('ImportJob', csv(), { client, fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileUploadError);
    expect(err).toMatchObject({ reason: 'UPLOAD_FAILED', status: 403 });
  });
});
