import { cp, rm } from 'node:fs/promises';

// Next leaves the static assets and public/ out of the standalone tree, expecting a CDN. This
// server is the only host they have, so `pnpm start` runs the same layout the image ships.
const app = new URL('../', import.meta.url);
const tree = new URL('.next/standalone/apps/web/', app);

for (const [from, to] of [
  ['public/', 'public/'],
  ['.next/static/', '.next/static/'],
]) {
  await rm(new URL(to, tree), { recursive: true, force: true });
  await cp(new URL(from, app), new URL(to, tree), { recursive: true });
}
