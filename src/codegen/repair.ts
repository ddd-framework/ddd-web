import type { Logger } from './log';
import type { OpenApiDocument } from './openapi';
import { listOperations } from './openapi';

interface ParameterLike {
  name?: string;
  in?: string;
  $ref?: string;
}

/** Resolves a local `#/components/parameters/…` reference (also chained); other values are returned as they are. */
function resolveParameter(doc: OpenApiDocument, parameter: ParameterLike): ParameterLike | null {
  let current: ParameterLike | undefined = parameter;
  for (let hops = 0; current?.$ref !== undefined && hops < 10; hops++) {
    const match = /^#\/components\/parameters\/(.+)$/.exec(current.$ref);
    if (!match) return null;
    const name = match[1]!.replace(/~1/g, '/').replace(/~0/g, '~');
    current = (doc.components?.parameters as Record<string, ParameterLike> | undefined)?.[name];
  }
  return current && current.$ref === undefined ? current : null;
}

/**
 * Adds a `string` path parameter for every `{placeholder}` an operation does not declare. RTK codegen
 * aborts on such operations; the backend should declare them, so each repair is reported. `$ref` parameters are
 * resolved and judged by their actual `name` / `in`.
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
        .map((parameter) => resolveParameter(doc, parameter))
        .filter((parameter): parameter is ParameterLike => parameter !== null && parameter.in === 'path')
        .map((parameter) => parameter.name),
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
