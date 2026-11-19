import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// GitHub Pages serves the site under /<repo>/. The workflow sets BASE_PATH.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: { input: {
      main: fileURLToPath(new URL('./index.html', import.meta.url)),
      azureAuth: fileURLToPath(new URL('./azure-auth.html', import.meta.url)),
    } },
  },
});
