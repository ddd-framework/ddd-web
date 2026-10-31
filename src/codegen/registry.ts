import type { Logger } from './log';
import type { OpenApiDocument } from './openapi';

/** `[key, segments]`: key = RTK-normalised namespace prefix of a type name, segments = folder path. */
export type NamespacePath = [prefix: string, segments: string[]];

/** Replicates RTK codegen's acronym normalisation for the lookup key: AI → Ai, DTOs → Dtos. */
function normalizeSegment(segment: string): string {
  return segment.replace(/([A-Z])([A-Z]+)/g, (_, first: string, rest: string) => first + rest.toLowerCase());
}

export function extractSchemaRef(description: string): string | null {
  return description.match(/schemaRef="([^"]+)"/)?.[1] ?? null;
}

function parseSchemaRef(ref: string): NamespacePath | null {
  const parts = ref.replace('#/components/schemas/', '').split('.');
  const folders = parts.slice(0, -1);
  if (folders.length === 0) return null;
  return [folders.map(normalizeSegment).join(''), folders];
}

/** Builds the namespace registry from the SchemaDefinition tags of all specs, longest key first. */
export function buildRegistry(docs: OpenApiDocument[], logger: Logger): NamespacePath[] {
  const registry = new Map<string, string[]>();
  for (const doc of docs) {
    for (const tag of doc.tags ?? []) {
      if (!tag.description?.includes('SchemaDefinition')) continue;
      const ref = extractSchemaRef(tag.description);
      const entry = ref ? parseSchemaRef(ref) : null;
      if (!entry) continue;
      const [key, segments] = entry;
      const existing = registry.get(key);
      if (existing) {
        if (existing.join('.') !== segments.join('.')) {
          logger.warn(`Registry key collision for "${key}" — keeping ${existing.join('.')}, skipping ${ref}`);
        }
        continue;
      }
      registry.set(key, segments);
    }
  }
  return [...registry.entries()].sort((a, b) => b[0].length - a[0].length);
}
