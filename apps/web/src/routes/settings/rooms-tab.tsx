import {
  addDays,
  BLOCK_KINDS,
  localDate,
  RoomBlockBody,
  RoomBody,
  RoomPatchBody,
} from '@hotel/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../../app/session.ts';
import { Alert } from '../../components/ui/alert.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Label } from '../../components/ui/label.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { errorMessage } from '../../lib/form.ts';
import { Field } from '../auth/layout.tsx';
import {
  fieldErrorsOf,
  validated,
  labelsFrom,
  labelsText,
  serverErrors,
  shortDate,
  type FieldErrors,
} from './room-form.ts';
import { useRoomData, type Room, type RoomType } from './rooms.tsx';

// S24 "Rooms" tab (PRD M2-02, M2-03): rooms with type, floor, features and connecting room;
// out-of-order and out-of-service blocks with reason, released early when the room is back.

type Panel = { kind: 'room'; room: Room | null } | { kind: 'block'; room: Room } | null;

function useInvalidateRooms() {
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['rooms', currentPropertyId ?? ''] });
    void queryClient.invalidateQueries({ queryKey: ['setup', currentPropertyId ?? ''] });
  };
}

export function RoomsTab() {
  const { t } = useTranslation();
  const session = useSession();
  const can = (code: string) => session.permissions.includes(code);
  const { types, rooms } = useRoomData();
  const [panel, setPanel] = useState<Panel>(null);

  const error = types.error ?? rooms.error;
  if (error) return <Alert tone="critical">{errorMessage(error)}</Alert>;
  if (!rooms.data || !types.data) {
    return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  }
  const typeOf = new Map(types.data.map((rt) => [rt.id, rt]));
  const numberOf = new Map(rooms.data.map((r) => [r.id, r.number]));
  const locale = session.properties.find((p) => p.id === session.currentPropertyId)?.locale;
  const activeTypes = types.data.filter((rt) => rt.active);

  return (
    <div>
      {rooms.data.length === 0 ? (
        <p className="mb-4 text-sm text-text-muted">
          {activeTypes.length === 0 ? t('rooms.list.needType') : t('rooms.list.none')}
        </p>
      ) : (
        <div className="mb-4 overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-text-muted">
              <tr>
                <th className="p-2 font-medium">{t('rooms.list.number')}</th>
                <th className="p-2 font-medium">{t('rooms.list.type')}</th>
                <th className="p-2 font-medium">{t('rooms.list.floor')}</th>
                <th className="p-2 font-medium">{t('rooms.list.status')}</th>
                <th className="p-2 font-medium">{t('rooms.list.blocks')}</th>
                <th className="p-2 font-medium">
                  <span className="sr-only">{t('rooms.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rooms.data.map((room) => (
                <tr key={room.id} className="border-b border-border align-top last:border-0">
                  <td className="p-2 font-medium">
                    {room.number}
                    {room.connectingRoomId && (
                      <span className="block text-xs font-normal text-text-muted">
                        {t('rooms.list.connects', { number: numberOf.get(room.connectingRoomId) })}
                      </span>
                    )}
                    {!room.active && (
                      <span className="block text-xs font-normal text-text-muted">
                        {t('rooms.inactive')}
                      </span>
                    )}
                  </td>
                  <td className="p-2">{typeOf.get(room.roomTypeId)?.name}</td>
                  <td className="p-2">{[room.building, room.floor].filter(Boolean).join(' · ')}</td>
                  <td className="p-2">{t(`rooms.hk.${room.hkStatus}`)}</td>
                  <td className="p-2">
                    <ul className="flex flex-col gap-1">
                      {room.blocks.map((block) => (
                        <BlockRow
                          key={block.id}
                          block={block}
                          locale={locale ?? 'en-NG'}
                          canRelease={can('room.block')}
                        />
                      ))}
                    </ul>
                  </td>
                  <td className="whitespace-nowrap p-2 text-right">
                    {can('room.manage') && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('rooms.list.editNamed', { number: room.number })}
                        onClick={() => setPanel({ kind: 'room', room })}
                      >
                        {t('rooms.edit')}
                      </Button>
                    )}
                    {can('room.block') && room.active && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('rooms.block.titleNamed', { number: room.number })}
                        onClick={() => setPanel({ kind: 'block', room })}
                      >
                        {t('rooms.block.action')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can('room.manage') && panel === null && activeTypes.length > 0 && (
        <Button onClick={() => setPanel({ kind: 'room', room: null })}>
          {t('rooms.list.add')}
        </Button>
      )}
      {panel?.kind === 'room' && (
        <RoomForm
          key={panel.room?.id ?? 'new'}
          room={panel.room}
          types={types.data}
          rooms={rooms.data}
          onDone={() => setPanel(null)}
        />
      )}
      {panel?.kind === 'block' && (
        <BlockForm key={panel.room.id} room={panel.room} onDone={() => setPanel(null)} />
      )}
    </div>
  );
}

function BlockRow({
  block,
  locale,
  canRelease,
}: {
  block: Room['blocks'][number];
  locale: string;
  canRelease: boolean;
}) {
  const { t } = useTranslation();
  const invalidate = useInvalidateRooms();
  const release = useMutation({
    mutationFn: () => api.call('releaseRoomBlock', { params: { blockId: block.id } }),
    onSuccess: invalidate,
  });
  const range = t('rooms.block.range', {
    from: shortDate(block.startDate, locale),
    back: shortDate(block.endDate, locale),
  });
  return (
    <li className="text-xs">
      <span className="font-medium">{t(`rooms.hk.${block.kind}`)}</span> · {range}
      <span className="block text-text-muted">“{block.reason}”</span>
      {canRelease && (
        <button
          type="button"
          className="text-brand underline disabled:opacity-50"
          disabled={release.isPending}
          onClick={() => release.mutate()}
        >
          {t('rooms.block.release')}
        </button>
      )}
      {release.error && <span className="block text-critical">{errorMessage(release.error)}</span>}
    </li>
  );
}

interface RoomDraft {
  number: string;
  roomTypeId: string;
  floor: string;
  building: string;
  features: string;
  connectingRoomId: string;
  active: boolean;
}

function RoomForm({
  room,
  types,
  rooms,
  onDone,
}: {
  room: Room | null;
  types: RoomType[];
  rooms: Room[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const invalidate = useInvalidateRooms();
  const [draft, setDraft] = useState<RoomDraft>({
    number: room?.number ?? '',
    roomTypeId: room?.roomTypeId ?? types.find((rt) => rt.active)?.id ?? '',
    floor: room?.floor ?? '',
    building: room?.building ?? '',
    features: labelsText(room?.features ?? []),
    connectingRoomId: room?.connectingRoomId ?? '',
    active: room?.active ?? true,
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = (field: keyof RoomDraft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [field]: e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      const fields = {
        number: draft.number,
        roomTypeId: draft.roomTypeId,
        floor: draft.floor,
        building: draft.building,
        features: labelsFrom(draft.features),
        connectingRoomId: draft.connectingRoomId || null,
      };
      if (room) {
        const data = validated(RoomPatchBody, { ...fields, active: draft.active });
        return api.call(
          'updateRoom',
          { params: { roomId: room.id }, body: data },
          { ifMatch: `"${room.version}"` },
        );
      }
      const data = validated(RoomBody, fields);
      return api.call('createRoom', { body: data });
    },
    onSuccess: () => {
      invalidate();
      onDone();
    },
    onError: (error) => setErrors(fieldErrorsOf(error)),
  });
  const formError =
    save.error instanceof ApiError && Object.keys(serverErrors(save.error)).length === 0
      ? errorMessage(save.error)
      : null;
  // Active types, plus the room's own type even if it was deactivated since.
  const typeOptions = types.filter((rt) => rt.active || rt.id === room?.roomTypeId);
  const others = rooms.filter((r) => r.id !== room?.id && r.active);
  const title = room ? t('rooms.list.editNamed', { number: room.number }) : t('rooms.list.add');

  return (
    <form
      noValidate
      aria-label={title}
      className="mt-2 max-w-2xl rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setErrors({});
        save.mutate();
      }}
    >
      <h2 className="mb-3 font-semibold">{title}</h2>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field
          label={t('rooms.list.number')}
          value={draft.number}
          onChange={set('number')}
          error={errors['number']}
        />
        <SelectField
          id="room-type"
          label={t('rooms.list.type')}
          value={draft.roomTypeId}
          onChange={set('roomTypeId')}
          error={errors['roomTypeId']}
          options={typeOptions.map((rt) => ({ value: rt.id, label: `${rt.name} (${rt.code})` }))}
        />
        <Field
          label={t('rooms.list.floor')}
          value={draft.floor}
          onChange={set('floor')}
          error={errors['floor']}
        />
        <Field
          label={t('rooms.list.building')}
          value={draft.building}
          onChange={set('building')}
          error={errors['building']}
        />
      </div>
      <Field
        label={t('rooms.list.features')}
        hint={t('rooms.commaHint')}
        value={draft.features}
        onChange={set('features')}
        error={errors['features']}
      />
      <SelectField
        id="room-connecting"
        label={t('rooms.list.connecting')}
        value={draft.connectingRoomId}
        onChange={set('connectingRoomId')}
        error={errors['connectingRoomId']}
        options={[
          { value: '', label: t('rooms.list.noConnecting') },
          ...others.map((r) => ({ value: r.id, label: r.number })),
        ]}
      />
      {room && (
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))}
          />
          {t('rooms.list.active')}
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

function SelectField({
  id,
  label,
  error,
  options,
  ...props
}: {
  id: string;
  label: string;
  error: string | undefined;
  options: { value: string; label: string }[];
  value: string;
  onChange: (e: { target: { value: string } }) => void;
}) {
  return (
    <div className="mb-4 flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        className="h-10 rounded-md border border-border bg-surface px-3 text-sm"
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <p className="text-sm text-critical">{error}</p>}
    </div>
  );
}

function BlockForm({ room, onDone }: { room: Room; onDone: () => void }) {
  const { t } = useTranslation();
  const session = useSession();
  const invalidate = useInvalidateRooms();
  const timeZone =
    session.properties.find((p) => p.id === session.currentPropertyId)?.timeZone ?? 'Africa/Lagos';
  const today = localDate(new Date(), timeZone);
  const [draft, setDraft] = useState({
    kind: 'OUT_OF_ORDER' as (typeof BLOCK_KINDS)[number],
    startDate: today,
    endDate: addDays(today, 1),
    reason: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: () => {
      const data = validated(RoomBlockBody, { ...draft, roomId: room.id });
      return api.call('createRoomBlock', { body: data });
    },
    onSuccess: () => {
      invalidate();
      onDone();
    },
    onError: (error) => setErrors(fieldErrorsOf(error)),
  });
  const formError =
    save.error instanceof ApiError && Object.keys(serverErrors(save.error)).length === 0
      ? errorMessage(save.error)
      : null;
  const title = t('rooms.block.titleNamed', { number: room.number });

  return (
    <form
      noValidate
      aria-label={title}
      className="mt-2 max-w-2xl rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setErrors({});
        save.mutate();
      }}
    >
      <h2 className="mb-3 font-semibold">{title}</h2>
      <fieldset className="mb-4">
        <legend className="mb-1 text-sm font-medium">{t('rooms.block.kind')}</legend>
        {BLOCK_KINDS.map((kind) => (
          <label key={kind} className="mb-1 flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="block-kind"
              className="mt-1"
              checked={draft.kind === kind}
              onChange={() => setDraft((d) => ({ ...d, kind }))}
            />
            <span>
              {t(`rooms.hk.${kind}`)}
              <span className="block text-xs text-text-muted">{t(`rooms.block.hint.${kind}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field
          label={t('rooms.block.from')}
          type="date"
          min={today}
          value={draft.startDate}
          onChange={(e) => setDraft((d) => ({ ...d, startDate: e.target.value }))}
          error={errors['startDate']}
        />
        <Field
          label={t('rooms.block.back')}
          hint={t('rooms.block.backHint')}
          type="date"
          min={draft.startDate}
          value={draft.endDate}
          onChange={(e) => setDraft((d) => ({ ...d, endDate: e.target.value }))}
          error={errors['endDate']}
        />
      </div>
      <Field
        label={t('rooms.block.reason')}
        value={draft.reason}
        onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))}
        error={errors['reason']}
      />
      {formError && (
        <Alert tone="critical" className="mb-3">
          {formError}
        </Alert>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {t('rooms.block.save')}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          {t('rooms.cancel')}
        </Button>
      </div>
    </form>
  );
}
