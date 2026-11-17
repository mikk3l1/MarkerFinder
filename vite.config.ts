import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the build works from any GitHub Pages sub-path.
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
