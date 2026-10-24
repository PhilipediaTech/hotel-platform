import type { RouteObject } from 'react-router';
import { AppShell } from '../components/shell/app-shell.tsx';
import { HomeRedirect, NotFoundPage, PlaceholderPage, RouteErrorPage } from '../routes/pages.tsx';
import { NAV_ITEMS, type NavItem } from './navigation.ts';

/** One placeholder route per distinct screen path (tab-style items share their screen's route). */
function screenRoutes(): RouteObject[] {
  const byPath = new Map<string, NavItem>();
  for (const item of NAV_ITEMS) {
    const path = item.path.split('?')[0] as string;
    if (!byPath.has(path)) byPath.set(path, item);
  }
  return [...byPath.entries()].map(([path, item]) => ({
    path: path.replace(/^\//, ''),
    element: <PlaceholderPage item={item} />,
  }));
}

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <HomeRedirect /> },
      ...screenRoutes(),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
