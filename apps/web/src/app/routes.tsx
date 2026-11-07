import { lazy, Suspense, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { RouteObject } from 'react-router';
import { AppShell } from '../components/shell/app-shell.tsx';
import {
  ForgotPasswordPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from '../routes/auth/email-and-password.tsx';
import { AuthLayout } from '../routes/auth/layout.tsx';
import { MfaPage } from '../routes/auth/mfa.tsx';
import { PinSwitchPage, SetPinPage } from '../routes/auth/pin.tsx';
import { SignInPage } from '../routes/auth/sign-in.tsx';
import { SignUpPage } from '../routes/auth/sign-up.tsx';
import { AcceptInvitationPage } from '../routes/auth/accept-invitation.tsx';
import { ApprovalsPage } from '../routes/approvals.tsx';
import { CompaniesPage, CompanyProfilePage } from '../routes/companies.tsx';
import { GuestProfilePage, GuestsPage } from '../routes/guests.tsx';
import { ReservationPage, ReservationsPage } from '../routes/reservations.tsx';
import { CalendarPage } from '../routes/calendar.tsx';
import { RegistrationCardPage } from '../routes/check-in.tsx';
import { DayUsePage } from '../routes/day-use.tsx';
import { FrontDeskPage } from '../routes/front-desk.tsx';
import { NewBookingPage } from '../routes/new-booking.tsx';
import { RoomsSettingsPage } from '../routes/settings/rooms.tsx';
import { HomeRedirect, NotFoundPage, PlaceholderPage, RouteErrorPage } from '../routes/pages.tsx';
import { NAV_ITEMS, type NavItem } from './navigation.ts';
import { SessionGate } from './session-gate.tsx';

// Back-office screens load when first opened, so the front desk's first load stays within
// the NFR budget (300 KB gzipped; `npm run size`).
const AuditLogPage = lazy(() =>
  import('../routes/audit.tsx').then((m) => ({ default: m.AuditLogPage })),
);
const SetupWizardPage = lazy(() =>
  import('../routes/onboarding.tsx').then((m) => ({ default: m.SetupWizardPage })),
);
const UsersAndRolesPage = lazy(() =>
  import('../routes/settings/access.tsx').then((m) => ({ default: m.UsersAndRolesPage })),
);
const RatesPage = lazy(() => import('../routes/rates.tsx').then((m) => ({ default: m.RatesPage })));
const FinanceSettingsPage = lazy(() =>
  import('../routes/settings/finance.tsx').then((m) => ({ default: m.FinanceSettingsPage })),
);
const FoliosPage = lazy(() =>
  import('../routes/folios.tsx').then((m) => ({ default: m.FoliosPage })),
);
const FolioPage = lazy(() =>
  import('../routes/folios.tsx').then((m) => ({ default: m.FolioPage })),
);
const ShiftPage = lazy(() => import('../routes/shift.tsx').then((m) => ({ default: m.ShiftPage })));
const NightAuditPage = lazy(() =>
  import('../routes/night-audit.tsx').then((m) => ({ default: m.NightAuditPage })),
);
const HousekeepingPage = lazy(() =>
  import('../routes/housekeeping.tsx').then((m) => ({ default: m.HousekeepingPage })),
);
const MyRoomsPage = lazy(() =>
  import('../routes/housekeeping.tsx').then((m) => ({ default: m.MyRoomsPage })),
);
const TasksPage = lazy(() => import('../routes/tasks.tsx').then((m) => ({ default: m.TasksPage })));
const NewTaskPage = lazy(() =>
  import('../routes/tasks.tsx').then((m) => ({ default: m.NewTaskPage })),
);
const TaskPage = lazy(() => import('../routes/tasks.tsx').then((m) => ({ default: m.TaskPage })));
const QrFaultPage = lazy(() =>
  import('../routes/tasks.tsx').then((m) => ({ default: m.QrFaultPage })),
);
const HandoversPage = lazy(() =>
  import('../routes/handovers.tsx').then((m) => ({ default: m.HandoversPage })),
);
const LeakagePage = lazy(() =>
  import('../routes/leakage.tsx').then((m) => ({ default: m.LeakagePage })),
);
const OwnerHomePage = lazy(() =>
  import('../routes/owner.tsx').then((m) => ({ default: m.OwnerHomePage })),
);
const MessagesPage = lazy(() =>
  import('../routes/messages.tsx').then((m) => ({ default: m.MessagesPage })),
);
const CheckOutPage = lazy(() =>
  import('../routes/check-out.tsx').then((m) => ({ default: m.CheckOutPage })),
);
const ImportsPage = lazy(() =>
  import('../routes/settings/imports.tsx').then((m) => ({ default: m.ImportsPage })),
);

/** Screens that exist; every other navigation path shows its placeholder. */
const SCREENS: Record<string, ReactElement> = {
  '/settings/access': <UsersAndRolesPage />,
  '/settings/rooms': <RoomsSettingsPage />,
  '/settings/finance': <FinanceSettingsPage />,
  '/rates': <RatesPage />,
  '/guests': <GuestsPage />,
  '/companies': <CompaniesPage />,
  '/front-desk': <FrontDeskPage />,
  '/folios': <FoliosPage />,
  '/shift': <ShiftPage />,
  '/night-audit': <NightAuditPage />,
  '/housekeeping': <HousekeepingPage />,
  '/my-rooms': <MyRoomsPage />,
  '/tasks': <TasksPage />,
  '/tasks/new': <NewTaskPage />,
  '/handovers': <HandoversPage />,
  '/leakage': <LeakagePage />,
  '/messages': <MessagesPage />,
  '/owner': <OwnerHomePage />,
  '/reservations': <ReservationsPage />,
  '/calendar': <CalendarPage />,
  '/bookings/new': <NewBookingPage />,
  '/bookings/day-use': <DayUsePage />,
  '/settings/imports': <ImportsPage />,
  '/audit': <AuditLogPage />,
  '/approvals': <ApprovalsPage />,
  '/onboarding': <SetupWizardPage />,
};

function Loading() {
  const { t } = useTranslation();
  return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
}

/** One route per distinct screen path (tab-style items share their screen's route). */
function screenRoutes(): RouteObject[] {
  const byPath = new Map<string, NavItem>();
  for (const item of NAV_ITEMS) {
    const path = item.path.split('?')[0] as string;
    if (!byPath.has(path)) byPath.set(path, item);
  }
  return [...byPath.entries()].map(([path, item]) => ({
    path: path.replace(/^\//, ''),
    element: SCREENS[path] ? (
      <Suspense fallback={<Loading />}>{SCREENS[path]}</Suspense>
    ) : (
      <PlaceholderPage item={item} />
    ),
  }));
}

/**
 * Signed-out screens (S01, S02, email links) beside the signed-in shell. `Gate` loads the
 * session for the shell; component tests pass one that provides a fixed session instead.
 */
export function buildRoutes(
  Gate: ComponentType<{ children: ReactNode }> = SessionGate,
): RouteObject[] {
  return [
    {
      path: '/',
      errorElement: <RouteErrorPage />,
      children: [
        {
          element: <AuthLayout />,
          children: [
            { path: 'sign-in', element: <SignInPage /> },
            { path: 'sign-up', element: <SignUpPage /> },
            { path: 'verify-email', element: <VerifyEmailPage /> },
            { path: 'forgot-password', element: <ForgotPasswordPage /> },
            { path: 'reset-password', element: <ResetPasswordPage /> },
            { path: 'mfa', element: <MfaPage /> },
            { path: 'pin', element: <PinSwitchPage /> },
            { path: 'accept-invitation', element: <AcceptInvitationPage /> },
          ],
        },
        {
          element: (
            <Gate>
              <AppShell />
            </Gate>
          ),
          children: [
            { index: true, element: <HomeRedirect /> },
            { path: 'account/pin', element: <SetPinPage /> },
            { path: 'guests/:guestId', element: <GuestProfilePage /> },
            { path: 'companies/:companyId', element: <CompanyProfilePage /> },
            { path: 'reservations/:reservationId', element: <ReservationPage /> },
            { path: 'stays/:stayId/card', element: <RegistrationCardPage /> },
            {
              path: 'stays/:stayId/check-out',
              element: (
                <Suspense fallback={<Loading />}>
                  <CheckOutPage />
                </Suspense>
              ),
            },
            {
              path: 'tasks/:taskId',
              element: (
                <Suspense fallback={<Loading />}>
                  <TaskPage />
                </Suspense>
              ),
            },
            // S19 is /q/:token (tab 5); the S24 stickers print /qr/<token>, so both open it.
            ...['q/:token', 'qr/:token'].map((path) => ({
              path,
              element: (
                <Suspense fallback={<Loading />}>
                  <QrFaultPage />
                </Suspense>
              ),
            })),
            {
              path: 'folios/:folioId',
              element: (
                <Suspense fallback={<Loading />}>
                  <FolioPage />
                </Suspense>
              ),
            },
            ...screenRoutes(),
            { path: '*', element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ];
}

export const routes = buildRoutes();
