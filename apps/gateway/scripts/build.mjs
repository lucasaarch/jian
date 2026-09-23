import { execFileSync } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const run = (args) => execFileSync('pnpm', args, { cwd: root, stdio: 'inherit' });

run(['--filter', '@jian/contracts', 'build']);
run(['--filter', '@jian/sdk', 'build']);
run(['--filter', '@jian/gateway-ui', 'build']);
run(['--filter', '@jian/gateway', 'build:server']);

const destination = new URL('../dist/ui/', import.meta.url);
await rm(destination, { recursive: true, force: true });
await cp(new URL('../../gateway-ui/out/', import.meta.url), destination, { recursive: true });
console.log('Gateway UI embedded at /ui.');

// The notes travel with the build, so the panel can say what changed in the version it runs.
const notes = new URL('../dist/release-notes/', import.meta.url);
await rm(notes, { recursive: true, force: true });
await cp(new URL('../../../docs/releases/', import.meta.url), notes, { recursive: true });
