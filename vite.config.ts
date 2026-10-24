import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxy = {
  '/api': {
    target: 'http://localhost:3001',
    // Keep the browser's Host header so the API's same-origin (CSRF) check sees
    // the page's own host, exactly like in production.
    changeOrigin: false,
  },
};

// `vite preview` serves the production build with the same security headers
// (CSP etc.) that Vercel adds, so they can be tested locally before deploying.
// Dev mode skips them: Vite's HMR relies on inline scripts.
const vercel = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as {
  headers: { headers: { key: string; value: string }[] }[];
};
const productionHeaders = Object.fromEntries(
  vercel.headers.flatMap((rule) => rule.headers).map(({ key, value }) => [key, value.replace('; upgrade-insecure-requests', '')])
);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  preview: {
    port: 5173,
    proxy: apiProxy,
    headers: productionHeaders,
  },
});
