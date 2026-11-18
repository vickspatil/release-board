import { defineConfig } from 'vite';

// GitHub Pages serves the site under /<repo>/. The workflow sets BASE_PATH.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  build: { chunkSizeWarningLimit: 1200 },
});
