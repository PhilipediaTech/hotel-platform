import type { RoomItem, RoomTypeItem } from '@hotel/shared';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../../app/session.ts';
import { Alert } from '../../components/ui/alert.tsx';
import { Button } from '../../components/ui/button.tsx';
import { QrCode } from '../../components/ui/qr-code.tsx';
import { api } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { errorMessage } from '../../lib/form.ts';
import { RoomTypesTab } from './room-types-tab.tsx';
import { RoomsTab } from './rooms-tab.tsx';

// S24 Rooms and room types (PRD M2-01–M2-03; T-031): room types, rooms with their
// out-of-order/out-of-service blocks, and a printable sheet of room QR codes.

export type RoomType = z.output<typeof RoomTypeItem>;
export type Room = z.output<typeof RoomItem>;

export function roomsKey(propertyId: string | null, what: 'types' | 'rooms') {
  return ['rooms', propertyId ?? '', what];
}

export function useRoomData() {
  const { currentPropertyId } = useSession();
  const types = useQuery({
    queryKey: roomsKey(currentPropertyId, 'types'),
    queryFn: async () => (await api.call('listRoomTypes')).data,
  });
  const rooms = useQuery({
    queryKey: roomsKey(currentPropertyId, 'rooms'),
    queryFn: async () => (await api.call('listRooms')).data,
  });
  return { types, rooms };
}

/** Where a scanned room sticker leads: the fault report for that room (T-082). */
export function qrLink(token: string): string {
  return `${window.location.origin}/qr/${token}`;
}

const TABS = ['rooms', 'types', 'qr'] as const;
type Tab = (typeof TABS)[number];

export function RoomsSettingsPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const wanted = search.get('tab') as Tab | null;
  const tab: Tab = wanted && TABS.includes(wanted) ? wanted : 'rooms';

  return (
    <section>
      <h1 className="text-xl font-semibold print:hidden">{t('rooms.title')}</h1>
      <div
        role="tablist"
        aria-label={t('rooms.title')}
        className="mt-4 flex gap-1 border-b border-border print:hidden"
      >
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setSearch({ tab: name })}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              tab === name
                ? 'border-brand font-semibold text-brand-strong'
                : 'border-transparent text-text-muted',
            )}
          >
            {t(`rooms.tabs.${name}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="mt-4 print:mt-0">
        {tab === 'rooms' && <RoomsTab />}
        {tab === 'types' && <RoomTypesTab />}
        {tab === 'qr' && <QrSheet />}
      </div>
    </section>
  );
}

/** One sticker per active room, laid out for A4 printing. */
function QrSheet() {
  const { t } = useTranslation();
  const session = useSession();
  const { types, rooms } = useRoomData();
  const typeName = useMemo(
    () => new Map((types.data ?? []).map((rt) => [rt.id, rt.name])),
    [types.data],
  );
  const error = types.error ?? rooms.error;
  if (error) return <Alert tone="critical">{errorMessage(error)}</Alert>;
  if (!rooms.data || !types.data) {
    return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  }
  const active = rooms.data.filter((r) => r.active);
  if (active.length === 0) return <p className="text-sm text-text-muted">{t('rooms.qr.none')}</p>;
  const property = session.properties.find((p) => p.id === session.currentPropertyId);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3 print:hidden">
        <p className="flex-1 text-sm text-text-muted">{t('rooms.qr.intro')}</p>
        <Button onClick={() => window.print()}>
          <Printer aria-hidden className="mr-2 size-4" />
          {t('rooms.qr.print')}
        </Button>
      </div>
      <ul
        aria-label={t('rooms.qr.sheet')}
        className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 print:grid-cols-3"
      >
        {active.map((room) => (
          <li
            key={room.id}
            className="flex break-inside-avoid flex-col items-center rounded-md border border-border bg-white p-3 text-center text-black"
          >
            <QrCode
              value={qrLink(room.qrToken)}
              label={t('rooms.qr.label', { number: room.number })}
              size={128}
            />
            <p className="mt-2 text-lg font-semibold">{room.number}</p>
            <p className="text-xs">{typeName.get(room.roomTypeId)}</p>
            <p className="mt-1 text-xs">
              {t('rooms.qr.caption', { property: property?.name ?? '' })}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
