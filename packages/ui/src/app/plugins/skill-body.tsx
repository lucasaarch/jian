'use client';

import { skillDocument, skillFrom } from '../../components/skills/skill-fields';
import type { SkillItem } from '../../components/skills/skill-items';
import { CodeBlock } from '../../components/ui/code-block';
import { Markdown } from '../../components/ui/markdown';
import type { LibrarySkill, Skill } from '../../lib/api';
import { SkillIdentityFields, SkillInstructionsField } from './skill-form-fields';

/** A column of reading: lines short enough to follow, whatever the page's own width. */
const reading = 'grid min-w-0 max-w-[44rem] grid-cols-1 gap-5';

/**
 * What a skill is for, in full, then what the agents are told, rendered as they read it. The
 * owner cannot edit a built-in skill, so it is shown whole: what an agent was told has to be
 * readable by the person answering for it.
 */
export function SkillOverview({ item }: { item: SkillItem }) {
  return (
    <div className={reading}>
      <p className="text-sm leading-relaxed text-ink">{item.description}</p>
      <div className="markdown min-w-0 text-sm leading-relaxed text-ink/90 [overflow-wrap:anywhere]">
        <Markdown text={item.instructions} />
      </div>
    </div>
  );
}

/**
 * The skill as the document it is kept as, line by line, to read as written or to copy. Without
 * colour: Markdown's colouring takes the last line of the front matter for a heading. The block
 * starts where the details beside it do, without the margin it has inside a message.
 */
export function SkillSource({ item }: { item: SkillItem }) {
  return (
    <div className="min-w-0 [&>.code-block]:my-0">
      <CodeBlock
        text={skillDocument(item, item.held?.origin?.license)}
        language="markdown"
        wrapped
        plain
      />
    </div>
  );
}

/**
 * The overview as a form, while one of the library's skills is edited in its page. Sent by the
 * header's Save, which names it by `id`; a new opening starts from the skill again.
 */
export function SkillEditForm({
  id,
  skill,
  onSave,
}: {
  id: string;
  skill: LibrarySkill;
  onSave: (next: Omit<Skill, 'name'>) => void;
}) {
  return (
    <form
      id={id}
      aria-label={`Edit ${skill.name}`}
      className={reading}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(skillFrom(new FormData(event.currentTarget)));
      }}
    >
      <SkillIdentityFields skill={skill} />
      <SkillInstructionsField rows={18} defaultValue={skill.instructions} />
    </form>
  );
}
