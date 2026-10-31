import * as fs from 'node:fs';
import { isUrl } from './config';
import { SdkGenerationError, type Logger } from './log';
import type { OpenApiDocument } from './openapi';

/** Contract numbers (`info.x-ddd-contract.contract`) this codegen understands. */
export const SUPPORTED_CONTRACT = { min: 1, max: 1 } as const;

export const SCHEMA_DEFINITION_MARKUP = '<SchemaDefinition schemaRef=';

/** Loads a spec from an http(s) URL or a local JSON file. Each source is read once per run by the caller. */
export async function loadSpec(source: string, timeoutMs = 60_000): Promise<OpenApiDocument> {
  let text: string;
  if (isUrl(source)) {
    let response: Response;
    try {
      response = await fetch(source, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new SdkGenerationError(`Could not fetch spec ${source}: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new SdkGenerationError(`Could not fetch spec ${source}: HTTP ${response.status} ${response.statusText}`);
    }
    text = await response.text();
  } else {
    if (!fs.existsSync(source)) throw new SdkGenerationError(`Spec file not found: ${source}`);
    text = fs.readFileSync(source, 'utf-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SdkGenerationError(`Spec ${source} is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !('paths' in parsed)) {
    throw new SdkGenerationError(`Spec ${source} is not an OpenAPI document (no "paths").`);
  }
  return parsed as OpenApiDocument;
}

/**
 * Checks the parts of the DDD contract the codegen depends on. Aborts on an unsupported contract
 * version and on a spec without SchemaDefinition tag markup (fetched with `removeSchemaTags=1`).
 */
export function validateSpec(doc: OpenApiDocument, source: string, logger: Logger): void {
  const contract = doc.info?.['x-ddd-contract'];
  if (contract === undefined) {
    logger.warn(`${source}: no info.x-ddd-contract — assuming a pre-contract DDD spec.`);
  } else {
    const number = typeof contract === 'object' && contract ? contract.contract : undefined;
    if (typeof number !== 'number' || number < SUPPORTED_CONTRACT.min || number > SUPPORTED_CONTRACT.max) {
      throw new SdkGenerationError(
        `${source}: DDD contract ${JSON.stringify(number ?? contract)} is not supported by this @mgamadeus/ddd-web ` +
          `(supported: ${SUPPORTED_CONTRACT.min}–${SUPPORTED_CONTRACT.max}). Update @mgamadeus/ddd-web or the backend.`,
      );
    }
  }
  const hasSchemaTags = (doc.tags ?? []).some((tag) => tag.description?.includes(SCHEMA_DEFINITION_MARKUP));
  if (!hasSchemaTags) {
    throw new SdkGenerationError(
      `${source}: no <SchemaDefinition schemaRef="…"/> markup in tags[].description. The codegen needs it to ` +
        `place models into namespace folders — fetch the spec without removeSchemaTags=1.`,
    );
  }
}
