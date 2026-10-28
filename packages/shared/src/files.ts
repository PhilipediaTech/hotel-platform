// File kinds (tab 2 "Files"; tab 4 row "Files", permission "per entity"; T-023). A file is
// uploaded for one kind of record, named by `entityType`: the kind decides who may upload
// and download it, which content types are accepted and how large it may be. Tickets that
// attach files to their records add their kind here (ID documents and signatures T-051,
// task photos T-082).

export const FILE_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

export type FileContentType = (typeof FILE_CONTENT_TYPES)[number];

export interface FileKindDef {
  /** Stored as `files.entity_type`. */
  entityType: string;
  /** Needed to upload; also to download unless `readPermission` says otherwise. */
  permission: string;
  /** Needed to download; null = any member of the property. */
  readPermission?: string | null;
  contentTypes: readonly FileContentType[];
  maxBytes: number;
  retentionClass: 'STANDARD';
}

const MB = 1024 * 1024;
const k = (def: FileKindDef) => def;

export const FILE_KINDS = [
  // Excel/CSV imports (PRD M1-03; T-034).
  k({
    entityType: 'ImportJob',
    permission: 'import.run',
    contentTypes: ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    maxBytes: 10 * MB,
    retentionClass: 'STANDARD',
  }),
  // Room type photos (tab 3 `room_types.photoFileIds`; T-031). Shown to every member.
  k({
    entityType: 'RoomType',
    permission: 'roomtype.manage',
    readPermission: null,
    contentTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxBytes: 5 * MB,
    retentionClass: 'STANDARD',
  }),
] as const;

export const FILE_ENTITY_TYPES = FILE_KINDS.map((kind) => kind.entityType) as [
  (typeof FILE_KINDS)[number]['entityType'],
  ...(typeof FILE_KINDS)[number]['entityType'][],
];

export type FileEntityType = (typeof FILE_ENTITY_TYPES)[number];

export function fileKind(entityType: string): FileKindDef | undefined {
  return FILE_KINDS.find((kind) => kind.entityType === entityType);
}

/** The permission needed to download a file of this kind; null = any member. */
export function fileReadPermission(kind: FileKindDef): string | null {
  return kind.readPermission === undefined ? kind.permission : kind.readPermission;
}

/** Upload links are valid this long; the scan job gives up on files never uploaded. */
export const FILE_UPLOAD_URL_TTL_SECONDS = 15 * 60;
/** Download links (tab 2: "presigned GET URLs valid for 5 minutes"). */
export const FILE_DOWNLOAD_URL_TTL_SECONDS = 5 * 60;
