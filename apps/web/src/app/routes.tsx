import type { ComponentType, ReactElement, ReactNode } from 'react';
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
import { AuditLogPage } from '../routes/audit.tsx';
import { SetupWizardPage } from '../routes/onboarding.tsx';
import { UsersAndRolesPage } from '../routes/settings/access.tsx';
import { RatesPage } from '../routes/rates.tsx';
import { FinanceSettingsPage } from '../routes/settings/finance.tsx';
import { RoomsSettingsPage } from '../routes/settings/rooms.tsx';
import { HomeRedirect, NotFoundPage, PlaceholderPage, RouteErrorPage } from '../routes/pages.tsx';
import { NAV_ITEMS, type NavItem } from './navigation.ts';
import { SessionGate } from './session-gate.tsx';

/** Screens that exist; every other navigation path shows its placeholder. */
const SCREENS: Record<string, ReactElement> = {
  '/settings/access': <UsersAndRolesPage />,
  '/settings/rooms': <RoomsSettingsPage />,
  '/settings/finance': <FinanceSettingsPage />,
  '/rates': <RatesPage />,
  '/audit': <AuditLogPage />,
  '/approvals': <ApprovalsPage />,
  '/onboarding': <SetupWizardPage />,
};

/** One route per distinct screen path (tab-style items share their screen's route). */
function screenRoutes(): RouteObject[] {
  const byPath = new Map<string, NavItem>();
  for (const item of NAV_ITEMS) {
    const path = item.path.split('?')[0] as string;
    if (!byPath.has(path)) byPath.set(path, item);
  }
  return [...byPath.entries()].map(([path, item]) => ({
    path: path.replace(/^\//, ''),
    element: SCREENS[path] ?? <PlaceholderPage item={item} />,
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
            ...screenRoutes(),
            { path: '*', element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ];
}

export const routes = buildRoutes();
