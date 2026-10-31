import { defineConfig } from 'tsup';

// The configs run in parallel and share `dist`: none of them may clean it (one config's clean can delete what the other
// has already written). `pnpm build` removes `dist` once before tsup starts (scripts/clean.mjs).

export default defineConfig([
  {
    entry: {
      'contract/index': 'src/contract/index.ts',
      'query/index': 'src/query/index.ts',
      'api/index': 'src/api/index.ts',
      'auth/index': 'src/auth/index.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: false,
    target: 'es2022',
    platform: 'neutral',
    external: ['@reduxjs/toolkit'],
  },
  {
    entry: { 'codegen/index': 'src/codegen/index.ts', 'codegen/cli': 'src/codegen/cli.ts' },
    format: ['esm'],
    dts: { entry: { 'codegen/index': 'src/codegen/index.ts' } },
    sourcemap: true,
    clean: false,
    target: 'node20',
    platform: 'node',
    banner: { js: '' },
  },
]);
