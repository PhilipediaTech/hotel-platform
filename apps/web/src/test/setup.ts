import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';
import i18n from '../i18n/index.ts';

// A string the screen asks for and no resource file holds (say, a screen file the module
// forgot to register) fails the test instead of rendering the raw key.
const missingKeys: string[] = [];
i18n.options.saveMissing = true;
i18n.options.missingKeyHandler = (_lngs, _ns, key) => {
  missingKeys.push(key);
};

// findBy*/waitFor wait up to 1 s by default; the web tests run beside the database suites,
// and a busy machine (or CI runner) can take longer to render a routed screen.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  const keys = missingKeys.splice(0);
  if (keys.length) throw new Error(`Missing strings: ${[...new Set(keys)].join(', ')}`);
});
