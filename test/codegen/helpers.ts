import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../../src/codegen/log';
import type { OpenApiDocument } from '../../src/codegen/openapi';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SAMPLE_SPEC = path.join(packageRoot, 'test', 'fixtures', 'specs', 'sample-admin.json');

export function readSample(): OpenApiDocument {
  return JSON.parse(fs.readFileSync(SAMPLE_SPEC, 'utf-8')) as OpenApiDocument;
}

/**
 * The package's own dependencies plus a stand-in for `@mgamadeus/ddd-web/api` (generated binary endpoints import
 * `blobResponseHandler` / `DddFileResponse` from it) that re-exports the source, so tests need no build.
 */
function linkNodeModules(dir: string): void {
  const target = path.join(dir, 'node_modules');
  fs.mkdirSync(target);
  for (const entry of fs.readdirSync(path.join(packageRoot, 'node_modules'))) {
    if (entry.startsWith('.') && entry !== '.bin') continue;
    fs.symlinkSync(path.join(packageRoot, 'node_modules', entry), path.join(target, entry), 'dir');
  }
  const self = path.join(target, '@mgamadeus', 'ddd-web');
  fs.mkdirSync(self, { recursive: true });
  fs.writeFileSync(
    path.join(self, 'package.json'),
    JSON.stringify({ name: '@mgamadeus/ddd-web', type: 'module', exports: { './api': { types: './api.d.ts' } } }),
  );
  const source = path.join(packageRoot, 'src', 'api', 'download.js').replace(/\\/g, '/');
  fs.writeFileSync(path.join(self, 'api.d.ts'), `export { blobResponseHandler } from '${source}';\nexport type { DddFileResponse } from '${source}';\n`);
}

/** A throwaway consumer app: base api, tsconfig and the package's node_modules for type checking. */
export function createApp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-web-codegen-test-'));
  fs.mkdirSync(path.join(dir, 'src', 'api'), { recursive: true });
  linkNodeModules(dir);
  fs.writeFileSync(
    path.join(dir, 'src', 'api', 'baseApi.ts'),
    "import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';\n" +
      "export const baseApi = createApi({ baseQuery: fetchBaseQuery({ baseUrl: '' }), endpoints: () => ({}) });\n",
  );
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        lib: ['ES2022', 'DOM'],
      },
      include: ['src'],
    }),
  );
  return dir;
}

export function writeSpec(dir: string, doc: OpenApiDocument, name = 'spec.json'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

export function removeApp(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function apiEntry(schemaFile: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaFile,
    apiFile: './src/api/baseApi.ts',
    apiImport: 'baseApi',
    outputFile: './src/api/adminApi.ts',
    exportName: 'adminApi',
    hooks: { queries: true, lazyQueries: true, mutations: true },
    ...overrides,
  };
}

export function captureLogger(): Logger & { warnings: string[]; infos: string[] } {
  const warnings: string[] = [];
  const infos: string[] = [];
  return {
    warnings,
    infos,
    info: (message) => infos.push(message),
    warn: (message) => warnings.push(message),
    error: () => {},
  };
}

export function read(dir: string, relative: string): string {
  return fs.readFileSync(path.join(dir, relative), 'utf-8');
}

/** Exported hook names of a generated api file. */
export function hookNames(source: string): string[] {
  return [...source.matchAll(/^\s+(use[A-Za-z0-9]+),?$/gm)].map((match) => match[1]!);
}

/** The enhanced-endpoints entry for one endpoint key, whitespace-collapsed. */
export function enhancedEntry(source: string, key: string): string {
  const collapsed = source.replace(/\s+/g, ' ');
  const start = collapsed.indexOf(` ${key}: {`);
  if (start < 0) return '';
  let depth = 0;
  for (let i = collapsed.indexOf('{', start); i < collapsed.length; i++) {
    if (collapsed[i] === '{') depth++;
    if (collapsed[i] === '}') depth--;
    if (depth === 0) return collapsed.slice(start, i + 1).trim();
  }
  return '';
}
