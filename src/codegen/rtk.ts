import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateEndpoints } from '@rtk-query/codegen-openapi';
import prettier from 'prettier';
import { isPathLike, type ResolvedApi } from './config';
import { endpointTypeOverrides, type OperationIndex } from './operations';
import type { OpenApiDocument } from './openapi';
import { operationKey } from './openapi';

type GenerationOptions = Parameters<typeof generateEndpoints>[0];
type RtkOperationDefinition = { path: string; verb: string };
type Matcher = string | RegExp | Array<string | RegExp> | ((name: string, definition: RtkOperationDefinition) => boolean);

/** Keys of the api config that are ddd-web's own and must not reach RTK codegen. */
const OWN_KEYS = new Set(['schemaFile', 'apiFile', 'outputFile', 'audience', 'baseApiImport', 'skipUpdatePostTwins', 'sideEffects']);

function matches(matcher: Matcher, name: string, definition: RtkOperationDefinition): boolean {
  if (typeof matcher === 'function') return matcher(name, definition);
  const list = Array.isArray(matcher) ? matcher : [matcher];
  return list.some((entry) => (typeof entry === 'string' ? entry === name : entry.test(name)));
}

export function relativeImport(fromDir: string, target: string): string {
  if (!isPathLike(target)) return target;
  let relative = path.relative(fromDir, target).replace(/\\/g, '/');
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative;
}

/**
 * Runs RTK Query codegen in-process on the already loaded spec (written once to `specFile`) and
 * returns the generated source. Side-effect classification is fed in as `endpointOverrides`, twin
 * skipping as `filterEndpoints`.
 */
export async function runRtkCodegen(
  api: ResolvedApi,
  doc: OpenApiDocument,
  index: OperationIndex,
  specFile: string,
  prettierConfigFile: string | undefined,
): Promise<string> {
  fs.writeFileSync(specFile, JSON.stringify(doc));

  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(api.config)) if (!OWN_KEYS.has(key)) passthrough[key] = value;

  const userOverrides = (passthrough.endpointOverrides as GenerationOptions['endpointOverrides']) ?? [];
  const typeOverrides = endpointTypeOverrides(index).map(({ method, path: opPath, type }) => ({
    pattern: (_name: string, definition: RtkOperationDefinition) => definition.verb === method && definition.path === opPath,
    type,
  }));

  const userFilter = passthrough.filterEndpoints as Matcher | undefined;
  const filterEndpoints =
    index.skippedTwins.size > 0 || userFilter
      ? (name: string, definition: RtkOperationDefinition) =>
          !index.skippedTwins.has(operationKey(definition.verb, definition.path)) &&
          (userFilter === undefined || matches(userFilter, name, definition))
      : undefined;

  const options = {
    ...passthrough,
    schemaFile: specFile,
    apiFile: relativeImport(api.outputDir, api.apiFile),
    apiImport: api.config.apiImport ?? 'api',
    exportName: api.exportName,
    endpointOverrides: [...userOverrides, ...typeOverrides],
    ...(filterEndpoints ? { filterEndpoints } : {}),
    ...(prettierConfigFile ? { prettierConfigFile } : {}),
  } as GenerationOptions;

  const code = await generateEndpoints(options);
  if (typeof code !== 'string') throw new Error(`RTK codegen returned no code for ${api.stem}.`);
  return code;
}

export async function findPrettierConfigFile(rootDir: string): Promise<string | undefined> {
  return (await prettier.resolveConfigFile(path.join(rootDir, 'openapi-config.ts'))) ?? undefined;
}
