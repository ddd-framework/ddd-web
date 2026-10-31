import { defineConfig } from 'tsup';

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
    clean: true,
    target: 'es2022',
    platform: 'neutral',
    external: ['@reduxjs/toolkit', 'async-mutex'],
  },
  {
    entry: { 'codegen/index': 'src/codegen/index.ts', 'codegen/cli': 'src/codegen/cli.ts' },
    format: ['esm'],
    dts: { entry: { 'codegen/index': 'src/codegen/index.ts' } },
    sourcemap: true,
    target: 'node20',
    platform: 'node',
    banner: { js: '' },
  },
]);
