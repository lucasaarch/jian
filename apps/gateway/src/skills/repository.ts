import { type LibrarySkill, OPT_IN_SKILLS } from '@jian/contracts';
import { asc, eq } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { gatewaySettings, skills } from '../storage/schema.js';
import type { SkillLibraryState } from './builtin/index.js';

/** The setting that names what is switched off, built-in and library skills alike. */
const DISABLED_SKILLS = 'disabledSkills';

type Row = typeof skills.$inferSelect;

function toSkill(row: Row, enabled: boolean): LibrarySkill {
  return {
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    ...(row.origin ? { origin: row.origin } : {}),
    ...(row.writtenBy ? { writtenBy: row.writtenBy } : {}),
    ...(row.authorProfileId ? { authorProfileId: row.authorProfileId } : {}),
    enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Until the owner switches anything, the opt-in skills are what is off. */
async function disabledSkills(db: Queryable): Promise<string[]> {
  const [row] = await db
    .select({ value: gatewaySettings.value })
    .from(gatewaySettings)
    .where(eq(gatewaySettings.key, DISABLED_SKILLS))
    .limit(1);

  return row ? (row.value as string[]) : [...OPT_IN_SKILLS];
}

/** In the order they were added; those added together, as an import adds them, by name. */
export async function readSkillLibrary(db: Queryable): Promise<SkillLibraryState> {
  const disabled = await disabledSkills(db);
  const off = new Set(disabled);
  const rows = await db.select().from(skills).orderBy(asc(skills.createdAt), asc(skills.name));

  return { skills: rows.map((row) => toSkill(row, !off.has(row.name))), disabled };
}

export async function writeDisabledSkills(db: Queryable, names: string[], at: Date): Promise<void> {
  const value = [...new Set(names)];

  await db
    .insert(gatewaySettings)
    .values({ key: DISABLED_SKILLS, value, updatedAt: at })
    .onConflictDoUpdate({ target: gatewaySettings.key, set: { value, updatedAt: at } });
}
