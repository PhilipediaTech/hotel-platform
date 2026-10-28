import { FILE_CONTENT_TYPES, type FileContentType, type FileEntityType } from '@hotel/shared';
import { api, type ApiClient } from './api.ts';

// File uploads (tab 2 "Files"; T-023): reserve the file with the API, then send it straight
// to storage with the returned link. The file can be opened once the scan marks it clean
// (usually within a minute); until then the download link answers FILE_NOT_READY.

/** The upload to storage failed; `reason` picks the message to show. */
export class FileUploadError extends Error {
  readonly reason: 'UNSUPPORTED_TYPE' | 'UPLOAD_FAILED';
  readonly status: number | undefined;

  constructor(reason: FileUploadError['reason'], status?: number) {
    super(reason === 'UNSUPPORTED_TYPE' ? 'This type of file is not accepted.' : 'Upload failed.');
    this.name = 'FileUploadError';
    this.reason = reason;
    this.status = status;
  }
}

const isAccepted = (type: string): type is FileContentType =>
  (FILE_CONTENT_TYPES as readonly string[]).includes(type);

/** Uploads `file` for a record of `entityType` and returns its file ID. */
export async function uploadFile(
  entityType: FileEntityType,
  file: File,
  options: { signal?: AbortSignal; client?: ApiClient; fetch?: typeof fetch } = {},
): Promise<string> {
  const client = options.client ?? api;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  if (!isAccepted(file.type)) throw new FileUploadError('UNSUPPORTED_TYPE');
  // API errors (permission, type or size of this kind) reach the caller as ApiError.
  const link = await client.call(
    'createFileUploadUrl',
    { body: { entityType, contentType: file.type, sizeBytes: file.size } },
    options.signal ? { signal: options.signal } : {},
  );
  const response = await doFetch(link.url, {
    method: link.method,
    headers: link.headers,
    body: file,
    // The link carries its own signature; storage never needs the session cookie.
    credentials: 'omit',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new FileUploadError('UPLOAD_FAILED', response.status);
  return link.fileId;
}
