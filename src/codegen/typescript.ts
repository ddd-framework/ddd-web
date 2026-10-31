import { createRequire } from 'node:module';
import type TypeScript from 'typescript';

let cached: typeof TypeScript | undefined;

/**
 * The TypeScript compiler API, resolved through @rtk-query/codegen-openapi (which depends on it) so the
 * codegen parses with the same version that printed the code and needs no own typescript dependency.
 */
export function loadTypeScript(): typeof TypeScript {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const codegenEntry = require.resolve('@rtk-query/codegen-openapi');
  cached = createRequire(codegenEntry)('typescript') as typeof TypeScript;
  return cached;
}
