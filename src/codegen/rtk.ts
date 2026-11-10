import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateEndpoints } from '@rtk-query/codegen-openapi';
import prettier from 'prettier';
import { isPathLike, type ResolvedApi } from './config';
import type { OperationLocation } from './endpoints';
import { endpointTypeOverrides, testPattern, type OperationIndex } from './operations';
import type { HttpMethod, OpenApiDocument } from './openapi';
import { operationKey } from './openapi';

type GenerationOptions = Parameters<typeof generateEndpoints>[0];
type RtkOperationDefinition = { path: string; verb: string };
type Matcher = string | RegExp | Array<string | RegExp> | ((name: string, definition: RtkOperationDefinition) => boolean);
type EndpointOverride = { pattern?: Matcher; type?: 'query' | 'mutation'; [option: string]: unknown };

/** Keys of the api config that are ddd-web's own and must not reach RTK codegen. */
const OWN_KEYS = new Set(['schemaFile', 'apiFile', 'outputFile', 'audience', 'baseApiImport', 'skipUpdatePostTwins', 'sideEffects', 'responseHandlers', 'invalidation']);

/** RTK codegen's matcher semantics (an absent pattern matches everything); RegExps are tested statelessly. */
function matches(matcher: Matcher | undefined, name: string, definition: RtkOperationDefinition): boolean {
  if (matcher === undefined) return true;
  if (typeof matcher === 'function') return matcher(name, definition);
  const list = Array.isArray(matcher) ? matcher : [matcher];
  return list.some((entry) => (typeof entry === 'string' ? entry === name : testPattern(entry, name)));
}

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * RTK codegen applies only the FIRST matching endpoint override. So that a user override (e.g. only a
 * `parameterFilter`) does not displace the side-effect classification, every classified operation gets one merged
 * override per matching user override, placed first: the user's options plus the classified `type` — unless the user
 * override sets `type` itself, which then wins. Plain classification overrides and the user overrides follow.
 */
export function mergeEndpointOverrides(
  userOverrides: EndpointOverride[],
  typeOverrides: Array<{ method: HttpMethod; path: string; type: 'query' | 'mutation' }>,
): EndpointOverride[] {
  const merged: EndpointOverride[] = [];
  for (const operation of typeOverrides) {
    const isOperation = (definition: RtkOperationDefinition): boolean =>
      definition.verb === operation.method && definition.path === operation.path;
    for (const user of userOverrides) {
      merged.push({
        ...user,
        type: user.type ?? operation.type,
        pattern: (name: string, definition: RtkOperationDefinition) => isOperation(definition) && matches(user.pattern, name, definition),
      });
    }
    merged.push({ pattern: (_name: string, definition: RtkOperationDefinition) => isOperation(definition), type: operation.type });
  }
  return [...merged, ...userOverrides];
}

export interface RtkCodegenResult {
  code: string;
  /** Endpoint key in the generated file → operation it was generated from. */
  locations: Map<string, OperationLocation>;
}

export function relativeImport(fromDir: string, target: string): string {
  if (!isPathLike(target)) return target;
  let relative = path.relative(fromDir, target).replace(/\\/g, '/');
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative;
}

/**
 * Runs RTK Query codegen in-process on the already loaded spec (written once to `specFile`) and
 * returns the generated source plus the operation of every endpoint. Side-effect classification is fed in as
 * `endpointOverrides`, twin skipping as `filterEndpoints`; the filter also records which endpoint key belongs to which
 * operation, so later steps never parse URLs back into paths.
 */
export async function runRtkCodegen(
  api: ResolvedApi,
  doc: OpenApiDocument,
  index: OperationIndex,
  specFile: string,
  prettierConfigFile: string | undefined,
): Promise<RtkCodegenResult> {
  fs.writeFileSync(specFile, JSON.stringify(doc));

  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(api.config)) if (!OWN_KEYS.has(key)) passthrough[key] = value;

  const userOverrides = (passthrough.endpointOverrides as EndpointOverride[] | undefined) ?? [];
  const endpointOverrides = mergeEndpointOverrides(userOverrides, endpointTypeOverrides(index));

  const suffix = typeof passthrough.operationNameSuffix === 'string' ? passthrough.operationNameSuffix : '';
  const locations = new Map<string, OperationLocation>();
  const userFilter = passthrough.filterEndpoints as Matcher | undefined;
  const filterEndpoints = (name: string, definition: RtkOperationDefinition): boolean => {
    const included =
      !index.skippedTwins.has(operationKey(definition.verb, definition.path)) &&
      (userFilter === undefined || matches(userFilter, name, definition));
    if (included) {
      // Same key RTK codegen writes for the endpoint (`generateEndpoint`'s operationName).
      locations.set(suffix ? capitalize(name + suffix) : name, { method: definition.verb as HttpMethod, path: definition.path });
    }
    return included;
  };

  const options = {
    // A path parameter is one URL segment: a value with `/`, `?`, `#` or a space must not change the route.
    // `encodePathParams: false` in the api config switches it off for callers that encode themselves.
    encodePathParams: true,
    ...passthrough,
    schemaFile: specFile,
    apiFile: relativeImport(api.outputDir, api.apiFile),
    apiImport: api.config.apiImport ?? 'api',
    exportName: api.exportName,
    endpointOverrides,
    filterEndpoints,
    ...(prettierConfigFile ? { prettierConfigFile } : {}),
  } as GenerationOptions;

  const code = await generateEndpoints(options);
  if (typeof code !== 'string') throw new Error(`RTK codegen returned no code for ${api.stem}.`);
  return { code, locations };
}

export async function findPrettierConfigFile(rootDir: string): Promise<string | undefined> {
  return (await prettier.resolveConfigFile(path.join(rootDir, 'openapi-config.ts'))) ?? undefined;
}
