import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useHelpersRoot } from '@jian/remote-core';
import { isCliEntry, main } from './main.ts';

// The published worker is this one file with its helpers beside it, in `macos/`, `linux/` and
// `windows/`: in the package's dist, and where install copies both, ~/.config/jian-remote.
useHelpersRoot(dirname(fileURLToPath(import.meta.url)));

if (isCliEntry()) await main();
