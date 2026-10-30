// The local gateway from the repository's TypeScript, for the desktop app run from source: an
// Electron utility process takes no --import, so tsx is registered here before the entry loads.
import { register } from 'tsx/esm/api';

register();
await import('../src/local.ts');
