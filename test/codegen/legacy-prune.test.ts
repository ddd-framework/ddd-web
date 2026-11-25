import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateLegacySdk, silentLogger, type LegacySdkSource } from '../../src/codegen/index';
import { createApp, removeApp } from './helpers';

const apps: string[] = [];
function app(): string {
  const directory = createApp();
  apps.push(directory);
  installPlanningGenerator(directory);
  return directory;
}
afterEach(() => {
  while (apps.length) removeApp(apps.pop()!);
});

/** A stand-in generator: each output plans the files named in its `files` option; a source with `skip` is skipped. */
function installPlanningGenerator(directory: string): void {
  const packageDir = path.join(directory, 'node_modules/swagger-sdk-generator');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    exports: { '.': './index.cjs', './runtime/stores': './index.cjs', './runtime/mocks': './index.cjs' },
  }));
  fs.writeFileSync(path.join(packageDir, 'index.cjs'), [
    'exports.generate = async (config, { cwd, dryRun }) => {',
    '  if (!dryRun || config.prune !== false) throw new Error("Expected a dry run without the generator\'s own prune");',
    '  return config.sources.map((source) => source.skip',
    '    ? { source: source.name, ok: true, skipped: true }',
    '    : { source: source.name, ok: true, planned: Object.values(source.outputs).map((options) => ({',
    '        dir: require("node:path").resolve(cwd, options.dir),',
    '        files: options.files.map((file) => ({ path: file, content: "// generated " + file + "\\n" })),',
    '      })) });',
    '};',
  ].join('\n'));
}

type Outputs = Record<string, string[]>;
const dirs: Record<string, string> = { stores: 'src/stores', mocks: 'src/mocks', models: 'src/models' };

function source(name: string, outputs: Outputs, extra: Partial<LegacySdkSource> & { skip?: boolean } = {}): LegacySdkSource {
  return {
    name,
    file: 'unused.json',
    outputs: Object.fromEntries(Object.entries(outputs).map(([output, files]) => [output, { dir: dirs[output], files }])),
    ...extra,
  };
}

async function run(directory: string, sources: LegacySdkSource[], options: { dryRun?: boolean; prune?: boolean; manifestFile?: string } = {}) {
  return generateLegacySdk({ cwd: directory, sources, logger: silentLogger, prune: true, ...options });
}

const exists = (directory: string, file: string): boolean => fs.existsSync(path.join(directory, file));
const write = (directory: string, file: string, content = 'export {};\n'): void => {
  fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  fs.writeFileSync(path.join(directory, file), content);
};
const manifest = (directory: string, file = '.ddd-web-legacy-sdk.json') =>
  JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as { version: number; sources: Record<string, Record<string, { dir: string; files: string[] }>> };

describe('generateLegacySdk prune', () => {
  it('deletes nothing and writes no manifest without prune', async () => {
    const directory = app();
    await run(directory, [source('client', { stores: ['a/A.ts', 'b/B.ts'] })], { prune: false });
    const results = await run(directory, [source('client', { stores: ['a/A.ts'] })], { prune: false });
    expect(exists(directory, 'src/stores/b/B.ts')).toBe(true);
    expect(exists(directory, '.ddd-web-legacy-sdk.json')).toBe(false);
    expect(results[0]?.pruned).toBeUndefined();
  });

  it('deletes nothing on the first run, then only the files the previous run wrote and this run no longer plans', async () => {
    const directory = app();
    write(directory, 'src/mocks/handwritten.ts');
    write(directory, 'src/mocks/nested/helper.ts');
    write(directory, 'src/stores/Old.ts'); // in the output directory before the first run: never listed, never deleted
    const first = await run(directory, [source('client', { stores: ['a/A.ts', 'b/B.ts'], mocks: ['x/X.mock.ts', 'nested/Y.mock.ts'] })]);
    expect(first[0]?.pruned).toEqual([]);
    expect(exists(directory, 'src/stores/Old.ts')).toBe(true);
    expect(manifest(directory).sources.client).toEqual({
      stores: { dir: 'src/stores', files: ['src/stores/a/A.ts', 'src/stores/b/B.ts'] },
      mocks: { dir: 'src/mocks', files: ['src/mocks/nested/Y.mock.ts', 'src/mocks/x/X.mock.ts'] },
    });

    const second = await run(directory, [source('client', { stores: ['a/A.ts'], mocks: [] })]);
    expect(second[0]?.pruned).toEqual([
      path.join(directory, 'src/stores/b/B.ts'),
      path.join(directory, 'src/mocks/nested/Y.mock.ts'),
      path.join(directory, 'src/mocks/x/X.mock.ts'),
    ]);
    expect(exists(directory, 'src/stores/a/A.ts')).toBe(true);
    expect(exists(directory, 'src/stores/b')).toBe(false); // emptied folder removed
    expect(exists(directory, 'src/mocks/x')).toBe(false);
    expect(exists(directory, 'src/mocks')).toBe(true); // the output directory itself stays
    expect(exists(directory, 'src/mocks/handwritten.ts')).toBe(true);
    expect(exists(directory, 'src/mocks/nested/helper.ts')).toBe(true); // a folder with a hand-written file stays
    expect(exists(directory, 'src/stores/Old.ts')).toBe(true);
    expect(manifest(directory).sources.client?.mocks?.files).toEqual([]);
  });

  it('keeps files of a shared directory that a source which did not run still lists', async () => {
    const directory = app();
    await run(directory, [
      source('client', { stores: ['client/C.ts'], mocks: ['Shared.mock.ts', 'Client.mock.ts'] }),
      source('admin', { stores: ['admin/A.ts'], mocks: ['Shared.mock.ts', 'Admin.mock.ts', 'AdminOld.mock.ts'] }),
    ]);
    // partial run: only admin, which no longer plans Shared and AdminOld
    const results = await run(directory, [source('admin', { stores: ['admin/A.ts'], mocks: ['Admin.mock.ts'] })]);
    expect(results[0]?.pruned).toEqual([path.join(directory, 'src/mocks/AdminOld.mock.ts')]);
    expect(exists(directory, 'src/mocks/Shared.mock.ts')).toBe(true); // client still lists it
    expect(exists(directory, 'src/mocks/Client.mock.ts')).toBe(true);
    expect(exists(directory, 'src/stores/client/C.ts')).toBe(true);
    const sources = manifest(directory).sources;
    expect(sources.client?.mocks?.files).toEqual(['src/mocks/Client.mock.ts', 'src/mocks/Shared.mock.ts']);
    expect(sources.admin?.mocks?.files).toEqual(['src/mocks/Admin.mock.ts']);

    // the full run: nobody plans Shared any more
    await run(directory, [
      source('client', { stores: ['client/C.ts'], mocks: ['Client.mock.ts'] }),
      source('admin', { stores: ['admin/A.ts'], mocks: ['Admin.mock.ts'] }),
    ]);
    expect(exists(directory, 'src/mocks/Shared.mock.ts')).toBe(false);
  });

  it('keeps the files of a skipped source and of an output that did not run', async () => {
    const directory = app();
    await run(directory, [
      source('client', { stores: ['client/C.ts'], mocks: ['Client.mock.ts'] }),
      source('admin', { stores: ['admin/A.ts'], mocks: ['Admin.mock.ts'] }),
    ]);
    // admin skipped; client runs its mocks only (its stores output did not run)
    const results = await run(directory, [
      source('client', { mocks: [] }),
      source('admin', { stores: [], mocks: [] }, { skip: true }),
    ]);
    expect(results.map((result) => result.pruned)).toEqual([[path.join(directory, 'src/mocks/Client.mock.ts')], undefined]);
    for (const kept of ['src/stores/client/C.ts', 'src/stores/admin/A.ts', 'src/mocks/Admin.mock.ts']) {
      expect(exists(directory, kept), kept).toBe(true);
    }
    const sources = manifest(directory).sources;
    expect(sources.client?.stores?.files).toEqual(['src/stores/client/C.ts']);
    expect(sources.admin?.stores?.files).toEqual(['src/stores/admin/A.ts']);
  });

  it('reports with dryRun what it would delete, deletes nothing and keeps the manifest', async () => {
    const directory = app();
    await run(directory, [source('client', { stores: ['A.ts', 'B.ts'] })], { manifestFile: 'generated/manifest.json' });
    const before = fs.readFileSync(path.join(directory, 'generated/manifest.json'), 'utf8');
    const results = await run(directory, [source('client', { stores: ['A.ts'] })], { dryRun: true, manifestFile: 'generated/manifest.json' });
    expect(results[0]?.pruned).toEqual([path.join(directory, 'src/stores/B.ts')]);
    expect(exists(directory, 'src/stores/B.ts')).toBe(true);
    expect(fs.readFileSync(path.join(directory, 'generated/manifest.json'), 'utf8')).toBe(before);
    expect(exists(directory, '.ddd-web-legacy-sdk.json')).toBe(false);
  });

  it('never deletes a listed file outside the directory the manifest recorded for it', async () => {
    const directory = app();
    await run(directory, [source('client', { stores: ['A.ts'] })]);
    write(directory, 'src/app.ts');
    const edited = manifest(directory);
    edited.sources.client!.stores!.files.push('src/app.ts', 'src/stores/../app.ts');
    fs.writeFileSync(path.join(directory, '.ddd-web-legacy-sdk.json'), JSON.stringify(edited));
    const results = await run(directory, [source('client', { stores: ['A.ts'] })]);
    expect(results[0]?.pruned).toEqual([]);
    expect(exists(directory, 'src/app.ts')).toBe(true);
  });

  it('rejects an unreadable manifest before writing anything', async () => {
    const directory = app();
    fs.writeFileSync(path.join(directory, '.ddd-web-legacy-sdk.json'), '{"version":2}');
    await expect(run(directory, [source('client', { stores: ['A.ts'] })])).rejects.toThrow('Unsupported legacy SDK manifest');
    expect(exists(directory, 'src/stores/A.ts')).toBe(false);
  });
});
