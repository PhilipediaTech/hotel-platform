import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { createQueryClient } from './app/query-client.ts';
import { routes } from './app/routes.tsx';
import { PREVIEW_SESSION, SessionContext } from './app/session.ts';
import './i18n/index.ts';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

const router = createBrowserRouter(routes);
const queryClient = createQueryClient();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* PREVIEW_SESSION is replaced by the signed-in user from T-010/T-013. */}
      <SessionContext value={PREVIEW_SESSION}>
        <RouterProvider router={router} />
      </SessionContext>
    </QueryClientProvider>
  </StrictMode>,
);
