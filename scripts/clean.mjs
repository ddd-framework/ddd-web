// Removes the build output once, before tsup runs its configs in parallel (none of them cleans: a config that
// cleans the shared output directory can delete files another config has already written).
import { rmSync } from 'node:fs';

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
