import { defineConfig, type Plugin } from 'vite';

/** cubejs solve.js does `Cube = this.Cube || require('./cube')`; under Vite ESM `this` is undefined. */
function fixCubejsThis(): Plugin {
  return {
    name: 'fix-cubejs-this',
    transform(code, id) {
      const norm = id.replace(/\\/g, '/');
      if (!norm.includes('/cubejs/') || !norm.includes('/lib/')) return;
      if (!/\bthis\.Cube\b/.test(code)) return;
      return {
        code: code.replace(/\bthis\.Cube\b/g, 'globalThis.Cube'),
        map: null,
      };
    },
  };
}

export default defineConfig({
  // Relative base: works on GitHub Pages subpath AND any host root.
  base: './',
  plugins: [fixCubejsThis()],
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
  // Allow Tunnelmole / other reverse-proxy Host headers during `vite preview`.
  preview: {
    allowedHosts: true,
  },
});
