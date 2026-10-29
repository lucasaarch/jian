import type { McpServers } from './service.js';

/** What a run needs: the servers it reaches. Writing them is the owner's, through the routes. */
export type McpServerReader = Pick<McpServers, 'list'>;
