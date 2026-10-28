import { RoomTypeBody, RoomTypePatchBody } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../../app/session.ts';
import { Alert } from '../../components/ui/alert.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Label } from '../../components/ui/label.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { errorMessage } from '../../lib/form.ts';
import { FileUploadError, uploadFile } from '../../lib/files.ts';
import { Field } from '../auth/layout.tsx';
import {
  fieldErrorsOf,
  validated,
  labelsFrom,
  labelsText,
  serverErrors,
  type FieldErrors,
} from './room-form.ts';
import { roomsKey, useRoomData, type RoomType } from './rooms.tsx';

// S24 "Room types" tab (PRD M2-01): code, name, occupancy, amenities, photos, description.

interface Draft {
  code: string;
  name: string;
  baseOccupancy: string;
  maxOccupancy: string;
  description: string;
  amenities: string;
  photoFileIds: string[];
  sortOrder: string;
  active: boolean;
}

const EMPTY: Draft = {
  code: '',
  name: '',
  baseOccupancy: '2',
  maxOccupancy: '2',
  description: '',
  amenities: '',
  photoFileIds: [],
  sortOrder: '0',
  active: true,
};

const toDraft = (t: RoomType): Draft => ({
  code: t.code,
  name: t.name,
  baseOccupancy: String(t.baseOccupancy),
  maxOccupancy: String(t.maxOccupancy),
  description: t.description ?? '',
  amenities: labelsText(t.amenities),
  photoFileIds: t.photoFileIds,
  sortOrder: String(t.sortOrder),
  active: t.active,
});

const payload = (d: Draft) => ({
  code: d.code,
  name: d.name,
  baseOccupancy: Number(d.baseOccupancy),
  maxOccupancy: Number(d.maxOccupancy),
  description: d.description,
  amenities: labelsFrom(d.amenities),
  photoFileIds: d.photoFileIds,
  sortOrder: Number(d.sortOrder),
});

export function RoomTypesTab() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const canEdit = permissions.includes('roomtype.manage');
  const { types } = useRoomData();
  // null = no form; 'new' = adding; otherwise the type being edited.
  const [editing, setEditing] = useState<RoomType | 'new' | null>(null);

  if (types.error) return <Alert tone="critical">{errorMessage(types.error)}</Alert>;
  if (!types.data) return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;

  return (
    <div>
      {types.data.length === 0 ? (
        <p className="mb-4 text-sm text-text-muted">{t('rooms.types.none')}</p>
      ) : (
        <div className="mb-4 overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-text-muted">
              <tr>
                <th className="p-2 font-medium">{t('rooms.types.code')}</th>
                <th className="p-2 font-medium">{t('rooms.types.name')}</th>
                <th className="p-2 font-medium">{t('rooms.types.occupancy')}</th>
                <th className="p-2 font-medium">{t('rooms.types.rooms')}</th>
                <th className="p-2 font-medium">
                  <span className="sr-only">{t('rooms.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {types.data.map((type) => (
                <tr key={type.id} className="border-b border-border last:border-0">
                  <td className="p-2 font-mono">{type.code}</td>
                  <td className="p-2">
                    {type.name}
                    {!type.active && (
                      <span className="ml-2 text-xs text-text-muted">{t('rooms.inactive')}</span>
                    )}
                  </td>
                  <td className="p-2">
                    {t('rooms.types.occupancyValue', {
                      base: type.baseOccupancy,
                      max: type.maxOccupancy,
                    })}
                  </td>
                  <td className="p-2">{type.roomCount}</td>
                  <td className="p-2 text-right">
                    {canEdit && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('rooms.types.editNamed', { name: type.name })}
                        onClick={() => setEditing(type)}
                      >
                        {t('rooms.edit')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canEdit && editing === null && (
        <Button onClick={() => setEditing('new')}>{t('rooms.types.add')}</Button>
      )}
      {editing !== null && (
        <RoomTypeForm
          key={editing === 'new' ? 'new' : editing.id}
          type={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function RoomTypeForm({ type, onDone }: { type: RoomType | null; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  const [draft, setDraft] = useState<Draft>(type ? toDraft(type) : EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = (field: keyof Draft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [field]: e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      if (type) {
        const data = validated(RoomTypePatchBody, { ...payload(draft), active: draft.active });
        return api.call('updateRoomType', { params: { roomTypeId: type.id }, body: data });
      }
      const data = validated(RoomTypeBody, payload(draft));
      return api.call('createRoomType', { body: data });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rooms', currentPropertyId ?? ''] });
      // The setup checklist counts room types.
      void queryClient.invalidateQueries({ queryKey: ['setup', currentPropertyId ?? ''] });
      onDone();
    },
    onError: (error) => setErrors(fieldErrorsOf(error)),
  });
  const formError =
    save.error instanceof ApiError && Object.keys(serverErrors(save.error)).length === 0
      ? errorMessage(save.error)
      : null;

  return (
    <form
      noValidate
      aria-label={type ? t('rooms.types.editNamed', { name: type.name }) : t('rooms.types.add')}
      className="mt-2 max-w-2xl rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setErrors({});
        save.mutate();
      }}
    >
      <h2 className="mb-3 font-semibold">
        {type ? t('rooms.types.editNamed', { name: type.name }) : t('rooms.types.add')}
      </h2>
      <div className="grid gap-x-4 sm:grid-cols-[8rem_1fr]">
        <Field
          label={t('rooms.types.code')}
          hint={t('rooms.types.codeHint')}
          value={draft.code}
          onChange={set('code')}
          error={errors['code']}
        />
        <Field
          label={t('rooms.types.name')}
          value={draft.name}
          onChange={set('name')}
          error={errors['name']}
        />
      </div>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <Field
          label={t('rooms.types.base')}
          inputMode="numeric"
          value={draft.baseOccupancy}
          onChange={set('baseOccupancy')}
          error={errors['baseOccupancy']}
        />
        <Field
          label={t('rooms.types.max')}
          inputMode="numeric"
          value={draft.maxOccupancy}
          onChange={set('maxOccupancy')}
          error={errors['maxOccupancy']}
        />
        <Field
          label={t('rooms.types.sortOrder')}
          inputMode="numeric"
          value={draft.sortOrder}
          onChange={set('sortOrder')}
          error={errors['sortOrder']}
        />
      </div>
      <Field
        label={t('rooms.types.amenities')}
        hint={t('rooms.commaHint')}
        value={draft.amenities}
        onChange={set('amenities')}
        error={errors['amenities']}
      />
      <div className="mb-4 flex flex-col gap-1">
        <Label htmlFor="room-type-description">{t('rooms.types.description')}</Label>
        <textarea
          id="room-type-description"
          rows={3}
          className="rounded-md border border-border bg-surface p-2 text-sm"
          value={draft.description}
          onChange={set('description')}
        />
        {errors['description'] && <p className="text-sm text-critical">{errors['description']}</p>}
      </div>
      <Photos
        ids={draft.photoFileIds}
        error={errors['photoFileIds']}
        onChange={(photoFileIds) => setDraft((d) => ({ ...d, photoFileIds }))}
      />
      {type && (
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))}
          />
          {t('rooms.types.active')}
        </label>
      )}
      {formError && (
        <Alert tone="critical" className="mb-3">
          {formError}
        </Alert>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {t('rooms.save')}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          {t('rooms.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Photo list: upload (scanned before it shows), preview, remove. */
function Photos({
  ids,
  error,
  onChange,
}: {
  ids: string[];
  error: string | undefined;
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => uploadFile('RoomType', file),
    onSuccess: (id) => onChange([...ids, id]),
    onError: (err) =>
      setUploadError(
        err instanceof FileUploadError && err.reason === 'UNSUPPORTED_TYPE'
          ? t('rooms.types.photoType')
          : errorMessage(err),
      ),
  });
  return (
    <fieldset className="mb-4">
      <legend className="mb-1 text-sm font-medium">{t('rooms.types.photos')}</legend>
      <ul className="flex flex-wrap gap-2">
        {ids.map((id, i) => (
          <li key={id} className="relative">
            <Photo fileId={id} alt={t('rooms.types.photoAlt', { n: i + 1 })} />
            <button
              type="button"
              aria-label={t('rooms.types.removePhoto', { n: i + 1 })}
              className="absolute right-1 top-1 rounded-full bg-surface p-0.5 shadow"
              onClick={() => onChange(ids.filter((x) => x !== id))}
            >
              <X aria-hidden className="size-3" />
            </button>
          </li>
        ))}
        {ids.length < 10 && (
          <li>
            <label className="flex size-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-xs text-text-muted">
              <ImagePlus aria-hidden className="size-5" />
              {upload.isPending ? t('rooms.types.uploading') : t('rooms.types.addPhoto')}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                disabled={upload.isPending}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  setUploadError(null);
                  if (file) upload.mutate(file);
                }}
              />
            </label>
          </li>
        )}
      </ul>
      {(uploadError ?? error) && (
        <p className="mt-1 text-sm text-critical">{uploadError ?? error}</p>
      )}
    </fieldset>
  );
}

/** A photo once the scan has passed it; "Checking…" until then. */
function Photo({ fileId, alt }: { fileId: string; alt: string }) {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const link = useQuery({
    queryKey: [...roomsKey(currentPropertyId, 'types'), 'photo', fileId],
    queryFn: () => api.call('getFileDownloadUrl', { params: { fileId } }),
    // Not scanned yet: try again shortly. Links last 5 minutes; fetch a new one before then.
    retry: (count, err) =>
      err instanceof ApiError &&
      err.code === 'FILE_NOT_READY' &&
      err.details?.['scan'] === 'PENDING'
        ? count < 30
        : false,
    retryDelay: 5000,
    staleTime: 4 * 60_000,
  });
  if (link.data) {
    return <img src={link.data.url} alt={alt} className="size-24 rounded-md object-cover" />;
  }
  const blocked = link.error instanceof ApiError && link.error.details?.['scan'] === 'INFECTED';
  return (
    <div className="flex size-24 items-center justify-center rounded-md bg-surface-muted p-1 text-center text-xs text-text-muted">
      {blocked ? t('rooms.types.photoBlocked') : t('rooms.types.photoChecking')}
    </div>
  );
}
