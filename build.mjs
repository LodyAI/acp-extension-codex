import { build } from 'esbuild';
import { lazyAcpSchemas } from './scripts/lazy-acp-schemas.mjs';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/index.js',
  external: ['@openai/codex'],
  plugins: [lazyAcpSchemas()],
  // Polyfill `require` for CJS modules bundled into ESM output
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});
