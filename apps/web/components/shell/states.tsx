'use client';

import { Plus } from 'lucide-react';
import { Button, Empty, Spinner } from '@/components/ui';
import { useShell } from '@/lib/stores/shell';

/** A gateway with no agent yet: the only thing to do is make one. */
export function NoAgents() {
  const setCreating = useShell((state) => state.setCreating);

  return (
    <Empty
      title="Bring your first agent to life"
      action={
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} />
          Create an agent
        </Button>
      }
    >
      Start with a name and instructions. Connect your providers next.
    </Empty>
  );
}

/** While a page waits for what it shows, or offers to try again once that failed. */
export function Loading({ retry }: { retry?: () => void }) {
  return (
    <div className="loading-state" role="status">
      {retry ? (
        <Button variant="secondary" onClick={retry}>
          Try loading again
        </Button>
      ) : (
        <>
          <Spinner size={32} />
          <span>Loading your workspace…</span>
        </>
      )}
    </div>
  );
}
