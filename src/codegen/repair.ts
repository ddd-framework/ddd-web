import type { Logger } from './log';
import type { OpenApiDocument } from './openapi';
import { listOperations } from './openapi';

interface ParameterLike {
  name?: string;
  in?: string;
  $ref?: string;
}

/**
 * Adds a `string` path parameter for every `{placeholder}` an operation does not declare. RTK codegen
 * aborts on such operations; the backend should declare them, so each repair is reported.
 * Returns a copy when something was repaired, the original document otherwise.
 */
export function repairMissingPathParameters(doc: OpenApiDocument, logger: Logger): OpenApiDocument {
  const repairs: Array<{ path: string; method: string; names: string[] }> = [];
  for (const { method, path, operation } of listOperations(doc)) {
    const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    if (placeholders.length === 0) continue;
    const pathLevel = (doc.paths?.[path]?.parameters as ParameterLike[] | undefined) ?? [];
    const declared = new Set(
      [...pathLevel, ...((operation.parameters as ParameterLike[] | undefined) ?? [])]
        .filter((parameter) => parameter.in === 'path' || parameter.$ref !== undefined)
        .map((parameter) => parameter.name ?? parameter.$ref?.split('/').pop()),
    );
    const missing = placeholders.filter((name) => !declared.has(name));
    if (missing.length > 0) repairs.push({ path, method, names: missing });
  }
  if (repairs.length === 0) return doc;

  const copy = structuredClone(doc);
  for (const { path, method, names } of repairs) {
    const operation = copy.paths![path]![method as 'get'];
    operation!.parameters = [
      ...names.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
      ...(operation!.parameters ?? []),
    ];
    logger.warn(`${method.toUpperCase()} ${path}: path parameter(s) ${names.join(', ')} not declared in the spec — added as string.`);
  }
  return copy;
}
