/** Minimal OpenAPI 3 shapes the codegen reads. Unknown keys are passed through untouched. */
import type { DddContractInfo, DddEntityInfo, DddOperationExtensions, HttpMethod } from '../contract/extensions';

export type { DddEntityAction, HttpMethod } from '../contract/extensions';

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const satisfies readonly HttpMethod[];

/**
 * `info.x-ddd-contract` as read from a document: the contract types from `contract`, tolerant of a missing `ddd`
 * version (the codegen only needs the contract number).
 */
export type DddContractInfoInput = Pick<DddContractInfo, 'contract'> & Partial<Pick<DddContractInfo, 'ddd'>>;

/** `x-ddd-entity` as read from a document: {@link DddEntityInfo}, tolerant of a missing `derived` flag. */
export type DddEntityExtension = Omit<DddEntityInfo, 'derived'> & Partial<Pick<DddEntityInfo, 'derived'>>;

export interface OpenApiOperation extends Omit<DddOperationExtensions, 'x-ddd-entity'> {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, { description?: string; content?: Record<string, unknown> } | undefined>;
  'x-ddd-entity'?: DddEntityExtension;
  [key: string]: unknown;
}

export type OpenApiPathItem = Partial<Record<HttpMethod, OpenApiOperation>> & Record<string, unknown>;

export interface OpenApiTag {
  name: string;
  description?: string;
}

export interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; 'x-ddd-contract'?: DddContractInfoInput; [key: string]: unknown };
  tags?: OpenApiTag[];
  paths?: Record<string, OpenApiPathItem | undefined>;
  components?: { schemas?: Record<string, unknown>; [key: string]: unknown };
  [key: string]: unknown;
}

export interface OperationRef {
  method: HttpMethod;
  path: string;
  operation: OpenApiOperation;
}

export function listOperations(doc: OpenApiDocument): OperationRef[] {
  const result: OperationRef[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!item) continue;
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation) result.push({ method, path, operation });
    }
  }
  return result;
}

export function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}
