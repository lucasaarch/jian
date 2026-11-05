import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setHelpersRoot, setRefusedFolders } from '@jian/remote-core';
import { isCliEntry, main } from './main.ts';
import { configDir } from './paths.ts';

// The published worker is this one file with its helpers beside it, in `macos/`, `linux/` and
// `windows/`: in the package's dist, and where install copies both, ~/.config/jian-remote.
setHelpersRoot(dirname(fileURLToPath(import.meta.url)));
// The token and config live here: no file operation from a gateway may read or change them.
setRefusedFolders([configDir]);

if (isCliEntry()) await main();
