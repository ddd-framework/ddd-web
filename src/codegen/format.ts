import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import prettier from 'prettier';
import type { OutputFiles } from './files';
import { SdkGenerationError, type Logger } from './log';

/** Formats every file with the prettier config that applies at its final location. */
export async function formatFiles(files: OutputFiles): Promise<void> {
  for (const filePath of files.paths()) {
    const options = (await prettier.resolveConfig(filePath, { editorconfig: true })) ?? {};
    files.set(filePath, await prettier.format(files.get(filePath)!, { ...options, filepath: filePath }));
  }
}

/** The compiler the type check runs: its executable, its version and whose installation it is. */
export interface ResolvedTypeScriptCompiler {
  executable: string;
  version: string;
  origin: 'project' | 'generator';
}

/** The `tsc` of the TypeScript installation that `base` resolves, through its package.json `bin` (TypeScript 7 exports no `typescript/bin/tsc`). */
function resolveTscOfInstallation(base: string): { executable: string; version: string } | null {
  let packageJsonPath: string;
  try {
    packageJsonPath = createRequire(base).resolve('typescript/package.json');
  } catch {
    return null;
  }
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { version?: string; bin?: string | Record<string, string> };
  const binEntry = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.tsc;
  if (!binEntry) return null;
  const executable = path.resolve(path.dirname(packageJsonPath), binEntry);
  return fs.existsSync(executable) ? { executable, version: packageJson.version ?? 'unknown' } : null;
}

/** The project's own TypeScript compiler; the generator's (through its codegen dependency) only when the project has none. */
export function resolveTypeScriptCompiler(rootDir: string): ResolvedTypeScriptCompiler {
  const projectCompiler = resolveTscOfInstallation(path.join(rootDir, 'package.json'));
  if (projectCompiler) return { ...projectCompiler, origin: 'project' };
  const ownRequire = createRequire(import.meta.url);
  for (const base of [import.meta.url, ownRequire.resolve('@rtk-query/codegen-openapi')]) {
    const generatorCompiler = resolveTscOfInstallation(base);
    if (generatorCompiler) return { ...generatorCompiler, origin: 'generator' };
  }
  throw new SdkGenerationError('No TypeScript compiler found for the type check (install typescript in the project, or pass --skip-tsc).');
}

/**
 * The command line that runs the compiler: a JavaScript entry (`.js`/`.cjs`/`.mjs`, or a file starting with a `#!` line
 * that names node — TypeScript's `bin/tsc`) through this Node, any other file (a native compiler) directly.
 */
function buildCompilerCommand(executable: string, args: string[]): [string, string[]] {
  if (/\.(c|m)?js$/.test(executable)) return [process.execPath, [executable, ...args]];
  const head = fs.readFileSync(executable).subarray(0, 100).toString('latin1');
  return head.startsWith('#!') && head.split('\n', 1)[0]!.includes('node')
    ? [process.execPath, [executable, ...args]]
    : [executable, args];
}

/** Runs `tsc --noEmit` for the consuming project. Returns false when there is no tsconfig to check. */
export function typecheck(rootDir: string, tsconfig: string, logger: Logger): boolean {
  if (!fs.existsSync(tsconfig)) {
    logger.warn(`No ${path.relative(rootDir, tsconfig) || tsconfig} — skipping the type check.`);
    return false;
  }
  const compiler = resolveTypeScriptCompiler(rootDir);
  logger.info(
    `Type check with TypeScript ${compiler.version} (${compiler.origin === 'project' ? "the project's compiler" : "the generator's own compiler — the project has no typescript"}).`,
  );
  const [command, args] = buildCompilerCommand(compiler.executable, ['--noEmit', '-p', tsconfig]);
  try {
    execFileSync(command, args, {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
  } catch (error) {
    const output = (error as { stdout?: string }).stdout ?? '';
    throw new SdkGenerationError(`Type check failed:\n${output.split('\n').slice(0, 40).join('\n')}`);
  }
  return true;
}
