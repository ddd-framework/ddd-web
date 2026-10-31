#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { generateSdk } from './generate';
import { linkSkills } from './link-skills';
import { consoleLogger, SdkGenerationError } from './log';

const HELP = `Usage:
  ddd-web-sdk [options]            Generate the RTK Query SDK (same as "ddd-web sdk")
  ddd-web sdk [options]
  ddd-web link-skills              Symlink the package's agent skills into .claude/skills/

SDK options:
  --config <path>       Config file (default: openapi-config.ts)
  --api <exportName>    Generate only this api entry
  --schema <url|file>   Spec source for the selected api (overrides schemaFile)
  --workspace <value>   Value for config.workspace.envVar (alias: --subdomain)
  --skip-prettier       Do not format the generated files
  --skip-tsc            Do not run tsc --noEmit after generation
  -h, --help            Show this help
`;

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  const command = first === 'sdk' || first === 'link-skills' || first === 'help' ? first : 'sdk';
  const args = command === first ? rest : argv;

  if (command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === 'link-skills') {
    linkSkills();
    return 0;
  }

  const { values } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      api: { type: 'string' },
      schema: { type: 'string' },
      workspace: { type: 'string' },
      subdomain: { type: 'string' },
      'skip-prettier': { type: 'boolean' },
      'skip-tsc': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const workspace = values.workspace ?? values.subdomain;
  await generateSdk({
    ...(values.config ? { config: values.config } : {}),
    ...(values.api ? { api: values.api } : {}),
    ...(values.schema ? { schema: values.schema } : {}),
    ...(workspace ? { workspace } : {}),
    skipPrettier: values['skip-prettier'] ?? false,
    skipTsc: values['skip-tsc'] ?? false,
  });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof SdkGenerationError || (error as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      consoleLogger.error((error as Error).message);
    } else {
      consoleLogger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    process.exit(1);
  },
);
