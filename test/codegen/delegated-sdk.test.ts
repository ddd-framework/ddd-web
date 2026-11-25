import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateLegacySdk, generateSdk, silentLogger, type SdkConfig } from '../../src/codegen/index';
import { apiEntry, createApp, read, readSample, removeApp, SAMPLE_SPEC, writeSpec } from './helpers';

const apps: string[] = [];
function app(): string {
  const directory = createApp();
  apps.push(directory);
  return directory;
}
afterEach(() => {
  while (apps.length) removeApp(apps.pop()!);
});

function installGenerator(directory: string, legacy = false): void {
  const packageDir = path.join(directory, 'node_modules/swagger-sdk-generator');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    exports: {
      '.': './index.cjs',
      ...(legacy ? { './runtime/stores': './index.cjs', './runtime/mocks': './index.cjs' } : {}),
    },
  }));
  fs.writeFileSync(path.join(packageDir, 'index.cjs'), [
    'const fs = require("node:fs");',
    'exports.generate = async (config, { dryRun }) => {',
    '  if (!dryRun || config.version !== 4) throw new Error("Expected version 4 and a dry run");',
    '  return config.sources.map(({name, file, outputs}) => {',
    '    const document = JSON.parse(fs.readFileSync(file, "utf8"));',
    '    return { source: name, ok: true, planned: Object.entries(outputs).map(([kind, options]) => ({',
    '      dir: options.dir, files: [{ path: kind + ".ts", content: options.invalid ?',
    '        "export const value: number = \\"invalid\\";" : "export const generated = " +',
    '        JSON.stringify({ mode: config.mode, kind, options, post: !!document.paths["/api/admin/library/books"].post }) + ";" }],',
    '    })) };',
    '  });',
    '};',
  ].join('\n'));
}

const config = (generator?: SdkConfig['generator']): SdkConfig => ({ apis: [apiEntry(SAMPLE_SPEC)], generator });

describe('opt-in SDK generation', () => {
  it('allows existing apps to pass native legacy sources and preserve their output paths', async () => {
    const directory = app();
    installGenerator(directory, true);
    const document = readSample();
    delete document.tags;
    const input = writeSpec(directory, document);
    const storesDir = path.join(directory, 'src/stores/swagger');
    const [result] = await generateLegacySdk({
      cwd: directory,
      dryRun: true,
      sources: [{ name: 'legacy', file: input, outputs: { stores: { dir: storesDir, engine: 'legacy' } } }],
      logger: silentLogger,
    });
    expect(result?.planned?.[0]?.dir).toBe(storesDir);
    expect(result?.planned?.[0]?.files[0]?.content).toContain('"mode":"legacy"');
    expect(fs.existsSync(storesDir)).toBe(false);
    fs.mkdirSync(storesDir, { recursive: true });
    fs.writeFileSync(path.join(storesDir, 'existing.ts'), 'export {};\n');
    await generateLegacySdk({
      cwd: directory,
      sources: [{ name: 'legacy', file: input, outputs: { stores: { dir: storesDir, engine: 'legacy' } } }],
      logger: silentLogger,
    });
    expect(fs.readdirSync(storesDir).sort()).toEqual(['existing.ts', 'stores.ts']);
    expect(read(directory, 'src/stores/swagger/existing.ts')).toBe('export {};\n');
  }, 60_000);

  it('uses the built-in RTK pipeline for a default override without loading the optional generator', async () => {
    const directory = app();
    const result = await generateSdk({
      cwd: directory, config: config({ mode: 'future' }), mode: 'default', logger: silentLogger,
    });
    expect(result.typechecked).toBe(true);
    expect(read(directory, 'src/api/adminApi.ts')).toContain('useGetApiAdminLibraryBooksListQuery');
    expect(read(directory, 'src/api/adminApiEnhanced.ts')).toContain('invalidatesTags');
    expect(fs.existsSync(path.join(directory, 'src/generated-sdk'))).toBe(false);
  }, 60_000);

  it('delegates only when selected and forwards native outputs using the validated DDD document', async () => {
    const directory = app();
    await expect(generateSdk({ cwd: directory, config: config({ mode: 'future' }), logger: silentLogger }))
      .rejects.toThrow('swagger-sdk-generator@^3');
    installGenerator(directory);
    const unchanged = 'export const dddDefault = true;\n';
    fs.writeFileSync(path.join(directory, 'src/api/adminApi.ts'), unchanged);
    const result = await generateSdk({
      cwd: directory,
      config: { ...config({ mode: 'future', outputs: { client: { transport: 'none' }, mocks: {} } }), skipUpdatePostTwins: true },
      logger: silentLogger,
    });
    const output = 'src/generated-sdk/future/adminApi';
    expect(result.typechecked).toBe(true);
    expect(result.modelsByApi?.adminApi).toBe(path.join(directory, output, 'models'));
    expect(read(directory, output + '/client/client.ts')).toContain('"transport":"none"');
    expect(read(directory, output + '/client/client.ts')).toContain('"post":false');
    expect(read(directory, output + '/mocks/mocks.ts')).toContain('"kind":"mocks"');
    expect(read(directory, 'src/api/adminApi.ts')).toBe(unchanged);
  }, 60_000);

  it('rejects legacy without the store and mock runtimes and delegates when they are installed', async () => {
    const directory = app();
    installGenerator(directory);
    await expect(generateSdk({ cwd: directory, config: config(), mode: 'legacy', logger: silentLogger }))
      .rejects.toThrow('swagger-sdk-generator@^3.1');
    expect(fs.existsSync(path.join(directory, 'src/generated-sdk'))).toBe(false);

    const compatible = app();
    installGenerator(compatible, true);
    await generateSdk({ cwd: compatible, config: config(), mode: 'legacy', logger: silentLogger });
    expect(read(compatible, 'src/generated-sdk/legacy/adminApi/stores/stores.ts')).toContain('"mode":"legacy"');
    expect(read(compatible, 'src/generated-sdk/legacy/adminApi/mocks/mocks.ts')).toContain('"kind":"mocks"');
  }, 60_000);

  it('keeps other APIs on partial runs and rolls back every selected API on typecheck failure', async () => {
    const directory = app();
    installGenerator(directory);
    const full: SdkConfig = {
      apis: [apiEntry(SAMPLE_SPEC), apiEntry(SAMPLE_SPEC, { outputFile: './src/api/clientApi.ts', exportName: 'clientApi' })],
      generator: { mode: 'future' },
    };
    const admin = 'src/generated-sdk/future/adminApi/client/client.ts';
    const client = 'src/generated-sdk/future/clientApi/client/client.ts';
    await generateSdk({ cwd: directory, config: full, logger: silentLogger });
    const clientBefore = read(directory, client);
    const partial: SdkConfig = { ...full, generator: { mode: 'future', outputs: { client: { transport: 'none' } } } };
    await generateSdk({ cwd: directory, config: partial, api: 'adminApi', logger: silentLogger });
    const adminBefore = read(directory, admin);
    expect(adminBefore).toContain('"transport":"none"');
    expect(read(directory, client)).toBe(clientBefore);

    const invalid: SdkConfig = { ...full, generator: { mode: 'future', outputs: { client: { invalid: true } } } };
    await expect(generateSdk({ cwd: directory, config: invalid, logger: silentLogger })).rejects.toThrow('Type check failed');
    expect(read(directory, admin)).toBe(adminBefore);
    expect(read(directory, client)).toBe(clientBefore);
  }, 60_000);

  it('rejects unsupported DDD specs and protects existing directories before writing', async () => {
    const directory = app();
    installGenerator(directory);
    const invalid = readSample();
    invalid.tags = [];
    const file = writeSpec(directory, invalid);
    await expect(generateSdk({
      cwd: directory, config: { ...config({ mode: 'future' }), apis: [apiEntry(file)] }, logger: silentLogger,
    })).rejects.toThrow('SchemaDefinition');
    const output = 'src/generated-sdk/future/adminApi';
    fs.mkdirSync(path.join(directory, output), { recursive: true });
    fs.writeFileSync(path.join(directory, output, 'owned.ts'), 'export {};\n');
    await expect(generateSdk({ cwd: directory, config: config({ mode: 'future' }), logger: silentLogger }))
      .rejects.toThrow('does not own');
    expect(read(directory, output + '/owned.ts')).toBe('export {};\n');
  }, 60_000);
});
