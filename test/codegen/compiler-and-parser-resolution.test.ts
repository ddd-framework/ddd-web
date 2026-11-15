import * as fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTypeScriptCompiler } from '../../src/codegen/format';
import { installParserModuleResolution } from '../../src/codegen/module-resolution';

function makeProjectWithTypeScript(bin: unknown, version = '7.0.2'): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-web-tsc-'));
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
  const typescriptDir = path.join(rootDir, 'node_modules', 'typescript');
  fs.mkdirSync(path.join(typescriptDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(typescriptDir, 'package.json'), JSON.stringify({ name: 'typescript', version, bin }));
  fs.writeFileSync(path.join(typescriptDir, 'bin', 'tsc-native'), '#!/usr/bin/env node\n');
  return rootDir;
}

describe('the type check compiler', () => {
  it("takes the project's compiler through its package.json bin, also when typescript/bin/tsc is not exported", () => {
    const rootDir = makeProjectWithTypeScript({ tsc: './bin/tsc-native' });

    const compiler = resolveTypeScriptCompiler(rootDir);

    expect(compiler).toEqual({
      executable: path.join(fs.realpathSync(rootDir), 'node_modules', 'typescript', 'bin', 'tsc-native'),
      version: '7.0.2',
      origin: 'project',
    });
  });

  it("falls back to the generator's own compiler only when the project's typescript offers no tsc", () => {
    const rootDir = makeProjectWithTypeScript(undefined);

    expect(resolveTypeScriptCompiler(rootDir).origin).toBe('generator');
  });
});

describe("the parser's ajv", () => {
  it('answers an ajv lookup of ajv-draft-04 with the ajv 8 of the OpenAPI parser', () => {
    installParserModuleResolution();
    const resolveFilename = (Module as unknown as { _resolveFilename: (request: string, parent: unknown) => string })._resolveFilename;
    const hoistedAjvDraft04 = path.join(os.tmpdir(), 'consumer', 'node_modules', 'ajv-draft-04', 'dist', 'index.js');

    const resolvedAjv = resolveFilename.call(Module, 'ajv', { filename: hoistedAjvDraft04, paths: [] });

    const ajvPackageJson = createRequire(resolvedAjv)('../package.json') as { version: string };
    expect(ajvPackageJson.version.startsWith('8.')).toBe(true);
  });
});
