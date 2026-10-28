import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';
import '../i18n/index.ts';

// findBy*/waitFor wait up to 1 s by default; the web tests run beside the database suites,
// and a busy machine (or CI runner) can take longer to render a routed screen.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});
