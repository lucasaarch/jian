'use client';

import { Markdown } from '../releases/markdown';
import { Modal } from '../ui';

/** A skill's instructions as the agent reads them, rendered, in the release notes' dialog. */
export function SkillView({
  name,
  description,
  instructions,
  close,
}: {
  name: string;
  description: string;
  instructions: string;
  close: () => void;
}) {
  return (
    <Modal title={name} description={description} close={close} wide>
      <div className="release-notes">
        <Markdown text={instructions} />
      </div>
    </Modal>
  );
}
