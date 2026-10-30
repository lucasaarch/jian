'use client';

import { useState } from 'react';
import type { SectionActions } from '../../components/props';
import {
  switchBuiltinSkill,
  switchedMessage,
  useBuiltinSkills,
} from '../../components/skills/built-in-skills';
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowsSkeleton,
  StatusPill,
  SwitchControl,
} from '../../kit';
import type { BuiltinSkill, Profile } from '../../lib/api';
import { matchesQuery } from '../../lib/search';
import { SkillReading } from './skill-reading';
import { ListSearch, ListSearchWaiting } from './skill-search';

/** The gateway ships a long list; a screenful of switches stands for it. */
const BuiltinRowsWaiting = () => <SettingsRowsSkeleton count={6} toggle buttons={0} />;

/** The built-in skills while the agent is read, before the group can read its list. */
export function SkillBuiltinWaiting() {
  return (
    <SettingsGroup title="Built in" note={<ListSearchWaiting />}>
      <BuiltinRowsWaiting />
    </SettingsGroup>
  );
}

/**
 * The skills that ship with the gateway, a line each: its name, which opens it to read, and its
 * switch. A switch moves the moment it is pressed, while the gateway is told; refused, it goes
 * back to what the agent holds, and the refusal is said.
 */
export function SkillBuiltinGroup({
  profile,
  api,
  mutate,
}: Pick<SectionActions, 'api' | 'mutate'> & { profile: Profile }) {
  const { skills, loading, error } = useBuiltinSkills(profile, api);
  const [query, setQuery] = useState('');
  // What was pressed and not yet answered, over what the agent last said.
  const [pressed, setPressed] = useState<Record<string, boolean>>({});
  const [reading, setReading] = useState<BuiltinSkill>();
  const [readingOpen, setReadingOpen] = useState(false);
  const shown = skills.filter((skill) => matchesQuery(`${skill.name} ${skill.description}`, query));
  // From the profile, not the list: the profile is read again before an answered switch lets go,
  // while the list is fetched after it, and would show the old value for a moment.
  const enabled = (name: string) => pressed[name] ?? !profile.disabledSkills.includes(name);

  const flip = async (name: string, on: boolean) => {
    setPressed((current) => ({ ...current, [name]: on }));
    await mutate(
      () => api.updateProfile(profile.id, switchBuiltinSkill(profile, name, on)),
      switchedMessage(name, on),
    );
    setPressed(({ [name]: _settled, ...rest }) => rest);
  };

  const note = error ? (
    <span role="alert" className="text-bad">
      {error}
    </span>
  ) : (
    // Already there while the list is read: what is typed filters it once it arrives.
    <ListSearch label="Search built-in skills" value={query} onChange={setQuery} />
  );

  return (
    <>
      <SettingsGroup
        title="Built in"
        note={note}
        loading={loading && !error && 'Loading built-in skills…'}
      >
        {loading && !error && <BuiltinRowsWaiting />}
        {shown.map((skill) => (
          <SettingsRow
            key={skill.name}
            title={
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label={`Read ${skill.name}`}
                  onClick={() => {
                    setReading(skill);
                    setReadingOpen(true);
                  }}
                  className="truncate text-left underline-offset-2 hover:underline"
                >
                  {skill.name}
                </button>
                {!enabled(skill.name) && <StatusPill>Off</StatusPill>}
              </span>
            }
          >
            <SwitchControl
              label={skill.name}
              checked={enabled(skill.name)}
              onCheckedChange={(on) => void flip(skill.name, on)}
            />
          </SettingsRow>
        ))}
        {!loading && !error && shown.length === 0 && (
          <SettingsRow title={skills.length ? 'No built-in skill matches.' : 'None offered.'} />
        )}
      </SettingsGroup>
      <SkillReading
        skill={reading}
        enabled={reading ? enabled(reading.name) : true}
        open={readingOpen}
        onOpenChange={setReadingOpen}
      />
    </>
  );
}
