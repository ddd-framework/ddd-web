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

function resolveTsc(rootDir: string): string {
  const candidates = [path.join(rootDir, 'package.json'), import.meta.url];
  for (const base of candidates) {
    try {
      return createRequire(base).resolve('typescript/bin/tsc');
    } catch {
      // try the next location
    }
  }
  const codegen = createRequire(import.meta.url).resolve('@rtk-query/codegen-openapi');
  return createRequire(codegen).resolve('typescript/bin/tsc');
}

/** Runs `tsc --noEmit` for the consuming project. Returns false when there is no tsconfig to check. */
export function typecheck(rootDir: string, tsconfig: string, logger: Logger): boolean {
  if (!fs.existsSync(tsconfig)) {
    logger.warn(`No ${path.relative(rootDir, tsconfig) || tsconfig} — skipping the type check.`);
    return false;
  }
  try {
    execFileSync(process.execPath, [resolveTsc(rootDir), '--noEmit', '-p', tsconfig], {
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
