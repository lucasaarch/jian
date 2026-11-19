import { sql } from 'drizzle-orm';
import { secretForms } from '../../src/secrets/forms.js';
import type { testServices } from './services.js';

/** Every row of every table, as text: what a backup of the installation would carry. */
export async function everythingStored(services: Awaited<ReturnType<typeof testServices>>) {
  const read = async <T>(query: ReturnType<typeof sql>) =>
    ((await services.store.db.execute(query)) as unknown as { rows: T[] }).rows;
  const tables = await read<{ name: string }>(
    sql`select table_name as name from information_schema.tables where table_schema = 'public'`,
  );
  const rows: string[] = [];
  for (const { name } of tables) {
    const found = await read<{ row: string }>(
      sql`select t::text as row from ${sql.identifier(name)} t`,
    );
    rows.push(...found.map((item) => item.row));
  }
  return rows.join('\n');
}

/** Which forms of `value` a text gives away: empty when every one of them was masked. */
export const leaksOf = (value: string) => (text: string) =>
  secretForms(value).filter((form) => text.includes(form));
