import type { SideEffectsOverride } from './config';
import type { DddEntityExtension, HttpMethod, OpenApiDocument, OpenApiOperation } from './openapi';
import { listOperations, operationKey } from './openapi';

export interface OperationInfo {
  method: HttpMethod;
  path: string;
  operation: OpenApiOperation;
  /** Resolved: extension → config override → default (A.6: false for GET/HEAD, true otherwise). */
  sideEffects: boolean;
  /** True when the classification came from `x-ddd-side-effects` or a config override. */
  sideEffectsExplicit: boolean;
  endpointType: 'query' | 'mutation';
  entity?: DddEntityExtension;
}

export interface OperationIndex {
  byKey: Map<string, OperationInfo>;
  /** Keys (`POST /path`) of POST twins that are not generated. */
  skippedTwins: Set<string>;
}

function defaultSideEffects(method: HttpMethod): boolean {
  return method !== 'get' && method !== 'head';
}

function matchesOverride(override: SideEffectsOverride, method: HttpMethod, path: string): boolean {
  if (override.method && override.method.toLowerCase() !== method) return false;
  return typeof override.path === 'string' ? override.path === path : override.path.test(path);
}

function isEntityExtension(value: unknown): value is DddEntityExtension {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as DddEntityExtension).schema === 'string' &&
    typeof (value as DddEntityExtension).action === 'string'
  );
}

export function indexOperations(
  doc: OpenApiDocument,
  overrides: SideEffectsOverride[],
  skipUpdatePostTwins: boolean,
): OperationIndex {
  const byKey = new Map<string, OperationInfo>();
  for (const { method, path, operation } of listOperations(doc)) {
    const extension = operation['x-ddd-side-effects'];
    const override = overrides.find((candidate) => matchesOverride(candidate, method, path));
    let sideEffects = defaultSideEffects(method);
    let explicit = false;
    if (typeof extension === 'boolean') {
      sideEffects = extension;
      explicit = true;
    } else if (override) {
      sideEffects = override.sideEffects;
      explicit = true;
    }
    const naturalType = method === 'get' ? 'query' : 'mutation';
    const classifiedType = explicit ? (sideEffects ? 'mutation' : 'query') : naturalType;
    const endpointType = (typeof extension !== 'boolean' && override?.endpointType) || classifiedType;
    const entity = isEntityExtension(operation['x-ddd-entity']) ? operation['x-ddd-entity'] : undefined;
    byKey.set(operationKey(method, path), {
      method,
      path,
      operation,
      sideEffects,
      sideEffectsExplicit: explicit,
      endpointType,
      ...(entity ? { entity } : {}),
    });
  }

  const skippedTwins = new Set<string>();
  if (skipUpdatePostTwins) {
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      const post = item?.post;
      const patch = item?.patch;
      if (post && patch && post.summary !== undefined && post.summary === patch.summary) {
        skippedTwins.add(operationKey('post', path));
      }
    }
  }
  return { byKey, skippedTwins };
}

/** Operations whose generated hook kind differs from RTK's verb-based default (GET → query). */
export function endpointTypeOverrides(index: OperationIndex): Array<{ method: HttpMethod; path: string; type: 'query' | 'mutation' }> {
  const result: Array<{ method: HttpMethod; path: string; type: 'query' | 'mutation' }> = [];
  for (const info of index.byKey.values()) {
    const rtkDefault = info.method === 'get' ? 'query' : 'mutation';
    if (info.endpointType !== rtkDefault) result.push({ method: info.method, path: info.path, type: info.endpointType });
  }
  return result;
}
