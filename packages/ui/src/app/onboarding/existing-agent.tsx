'use client';

import { useState } from 'react';
import { Action, SelectField } from '../../kit';
import { AgentHero } from '../../kit/agent-hero';
import type { Profile } from '../../lib/api';

/** Returning owners can finish the introduction without creating a duplicate agent. */
export function ExistingAgent({
  agents,
  select,
  create,
}: {
  agents: Profile[];
  select: (agent: Profile) => void;
  create: () => void;
}) {
  const [chosen, setChosen] = useState(agents[0]?.id ?? '');
  const agent = agents.find((item) => item.id === chosen) ?? agents[0];
  if (!agent) return null;
  return (
    <div className="mx-auto grid w-full max-w-md gap-7">
      <AgentHero name={agent.name} avatar={agent.avatar} summary={agent.summary} />
      {agents.length > 1 && (
        <SelectField
          label="Agent"
          value={agent.id}
          options={agents.map((item) => ({ value: item.id, label: item.name }))}
          onValueChange={setChosen}
        />
      )}
      <div className="flex flex-wrap justify-center gap-3">
        <Action tone="quiet" onClick={create}>
          Create a new agent
        </Action>
        <Action tone="primary" onClick={() => select(agent)}>
          Continue with {agent.name}
        </Action>
      </div>
    </div>
  );
}
