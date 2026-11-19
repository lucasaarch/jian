import { FILE_LINK_DEFAULT_MINUTES, FILE_LINK_MAX_MINUTES, type Run } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { FileLinks } from '../file-links/service.js';

/**
 * Temporary links to a file the agent made, offered only by a server gateway with an https://
 * public address (`Services.fileLinks`) and only to a run whose files are on that gateway: a
 * conversation working on another machine has its files there, where no link reaches.
 */
export function fileLinkTools(
  links: Pick<FileLinks, 'create' | 'revoke'>,
  run: Pick<Run, 'profileId' | 'sessionId'>,
): ToolSet {
  return {
    share_file_link: tool({
      description: `Make a temporary link to one file in the directory the agents share, for a file over the 16 MB send_file takes (a finished video), or for a service that takes a file by its URL (an avatar photo, a narration track). Anyone holding the link can download the file until it expires, so give it only to the owner or to the service that needs it, and never post it publicly. It lasts ${FILE_LINK_DEFAULT_MINUTES} minutes unless you name others, at most ${FILE_LINK_MAX_MINUTES} (7 days); files up to 2 GB; not a folder, nor anything under a hidden folder such as .ssh. The link serves the file as it is now: if the file changes or is deleted, the link stops working, and you make a new one. Answers the url, its linkId and when it expires.`,
      inputSchema: z.object({
        path: z.string().min(1).max(4096).describe('The absolute path of the file.'),
        minutes: z
          .number()
          .int()
          .min(1)
          .max(FILE_LINK_MAX_MINUTES)
          .optional()
          .describe(`How long the link works; ${FILE_LINK_DEFAULT_MINUTES} when left out.`),
      }),
      execute: async (input) => links.create(run, input),
    }),
    revoke_file_link: tool({
      description:
        'Stop a link made with share_file_link from working, at once: when the owner asks, or when the service that needed it is done. Name it by its linkId or its url.',
      inputSchema: z.object({ link: z.string().min(1).max(4096) }),
      execute: async ({ link }) => links.revoke(run.profileId, link),
    }),
  };
}
