import { defineConfig } from 'vite';

export default defineConfig({
  base: '/rubiks-cube/',
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});
