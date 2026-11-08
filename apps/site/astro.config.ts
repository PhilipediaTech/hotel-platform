import { defineConfig } from 'astro/config';
import type { Plugin } from 'vite';

// The guest booking site (S39; T-113). A single static page that reads the hotel from the
// address: hosts send every path to it (public/_redirects), and so does this dev server.
const everyPathIsThePage: Plugin = {
  name: 'every-path-is-the-page',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const asset = path.includes('.') || /^\/(@|src\/|node_modules\/|_astro\/)/.test(path);
      if (!asset) req.url = '/';
      next();
    });
  },
};

export default defineConfig({
  output: 'static',
  server: { port: 4321 },
  devToolbar: { enabled: false },
  build: { inlineStylesheets: 'never' },
  vite: {
    // Scripts stay in their own files so the Content-Security-Policy can stay strict.
    build: { assetsInlineLimit: 0 },
    plugins: [everyPathIsThePage],
    // The repo's hoisted `cookie` is older than the one Astro needs: bundle Astro's own.
    environments: { prerender: { resolve: { noExternal: ['cookie'] } } },
  },
});
