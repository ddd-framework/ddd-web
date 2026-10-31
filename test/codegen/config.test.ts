import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateSdk, linkSkills, loadConfig, silentLogger } from '../../src/codegen/index';
import { createApp, removeApp, SAMPLE_SPEC, read } from './helpers';

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-web-config-test-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  while (dirs.length) removeApp(dirs.pop()!);
  delete process.env.DDD_WEB_TEST_WORKSPACE;
});

describe('loadConfig', () => {
  it('loads a default-exported config', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'openapi-config.ts');
    fs.writeFileSync(
      file,
      "const config: { apis: unknown[] } = { apis: [{ schemaFile: './spec.json', apiFile: './a.ts', outputFile: './out/x.ts' }] };\nexport default config;\n",
    );
    const loaded = await loadConfig(file);
    expect(loaded.config.apis).toHaveLength(1);
    expect(loaded.rootDir).toBe(dir);
  });

  it('loads a named `apis` export (plain RTK codegen entries)', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'openapi-config.ts');
    fs.writeFileSync(file, "export const apis = [{ schemaFile: 'https://example.test/spec', apiFile: './a.ts', outputFile: './x.ts' }];\n");
    expect((await loadConfig(file)).config.apis[0]?.schemaFile).toBe('https://example.test/spec');
  });

  it('rejects a config without apis', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'openapi-config.ts');
    fs.writeFileSync(file, 'export const other = 1;\n');
    await expect(loadConfig(file)).rejects.toThrow(/must export a config/);
  });
});

describe('workspace resolution', () => {
  it('re-evaluates the config with the resolved workspace and never prompts without a TTY', async () => {
    const app = createApp();
    dirs.push(app);
    fs.copyFileSync(SAMPLE_SPEC, path.join(app, 'spec-sniffed.json'));
    fs.writeFileSync(path.join(app, '.env'), 'VITE_API_URL=https://sniffed.example.test\n');
    fs.writeFileSync(
      path.join(app, 'openapi-config.ts'),
      [
        'const workspace = process.env.DDD_WEB_TEST_WORKSPACE ?? "missing";',
        'export default {',
        '  workspace: { envVar: "DDD_WEB_TEST_WORKSPACE", prompt: false },',
        '  apis: [{ schemaFile: `./spec-${workspace}.json`, apiFile: "./src/api/baseApi.ts", apiImport: "baseApi",',
        '    outputFile: "./src/api/adminApi.ts", exportName: "adminApi", hooks: true }],',
        '};',
      ].join('\n'),
    );
    await generateSdk({ cwd: app, logger: silentLogger, skipTsc: true, skipPrettier: true });
    expect(read(app, 'src/api/adminApi.ts')).toContain('useGetApiAdminLibraryBooksListQuery');
  }, 60_000);
});

describe('linkSkills', () => {
  it('links skill directories idempotently and never replaces a real directory', () => {
    const app = tempDir();
    const source = path.join(app, 'node_modules', '@mgamadeus', 'ddd-web', '.claude', 'skills');
    for (const skill of ['ddd-web-codegen', 'ddd-web-query', 'ddd-web-api']) {
      fs.mkdirSync(path.join(source, skill), { recursive: true });
      fs.writeFileSync(path.join(source, skill, 'SKILL.md'), `# ${skill}\n`);
    }
    fs.mkdirSync(path.join(app, '.claude', 'skills', 'ddd-web-api'), { recursive: true });

    const first = linkSkills({ cwd: app, logger: silentLogger });
    expect(Object.fromEntries(first.map((result) => [result.skill, result.action]))).toEqual({
      'ddd-web-codegen': 'linked',
      'ddd-web-query': 'linked',
      'ddd-web-api': 'skipped',
    });
    expect(fs.readFileSync(path.join(app, '.claude', 'skills', 'ddd-web-query', 'SKILL.md'), 'utf-8')).toBe('# ddd-web-query\n');
    expect(fs.lstatSync(path.join(app, '.claude', 'skills', 'ddd-web-api')).isSymbolicLink()).toBe(false);

    const second = linkSkills({ cwd: app, logger: silentLogger });
    expect(second.filter((result) => result.action === 'unchanged').map((result) => result.skill).sort()).toEqual([
      'ddd-web-codegen',
      'ddd-web-query',
    ]);
  });

  it('says clearly when the installed package ships no skills', () => {
    const app = tempDir();
    const packageDir = path.join(app, 'node_modules', '@mgamadeus', 'ddd-web');
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@mgamadeus/ddd-web', version: '9.9.9' }));
    const messages: string[] = [];
    const logger = { info: (m: string) => messages.push(m), warn: (m: string) => messages.push(m), error: () => {} };
    expect(linkSkills({ cwd: app, logger })).toEqual([]);
    fs.mkdirSync(path.join(packageDir, '.claude', 'skills'), { recursive: true });
    expect(linkSkills({ cwd: app, logger })).toEqual([]);
    expect(messages).toHaveLength(2);
    for (const message of messages) expect(message).toMatch(/@mgamadeus\/ddd-web 9\.9\.9 ships no agent skills.*nothing to link/);
    expect(fs.existsSync(path.join(app, '.claude'))).toBe(false);
  });

  it('says clearly when the package is not installed', () => {
    const app = tempDir();
    const messages: string[] = [];
    linkSkills({ cwd: app, logger: { info: (m) => messages.push(m), warn: (m) => messages.push(m), error: () => {} } });
    expect(messages.join('\n')).toMatch(/not installed/);
  });
});
