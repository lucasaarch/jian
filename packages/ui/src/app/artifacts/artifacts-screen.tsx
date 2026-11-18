'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArtifactView } from '../../components/sessions/artifacts/artifact-view';
import { TYPE_NAME } from '../../components/sessions/artifacts/source';
import {
  Action,
  ConfirmDialog,
  FilterSelect,
  PageBody,
  PageHeading,
  PageToolbar,
  SearchField,
  SettingsGroup,
  SettingsRowsSkeleton,
  SkeletonRegion,
} from '../../kit';
import type { ProfileArtifact, SessionArtifact } from '../../lib/api';
import { conversationName } from '../../lib/conversation-name';
import { agentPath } from '../../lib/navigation';
import { useAgents, useContacts, useProjects, useSessions } from '../../lib/query/agent';
import { panelApi } from '../../lib/query/client';
import { useCrew } from '../../lib/stores/crew';
import { useNoInspector } from '../../lib/stores/screen';
import { useRouter } from '../../platform/navigation';
import { ArtifactsList } from './artifacts-list';
import {
  type ArtifactsFilter,
  type ArtifactsPageApi,
  useDeleteArtifact,
  useProfileArtifacts,
} from './use-profile-artifacts';

/** How long typing rests before the search goes to the gateway, in milliseconds. */
const SEARCH_PAUSE = 300;

const ALL_TYPES = '';
const TYPES = [
  { value: ALL_TYPES, label: 'All types' },
  ...Object.entries(TYPE_NAME).map(([value, label]) => ({ value, label })),
];

/**
 * Every Artifact the agent made, whatever the conversation, in place of the chat as its activity
 * is: a page of the kit's one anatomy, searched by title and narrowed to one type. One opens here
 * as it does in the Inspector, drawn by the same view (artifact-view.tsx), which then takes the
 * page's whole room; its conversation is one step away, and it can be deleted for good. It goes
 * with no conversation, so it has no Inspector beside it.
 */
export function ArtifactsScreen({
  profileId,
  api = panelApi(),
}: {
  profileId: string;
  api?: ArtifactsPageApi;
}) {
  useNoInspector();
  const router = useRouter();
  const sessions = useSessions();
  const projects = useProjects();
  const contacts = useContacts();
  const profiles = useAgents();
  const [typed, setTyped] = useState('');
  const [filter, setFilter] = useState<ArtifactsFilter>({ q: '', type: ALL_TYPES });
  useEffect(() => {
    const timer = setTimeout(
      () => setFilter((was) => (was.q === typed.trim() ? was : { ...was, q: typed.trim() })),
      SEARCH_PAUSE,
    );
    return () => clearTimeout(timer);
  }, [typed]);
  // The one being read, and whether it opened to be edited.
  const [opened, setOpened] = useState<{ id: string; editing: boolean }>();
  const [doomed, setDoomed] = useState<ProfileArtifact>();
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const read = useProfileArtifacts(api, profileId, filter);
  const remove = useDeleteArtifact(api, profileId);
  const artifacts = read.data?.pages.flatMap((page) => page.items);
  // One deleted meanwhile, by the agent's conversation going, is no longer listed: the list.
  const artifact = opened && artifacts?.find((item) => item.id === opened.id);
  const narrowed = Boolean(filter.q || filter.type);

  const conversation = (item: ProfileArtifact) => {
    const session = sessions.find((one) => one.id === item.sessionId);
    return session
      ? conversationName(session, { projects, contacts, profiles })
      : (item.sessionTitle ?? 'Untitled conversation');
  };

  const go = (item: ProfileArtifact) => {
    useCrew.getState().showArtifactIn(item.sessionId, item.id);
    router.push(agentPath(profileId, `sessions/${encodeURIComponent(item.sessionId)}`));
  };

  const destroy = async () => {
    if (!doomed || deleting) return;
    setDeleting(true);
    try {
      await remove(doomed);
      toast.success(`Deleted ${doomed.title}.`);
      setAsking(false);
    } catch (error) {
      // The gateway's own sentence, as when a paired phone asks.
      toast.error(error instanceof Error ? error.message : 'The Artifact could not be deleted.');
    } finally {
      setDeleting(false);
    }
  };

  if (artifact && opened) {
    return (
      // The view is the Inspector's, but its bar is the screen's own (screen-header.tsx), in the
      // host's title bar; what lies under it keeps a page's wider edge.
      <section
        aria-label={artifact.title}
        className="flex h-full min-h-0 flex-col [--inspector-inset:1rem] phone:[--inspector-inset:0.5rem]"
      >
        <ArtifactView
          key={artifact.id}
          api={api}
          profileId={profileId}
          artifact={artifact}
          page
          onBack={() => setOpened(undefined)}
          startEditing={opened.editing}
        />
      </section>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <PageBody wide labelledBy="artifacts-title">
        <PageHeading
          id="artifacts-title"
          title="Artifacts"
          description="Everything this agent made to look at, in any conversation."
        />
        <PageToolbar>
          <SearchField
            label="Search artifacts"
            className="min-w-44 flex-1"
            value={typed}
            onValueChange={setTyped}
          />
          <FilterSelect
            label="Type"
            value={filter.type}
            options={TYPES}
            onValueChange={(type) =>
              setFilter((was) => ({ ...was, type: type as SessionArtifact['type'] | '' }))
            }
          />
        </PageToolbar>
        {read.isError && !artifacts ? (
          <div className="grid justify-items-start gap-3">
            <p role="alert" className="text-sm text-muted">
              {read.error instanceof Error
                ? read.error.message
                : 'The Artifacts could not be read.'}
            </p>
            <Action onClick={() => void read.refetch()}>Try again</Action>
          </div>
        ) : !artifacts ? (
          <SkeletonRegion label="Loading artifacts…">
            <SettingsGroup>
              <SettingsRowsSkeleton count={4} />
            </SettingsGroup>
          </SkeletonRegion>
        ) : (
          <>
            <ArtifactsList
              artifacts={artifacts}
              empty={
                narrowed
                  ? 'No Artifact matches.'
                  : 'Nothing here yet. What the agent makes to look at, such as a page, a document, a diagram or a deck of slides, is kept here.'
              }
              conversation={conversation}
              onOpen={(item) => setOpened({ id: item.id, editing: false })}
              onEdit={(item) => setOpened({ id: item.id, editing: true })}
              onGo={go}
              onDelete={(item) => {
                setDoomed(item);
                setAsking(true);
              }}
            />
            {read.hasNextPage && (
              <div className="flex justify-center">
                <Action busy={read.isFetchingNextPage} onClick={() => void read.fetchNextPage()}>
                  Load more
                </Action>
              </div>
            )}
          </>
        )}
      </PageBody>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Delete ${doomed?.title ?? ''}?`}
        action="Delete Artifact"
        busy={deleting}
        run={() => void destroy()}
      >
        {doomed
          ? `It is deleted for good with ${doomed.version === 1 ? 'its one version' : `all ${doomed.version} of its versions`}${doomed.visibility === 'public' ? ', and its public link stops working' : ''}. The conversation it was made in stays as it is.`
          : ''}
      </ConfirmDialog>
    </div>
  );
}
