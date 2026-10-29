import { and, eq } from 'drizzle-orm';
import { mcpSecret } from '../agent/mcp-connect.js';
import { GATEWAY_SCOPE, type GatewayVault } from '../security/gateway-vault.js';
import type { Vault } from '../security/vault.js';
import type { Store } from '../storage/database.js';
import { mcpSecretMoves, secrets } from '../storage/schema.js';

/**
 * Finishes what migration 0071 started: the secrets of each MCP server it kept become the
 * installation's. SQL cannot do this part — a ciphertext is bound to the profile it was written
 * for — so it runs once the gateway holds the key, before it serves.
 *
 * Each move is one transaction that also deletes its row, so a gateway that stops halfway picks
 * up at the next server, and a second start finds nothing left to do. A renamed server's secrets
 * follow the new name: `mcp:notion:header:Authorization` becomes `mcp:notion_2:header:…`.
 */
export async function moveMcpSecrets(
  store: Store,
  vault: Vault,
  gatewayVault: GatewayVault,
): Promise<number> {
  const moves = await store.db.select().from(mcpSecretMoves);

  for (const move of moves) {
    const from = mcpSecret(move.fromName);
    const to = mcpSecret(move.toName);

    await store.transaction(GATEWAY_SCOPE, async (tx) => {
      const owned = await tx
        .select({ name: secrets.name })
        .from(secrets)
        .where(eq(secrets.profileId, move.profileId));

      for (const { name } of owned) {
        // The server's own address, or one of the slots under it — never a server whose name
        // merely starts the same way.
        if (name !== from && !name.startsWith(`${from}:`)) continue;

        const value = await vault.read(move.profileId, name, tx);

        if (value !== undefined)
          await gatewayVault.put(`${to}${name.slice(from.length)}`, value, tx);
        await vault.discard(move.profileId, name, tx);
      }

      await tx
        .delete(mcpSecretMoves)
        .where(
          and(
            eq(mcpSecretMoves.profileId, move.profileId),
            eq(mcpSecretMoves.fromName, move.fromName),
          ),
        );
    });
  }

  return moves.length;
}
