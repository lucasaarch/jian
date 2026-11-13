'use client';

import { Suspense } from 'react';
import { PageBody, PageHeading } from '../../kit';
import { useNoInspector } from '../../lib/stores/screen';
import { ActivityContent, ActivityWaiting } from './activity-content';

/**
 * The agent's activity in place of the chat, as the pull requests are: what it did, used and
 * cost. It goes with no conversation, so it has no Inspector beside it. It is read, not worked
 * in, so it has no bar of its own: it is a page of the kit's one anatomy, as settings are, wide
 * for its figures and its year.
 */
export function ActivityScreen() {
  useNoInspector();
  return (
    <div className="flex h-full min-h-0">
      <PageBody wide labelledBy="activity-title">
        <PageHeading id="activity-title" title="Activity" />
        <Suspense fallback={<ActivityWaiting />}>
          <ActivityContent />
        </Suspense>
      </PageBody>
    </div>
  );
}
