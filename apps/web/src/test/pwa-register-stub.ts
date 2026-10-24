// Test stand-in for vite-plugin-pwa's `virtual:pwa-register/react` (aliased in vitest.config.ts).
import { vi } from 'vitest';

export const swState = { needRefresh: false };
export const updateServiceWorker = vi.fn(() => Promise.resolve());

export function useRegisterSW() {
  return {
    needRefresh: [swState.needRefresh, () => undefined] as const,
    offlineReady: [false, () => undefined] as const,
    updateServiceWorker,
  };
}
