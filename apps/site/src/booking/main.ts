import { createApi } from './api.ts';
import { mount } from './app.ts';

const root = document.getElementById('app');
if (root) {
  mount(root, {
    path: window.location.pathname,
    search: window.location.search,
    origin: window.location.origin,
    framed: window.top !== window.self,
    api: createApi(import.meta.env.PUBLIC_API_ORIGIN ?? 'http://localhost:4000'),
    navigate: (url) => {
      window.location.assign(url);
    },
  });
}
