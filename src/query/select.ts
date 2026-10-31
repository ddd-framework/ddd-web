import { assertPropertyPath } from './literals';

/** Select input: a list of property paths or one comma-separated string. */
export type SelectInput = string | readonly string[];

/**
 * Builds the `select` value, e.g. `id,title,author.name`; `undefined` for no fields. Mirrors
 * `SelectOptions::fromString()`: properties unquoted, separated by `,`, dot-notation allowed; duplicates are dropped.
 */
export function buildSelect(input: SelectInput | null | undefined): string | undefined {
  if (input === null || input === undefined) {
    return undefined;
  }
  const fields = (typeof input === 'string' ? input.split(',') : [...input])
    .map(field => field.trim())
    .filter(field => field.length > 0);
  if (fields.length === 0) {
    return undefined;
  }
  for (const field of fields) {
    assertPropertyPath(field, 'select property');
  }
  return [...new Set(fields)].join(',');
}
