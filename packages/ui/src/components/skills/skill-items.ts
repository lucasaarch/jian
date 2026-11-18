import type { BuiltinSkill, LibrarySkill } from '../../lib/api';
import { matchesQuery } from '../../lib/search';
import { importedFrom } from './origin';

/** Whose a skill is: the owner's, an agent's, copied from a repository, or shipped with Jian. */
type SkillKind = 'yours' | 'agent' | 'imported' | 'built-in';
export type SkillFilter = SkillKind | 'all' | 'off';

export const skillFilters: { value: SkillFilter; label: string }[] = [
  { value: 'all', label: 'All skills' },
  { value: 'yours', label: 'By you' },
  { value: 'agent', label: 'By agents' },
  { value: 'imported', label: 'Imported' },
  { value: 'built-in', label: 'By Jian' },
  { value: 'off', label: 'Off' },
];

/** One skill as the panel lists it: of the library or built-in, drawn alike. */
export type SkillItem = {
  /** The kind and the name: what a list keys a skill by, and what opens it. */
  key: string;
  kind: SkillKind;
  name: string;
  description: string;
  instructions: string;
  /** Who it is owed to, as it is said: "By you", "By Zero Two", "Imported from Anthropic". */
  by: string;
  /** Its place in the library; a built-in skill has none. */
  index?: number;
  /** Whether the agents are offered it: one switch for all of them. */
  enabled: boolean;
};

/**
 * The library's skills first, in their order, then the built-in ones as the gateway lists them.
 * `author` names the agent that wrote one, from its id, and nothing for an agent since deleted.
 */
export function skillItems(
  own: LibrarySkill[],
  builtIn: BuiltinSkill[],
  author: (profileId?: string) => string | undefined,
  enabled: (name: string) => boolean,
): SkillItem[] {
  const shared = (skill: LibrarySkill | BuiltinSkill) => ({
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    enabled: enabled(skill.name),
  });

  return [
    ...own.map((skill, index): SkillItem => {
      // An agent's own first: what it wrote stays its own, wherever the idea came from. Then
      // only a skill with an address was copied from somewhere; the rest the owner wrote.
      const whose =
        skill.writtenBy === 'agent'
          ? ({ kind: 'agent', by: `By ${author(skill.authorProfileId) ?? 'an agent'}` } as const)
          : skill.origin?.url
            ? ({ kind: 'imported', by: `Imported from ${importedFrom(skill.origin.url)}` } as const)
            : ({ kind: 'yours', by: 'By you' } as const);

      return { key: `own:${skill.name}`, ...whose, ...shared(skill), index };
    }),
    ...builtIn.map(
      (skill): SkillItem => ({
        key: `built-in:${skill.name}`,
        kind: 'built-in',
        by: 'By Jian',
        ...shared(skill),
      }),
    ),
  ];
}

/** What kind of thing a row is and whose, under its description: "Skill · By Jian". */
export const skillMeta = (item: SkillItem) => `Skill · ${item.by}`;

/** The skills a search and the filter leave: found by name, what they are for and whose. */
export function filterSkills(items: SkillItem[], query: string, filter: SkillFilter) {
  return items.filter(
    (item) =>
      (filter === 'all' || (filter === 'off' ? !item.enabled : item.kind === filter)) &&
      matchesQuery(`${item.name} ${item.description} ${item.by}`, query),
  );
}
