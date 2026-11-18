'use client';

import type { ReactNode, RefObject } from 'react';
import { ScreenHeader } from '../../../app/screen-header';
import { InspectorBar } from '../inspector';

/**
 * The bar over an open Artifact (artifact-view.tsx). In the Inspector it is the Inspector's own
 * line; on the agent's page of every Artifact it is the screen's bar (app/screen-header.tsx), the
 * one pull requests and the file viewer have: in the host's title bar, with a rule under it.
 */
export function ArtifactBar({
  page,
  closer,
  back,
  title,
  old,
  options,
}: {
  page: boolean;
  closer?: RefObject<HTMLButtonElement | null> | undefined;
  back: ReactNode;
  title: string;
  /** The older version in view, named beside the title; none when it is the latest. */
  old?: number | undefined;
  options: ReactNode;
}) {
  const version =
    old === undefined ? null : (
      <span
        className={`shrink-0 text-xs font-normal text-muted tabular-nums ${page ? 'ml-2' : ''}`}
      >
        v{old}
      </span>
    );
  if (page) {
    return (
      <ScreenHeader
        leading={back}
        title={
          <>
            {title}
            {version}
          </>
        }
      >
        {options}
      </ScreenHeader>
    );
  }
  return (
    <InspectorBar closer={closer} options={options}>
      {back}
      <h2 className="min-w-0 truncate text-[13px] font-medium text-ink">{title}</h2>
      {version}
    </InspectorBar>
  );
}
