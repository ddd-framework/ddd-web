import { afterEach, describe, expect, it } from 'vitest';
import { generateSdk, silentLogger } from '../../src/codegen/index';
import { apiEntry, createApp, read, removeApp, SAMPLE_SPEC } from './helpers';

const apps: string[] = [];
afterEach(() => {
  while (apps.length) removeApp(apps.pop()!);
});

describe('filterEndpoints and the tag list', () => {
  it('lists only the tags of the endpoints that are generated', async () => {
    const app = createApp();
    apps.push(app);
    const result = await generateSdk({
      cwd: app,
      config: {
        apis: [
          apiEntry(SAMPLE_SPEC, {
            filterEndpoints: (_name: string, definition: { path: string }) => !definition.path.includes('/authors'),
          }),
        ],
      },
      logger: silentLogger,
    });
    expect(result).toMatchObject({ typechecked: true });
    expect(read(app, 'src/api/adminApiTags.ts')).toContain('export const adminApiTagTypes = ["Books"] as const;');
    expect(read(app, 'src/api/adminApiEnhanced.ts')).not.toContain('Authors');
  }, 60_000);
});
