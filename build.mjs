import { build } from 'esbuild';

await build({
  entryPoints: { index: 'src/index.ts', lody: 'src/lody.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: 'dist',
  external: ['@openai/codex'],
  // Polyfill `require` for CJS modules bundled into ESM output
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});
