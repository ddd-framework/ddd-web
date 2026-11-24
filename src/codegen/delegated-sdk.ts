import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LoadedConfig, ResolvedApi, SdkGeneratorMode } from './config';
import { OutputFiles } from './files';
import { typecheck } from './format';
import type { GenerateSdkOptions, GenerateSdkResult } from './generate';
import { consoleLogger, SdkGenerationError, type Logger } from './log';
import { operationKey, type OpenApiDocument } from './openapi';
import { indexOperations } from './operations';
import { commitOutput, type CommittedOutput } from './output';
import { repairMissingPathParameters } from './repair';
import { loadSpec, validateSpec } from './spec';

const packageName = 'swagger-sdk-generator';
const ownershipMarker = '.ddd-web-sdk.json';
type DelegatedMode = Exclude<SdkGeneratorMode, 'default'>;

export interface LegacySdkSource {
  name: string;
  file?: string;
  url?: string;
  onError?: string;
  outputs: Record<string, Record<string, unknown>>;
}

interface GeneratorResult {
  source: string;
  ok: boolean;
  skipped?: boolean;
  error?: Error;
  planned?: Array<{ dir: string; files: Array<{ path: string; content: string }> }>;
}

interface Generator {
  generate(
    config: { version: 4; mode: DelegatedMode; targetOptions: Record<string, unknown>; sources: LegacySdkSource[]; prune?: boolean },
    options: { cwd: string; dryRun: boolean; log: Logger & { debug(): void } },
  ): Promise<GeneratorResult[]>;
}

function loadGenerator(rootDir: string, mode: DelegatedMode): Generator {
  const require = createRequire(path.join(rootDir, 'package.json'));
  const dependency = packageName + (mode === 'legacy' ? '@^3.1' : '@^3');
  let entry: string;
  try {
    entry = require.resolve(packageName);
    if (mode === 'legacy') {
      require.resolve(packageName + '/runtime/stores');
      require.resolve(packageName + '/runtime/mocks');
    }
  } catch {
    throw new SdkGenerationError('Install ' + dependency + ' in the consuming project to use SDK mode ' + mode + '.');
  }
  const engine = require(entry) as Partial<Generator>;
  if (typeof engine.generate !== 'function') {
    throw new SdkGenerationError(packageName + ' must export generate() to use SDK mode ' + mode + '.');
  }
  return { generate: engine.generate };
}

export interface GenerateLegacySdkOptions {
  /** Explicit sources and directories for an existing SDK layout, processed in the given order. */
  sources: LegacySdkSource[];
  cwd?: string;
  dryRun?: boolean;
  targetOptions?: Record<string, unknown>;
  logger?: Logger;
}

/** Runs the legacy generator for an app that owns its spec sources and generated file layout. */
export async function generateLegacySdk(options: GenerateLegacySdkOptions): Promise<GeneratorResult[]> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const engine = loadGenerator(cwd, 'legacy');
  const logger = options.logger ?? consoleLogger;
  const results = await engine.generate({
    version: 4,
    mode: 'legacy',
    targetOptions: options.targetOptions ?? {},
    sources: options.sources,
    prune: false,
  }, { cwd, dryRun: true, log: { ...logger, debug() {} } });
  const files = new OutputFiles();
  for (const source of options.sources) {
    const result = results.find((candidate) => candidate.source === source.name);
    if (!result?.ok) throw new SdkGenerationError(source.name + ': ' + (result?.error?.message ?? 'SDK generator returned no result.'));
    if (result.skipped) continue;
    if (!result.planned) throw new SdkGenerationError(source.name + ': SDK generator returned no output plan.');
    const roots = Object.values(source.outputs).map(({ dir }) => path.resolve(cwd, String(dir)));
    for (const output of result.planned) {
      if (!roots.includes(output.dir)) {
        throw new SdkGenerationError(source.name + ': SDK generator returned an unexpected output directory.');
      }
      for (const file of output.files) {
        const target = path.resolve(output.dir, file.path);
        if (path.isAbsolute(file.path) || target === output.dir || !contains(output.dir, target)) {
          throw new SdkGenerationError(source.name + ': SDK generator returned an invalid file path: ' + file.path);
        }
        files.set(target, file.content);
      }
    }
  }
  if (!options.dryRun && files.paths().length) commitOutput(files, undefined, cwd).finalize();
  return results;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function assertGeneratedDirectory(directory: string): void {
  const entry = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (entry && (!entry.isDirectory() || (fs.readdirSync(directory).length > 0 && !fs.existsSync(path.join(directory, ownershipMarker))))) {
    throw new SdkGenerationError('Choose an empty generated SDK directory. DDD Web does not own ' + directory + '.');
  }
}

function prepareSpec(document: OpenApiDocument, api: ResolvedApi, logger: Logger): OpenApiDocument {
  const repaired = repairMissingPathParameters(document, logger);
  if (!api.skipUpdatePostTwins) return repaired;
  const { skippedTwins } = indexOperations(repaired, api.sideEffects, true);
  return {
    ...repaired,
    paths: Object.fromEntries(Object.entries(repaired.paths ?? {}).map(([url, item]) => {
      if (!item || !skippedTwins.has(operationKey('post', url))) return [url, item];
      const { post: _post, ...remaining } = item;
      return [url, remaining];
    })),
  };
}

export async function generateDelegatedSdk(
  mode: DelegatedMode,
  loaded: LoadedConfig,
  allApis: ResolvedApi[],
  apis: ResolvedApi[],
  options: GenerateSdkOptions,
  logger: Logger,
): Promise<GenerateSdkResult> {
  const { rootDir, config } = loaded;
  const generator = config.generator?.mode === mode ? config.generator : undefined;
  const modeDir = path.resolve(rootDir, generator?.outputDir ?? './src/generated-sdk', mode);
  const outputOptions: Partial<Record<string, Record<string, unknown>>> = generator?.outputs ?? {};
  const outputNames = mode === 'legacy' ? ['models', 'stores', 'mocks'] : ['models', 'client'];
  if (mode === 'future' && outputOptions.mocks) outputNames.push('mocks');
  const unsupported = Object.keys(outputOptions).filter((name) => !outputNames.includes(name));
  if (unsupported.length) throw new SdkGenerationError('Unsupported ' + mode + ' SDK outputs: ' + unsupported.join(', ') + '.');
  const stems = new Set<string>();
  const defaultModels = config.modelsDir ? [path.resolve(rootDir, config.modelsDir)] :
    allApis.map((api) => path.resolve(api.outputDir, '..', 'models'));
  const defaultPaths = [...defaultModels, ...allApis.flatMap((api) => [
    api.outputFile,
    ...['Enhanced', 'Tags', 'Requests'].map((suffix) => path.join(api.outputDir, api.stem + suffix + '.ts')),
  ])].map((file) => file.toLowerCase());
  for (const api of allApis) {
    const key = api.stem.toLowerCase();
    if (!/^[a-z\d][a-z\d._-]*$/i.test(api.stem) || stems.has(key)) {
      throw new SdkGenerationError('Opt-in SDKs need unique API output file stems made of letters, digits, dots, dashes or underscores.');
    }
    stems.add(key);
    const directory = path.join(modeDir, api.stem);
    if (defaultPaths.some((file) => contains(directory.toLowerCase(), file) || contains(file, directory.toLowerCase()))) {
      throw new SdkGenerationError('Opt-in SDK output overlaps the default SDK at ' + directory + '. Choose another generator.outputDir.');
    }
  }
  const engine = loadGenerator(rootDir, mode);
  const plans = new Map(apis.map((api) => {
    const directory = path.join(modeDir, api.stem);
    assertGeneratedDirectory(directory);
    const outputDirs = outputNames.map((name) => [name, path.join(directory, name)] as const);
    return [api.stem, { directory, outputDirs, files: new OutputFiles() }];
  }));
  const specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-web-spec-'));
  try {
    const specs = new Map<string, Promise<OpenApiDocument>>();
    const sources = await Promise.all(apis.map(async (api): Promise<LegacySdkSource> => {
      if (!specs.has(api.schemaSource)) {
        logger.info('loading ' + api.schemaSource);
        specs.set(api.schemaSource, loadSpec(api.schemaSource));
      }
      const document = await specs.get(api.schemaSource)!;
      validateSpec(document, api.schemaSource, logger);
      const file = path.join(specDir, api.stem + '.json');
      fs.writeFileSync(file, JSON.stringify(prepareSpec(document, api, logger)));
      const outputs = Object.fromEntries(plans.get(api.stem)!.outputDirs.map(([name, dir]) => [
        name, { ...outputOptions[name], dir },
      ]));
      return { name: api.stem, file, outputs };
    }));
    const results = await engine.generate({
      version: 4, mode, sources,
      targetOptions: { prettier: options.skipPrettier ? false : { resolveFrom: rootDir } },
    }, { cwd: rootDir, dryRun: true, log: { ...logger, debug() {} } });

    for (const source of sources) {
      const result = results.find((candidate) => candidate.source === source.name);
      if (!result?.ok || !result.planned?.length) {
        throw new SdkGenerationError(source.name + ': ' + (result?.error?.message ?? 'SDK generator returned no output plan.'));
      }
      const plan = plans.get(source.name)!;
      for (const run of result.planned) {
        if (!plan.outputDirs.some(([, dir]) => dir === run.dir)) {
          throw new SdkGenerationError(source.name + ': SDK generator returned an unexpected output directory.');
        }
        for (const file of run.files) {
          const target = path.resolve(run.dir, file.path);
          if (path.isAbsolute(file.path) || target === run.dir || !contains(run.dir, target) || plan.files.findPath(target)) {
            throw new SdkGenerationError(source.name + ': SDK generator returned an invalid or duplicate file path: ' + file.path);
          }
          plan.files.set(target, file.content);
        }
      }
    }
  } finally {
    fs.rmSync(specDir, { recursive: true, force: true });
  }

  const writtenFiles = [...plans.values()].flatMap((plan) => plan.files.paths());
  const committed: CommittedOutput[] = [];
  let typechecked = false;
  try {
    for (const { directory, files } of plans.values()) {
      assertGeneratedDirectory(directory);
      files.set(path.join(directory, ownershipMarker), '{"version":1}\n');
      committed.push(commitOutput(files, directory, rootDir));
    }
    if (!options.skipTsc) {
      typechecked = typecheck(rootDir, path.resolve(rootDir, config.tsconfig ?? 'tsconfig.json'), logger);
    }
  } catch (error) {
    const failures: unknown[] = [];
    for (const output of committed.reverse()) {
      try { output.rollback(); } catch (failure) { failures.push(failure); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'SDK generation failed and some output could not be restored.');
    throw error;
  }
  committed.forEach((output) => output.finalize());
  logger.info('done: ' + writtenFiles.length + ' files (' + mode + ' mode)');
  const modelsByApi = Object.fromEntries(apis.map((api) => [api.exportName, path.join(modeDir, api.stem, 'models')]));
  return {
    apis: apis.map((api) => api.exportName),
    files: writtenFiles,
    modelsDir: apis.length === 1 ? Object.values(modelsByApi)[0]! : modeDir,
    modelsByApi,
    typechecked,
  };
}
