'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';
import type { SectionProps } from '../props';
import { Button, Field } from '../ui';

export function SkillImport({
  profile,
  api,
  mutate,
  busy,
}: Pick<SectionProps, 'profile' | 'api' | 'mutate' | 'busy'>) {
  const [url, setUrl] = useState('');

  return (
    <form
      className="skill-import"
      method="post"
      action="/ui/"
      onSubmit={async (event) => {
        event.preventDefault();

        if (!url.trim()) {
          return;
        }

        if (await mutate(() => api.importSkill(profile.id, url.trim()), 'Skill imported.')) {
          setUrl('');
        }
      }}
    >
      <Field label="Import from a repository">
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://github.com/owner/repository/tree/main/skills/deploy"
          inputMode="url"
          aria-describedby="skill-import-hint"
        />
      </Field>
      <Button type="submit" busy={busy} disabled={!url.trim()}>
        <Download size={16} />
        Importar
      </Button>
      <p id="skill-import-hint" className="skill-import-hint">
        The GitHub address of a skill, or of a folder of skills. The instructions are copied once.
      </p>
    </form>
  );
}
