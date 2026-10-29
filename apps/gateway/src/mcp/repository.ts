import type { McpServer } from '@jian/contracts';
import { asc } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { mcpServers } from '../storage/schema.js';

/** In the owner's order, which is the order a run's tool catalog reads in. */
export async function listMcpServers(db: Queryable): Promise<McpServer[]> {
  const rows = await db.select().from(mcpServers).orderBy(asc(mcpServers.position));

  return rows.map((row) => row.server);
}

/** The list is replaced whole, so a server's place in it is where the owner put it. */
export async function replaceMcpServers(
  db: Queryable,
  servers: McpServer[],
  at: Date,
): Promise<void> {
  // A server that stays keeps the date it was first connected.
  const created = new Map(
    (
      await db.select({ name: mcpServers.name, createdAt: mcpServers.createdAt }).from(mcpServers)
    ).map((row) => [row.name, row.createdAt]),
  );

  await db.delete(mcpServers);

  if (servers.length) {
    await db.insert(mcpServers).values(
      servers.map((server, position) => ({
        name: server.name,
        server,
        position,
        createdAt: created.get(server.name) ?? at,
        updatedAt: at,
      })),
    );
  }
}
