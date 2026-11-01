import { hasSideEffects } from '../contract/extensions';
import type { OperationMatcher, SideEffectsOverride } from './config';
import type { DddEntityExtension, HttpMethod, OpenApiDocument, OpenApiOperation } from './openapi';
import { listOperations, operationKey } from './openapi';

export interface OperationInfo {
  method: HttpMethod;
  path: string;
  operation: OpenApiOperation;
  /** Resolved: extension → config override → contract default (`hasSideEffects`: GET/HEAD/OPTIONS/TRACE read). */
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

/** `RegExp.test` without the `lastIndex` state of `g` / `y` expressions. */
export function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const result = pattern.test(value);
  pattern.lastIndex = 0;
  return result;
}

/** Whether a config override (`{ method?, path: string | RegExp }`) applies to an operation. */
export function matchesOperation(override: OperationMatcher, method: HttpMethod, path: string): boolean {
  if (override.method && override.method.toLowerCase() !== method) return false;
  return typeof override.path === 'string' ? override.path === path : testPattern(override.path, path);
}

/** JSON with sorted object keys, for structural comparison. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, (inner as Record<string, unknown>)[key]]))
      : inner,
  ) ?? 'undefined';
}

/**
 * Whether the POST is the twin of an upsert PATCH on the same path (DDD `#[Update]` routes both verbs to one action).
 * With `x-ddd-entity` the annotation decides: both must be `upsert` of the same schema; a conflicting or one-sided
 * non-upsert annotation keeps the POST. Without annotations (older specs) summary, parameters, request body,
 * responses and the side-effect classification must all be identical.
 */
function isUpsertTwin(post: OpenApiOperation, patch: OpenApiOperation): boolean {
  if (post['x-ddd-side-effects'] !== patch['x-ddd-side-effects']) return false;
  const postEntity = isEntityExtension(post['x-ddd-entity']) ? post['x-ddd-entity'] : undefined;
  const patchEntity = isEntityExtension(patch['x-ddd-entity']) ? patch['x-ddd-entity'] : undefined;
  if (postEntity && patchEntity) {
    return postEntity.action === 'upsert' && patchEntity.action === 'upsert' && postEntity.schema === patchEntity.schema;
  }
  if ((postEntity && postEntity.action !== 'upsert') || (patchEntity && patchEntity.action !== 'upsert')) return false;
  if (post.summary === undefined || post.summary !== patch.summary) return false;
  return (['parameters', 'requestBody', 'responses'] as const).every((key) => canonical(post[key]) === canonical(patch[key]));
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
    const override = overrides.find((candidate) => matchesOperation(candidate, method, path));
    let sideEffects = hasSideEffects(method, operation);
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
      if (post && patch && isUpsertTwin(post, patch)) {
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
