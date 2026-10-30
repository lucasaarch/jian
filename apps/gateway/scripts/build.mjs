import { execFileSync } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const run = (args) => execFileSync('pnpm', args, { cwd: root, stdio: 'inherit' });

// The panel is its own server now (apps/web); nothing of it is built into the gateway.
run(['--filter', '@jian/contracts', 'build']);
run(['--filter', '@jian/gateway', 'build:server']);
// The gateway serves the published worker, `/jian-remote.mjs`, from that package's build.
run(['--filter', '@jian-ai/remote-control', 'build']);

// A tree built before the split still holds the export; the gateway no longer reads it.
await rm(new URL('../dist/ui/', import.meta.url), { recursive: true, force: true });

// The notes travel with the build, so the panel can say what changed in the version it runs.
const notes = new URL('../dist/release-notes/', import.meta.url);
await rm(notes, { recursive: true, force: true });
await cp(new URL('../../../docs/releases/', import.meta.url), notes, { recursive: true });
