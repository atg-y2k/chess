import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// BASE_PATH is set to "/chess/" by the GitHub Pages workflow.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [preact()],
  build: { target: 'es2022', sourcemap: true },
});
