'use client';

import { Bot, FileCode2, FolderTree, GitPullRequest, Globe, X } from 'lucide-react';
import { ScrollStrip } from '../../kit';
import { type InspectorTab, useCrew } from '../../lib/stores/crew';

function TabIcon({ tab }: { tab: InspectorTab }) {
  if (tab.kind === 'browser') return <Globe size={13} />;
  if (tab.kind === 'github') return <GitPullRequest size={13} />;
  if (tab.kind === 'changes') return <FileCode2 size={13} />;
  if (tab.kind === 'files') return <FolderTree size={13} />;
  return <Bot size={13} />;
}

/**
 * The Inspector's tabs, in one row that scrolls sideways however many are open, with no
 * scrollbar in the bar: the wheel scrolls it, an edge with more tabs fades, and the tab turned
 * to comes into view. Each tab keeps its name's width up to a limit, then ends in an ellipsis.
 */
export function InspectorTabs({
  tabs,
  following,
  id,
  label,
  onClose,
}: {
  tabs: InspectorTab[];
  following?: string;
  /** Ties each tab to the panel the host draws: `${id}-${index}`, and `${id}-panel`. */
  id: string;
  label: (tab: InspectorTab) => string;
  onClose: (tab: InspectorTab) => void;
}) {
  return (
    <ScrollStrip
      role="tablist"
      aria-label="Inspector tabs"
      active={following}
      className="flex min-w-0 items-center gap-1"
    >
      {tabs.map((tab, index) => (
        <div
          key={tab.key}
          className="flex min-w-0 shrink-0 items-center rounded-lg transition-colors hover:bg-glass-hover data-[active=true]:bg-glass-press"
          data-active={tab.key === following}
        >
          <button
            type="button"
            role="tab"
            id={`${id}-${index}`}
            aria-selected={tab.key === following}
            aria-controls={`${id}-panel`}
            tabIndex={tab.key === following ? 0 : -1}
            className="flex h-7 min-w-0 max-w-44 items-center gap-1.5 rounded-lg pr-1 pl-2 text-xs text-muted transition-colors hover:text-ink aria-selected:text-ink"
            title={tab.kind === 'browser' ? tab.title || tab.url : undefined}
            onClick={() => useCrew.getState().select(tab.key)}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : -1;
              if (next >= 0) {
                event.preventDefault();
                const selected = tabs[next];
                if (selected) {
                  useCrew.getState().select(selected.key);
                  // The strip brings it into view itself, clear of its fades.
                  document.getElementById(`${id}-${next}`)?.focus({ preventScroll: true });
                }
              }
            }}
          >
            <TabIcon tab={tab} />
            <span className="truncate">{label(tab)}</span>
          </button>
          <button
            type="button"
            aria-label={`Close ${label(tab)} tab`}
            className="mr-1 grid size-5 shrink-0 place-items-center rounded-full text-muted transition-colors hover:text-ink"
            onClick={() => onClose(tab)}
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </ScrollStrip>
  );
}
