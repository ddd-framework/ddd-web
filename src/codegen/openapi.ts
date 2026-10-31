/** Minimal OpenAPI 3 shapes the codegen reads. Unknown keys are passed through untouched. */

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface DddContractInfo {
  contract: number;
  ddd?: string;
}

export type DddEntityAction = 'list' | 'get' | 'upsert' | 'delete' | 'action';

/** `x-ddd-entity` on an operation (Appendix A of the contract). */
export interface DddEntityExtension {
  schema: string;
  action: DddEntityAction;
  /** `path:<paramName>` or `body:<dotted.path>`. */
  identity?: string;
  derived?: boolean;
}

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, { content?: Record<string, unknown> } | undefined>;
  'x-ddd-side-effects'?: boolean;
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
  info?: { title?: string; version?: string; 'x-ddd-contract'?: DddContractInfo; [key: string]: unknown };
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
