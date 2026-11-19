'use client';

import { FolderPlus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArtifactView } from '../../components/sessions/artifacts/artifact-view';
import { TYPE_FILTERS } from '../../components/sessions/artifacts/source';
import {
  Action,
  FilterSelect,
  PageBody,
  PageHeading,
  PageToolbar,
  SearchField,
  SectionHeading,
  SkeletonRegion,
  surfaceCard,
} from '../../kit';
import type { ProfileArtifact, SessionArtifact } from '../../lib/api';
import { agentPath, artifactsPath, newChatPath } from '../../lib/navigation';
import { useProjects } from '../../lib/query/agent';
import { panelApi } from '../../lib/query/client';
import { useCrew } from '../../lib/stores/crew';
import { draftKey, useDrafts } from '../../lib/stores/drafts';
import { sendNow } from '../../lib/stores/outbox';
import { useNoInspector } from '../../lib/stores/screen';
import { useRouter, useSearchParams } from '../../platform/navigation';
import type { CardActions } from './artifact-card';
import { attempt, useArtifactDialogs } from './artifact-dialogs';
import { ArtifactFolders } from './artifact-folders';
import { ArtifactStarters } from './artifact-starters';
import { ArtifactsGrid, ArtifactsGridSkeleton } from './artifacts-grid';
import { ALL, EVERYTHING, homeName, placeProject, placeQuery, placesOf } from './folders';
import {
  type ArtifactsFilter,
  type ArtifactsPageApi,
  useArtifactFolders,
  useArtifactKeeping,
  useArtifactsPageFollow,
  useProfileArtifacts,
} from './use-profile-artifacts';

/** How long typing rests before the search goes to the gateway, in milliseconds. */
const SEARCH_PAUSE = 300;

/**
 * Every Artifact the agent made, whatever the conversation, in place of the chat as its activity
 * is: a page of the kit's one anatomy, searched by title and narrowed to one type. They are
 * cards in a grid, the pinned ones first, kept in folders: the project of the conversation each
 * was made in until the owner moves it to a folder of their own. A row of shortcuts starts a
 * conversation that asks for a new one. One opens here as it does in the Inspector, drawn by the
 * same view (artifact-view.tsx), which then takes the page's whole room. It goes with no
 * conversation, so it has no Inspector beside it. The one open is in the address
 * (`?artifact=`), so the browser's back comes to the cards as the view's own back does.
 */
export function ArtifactsScreen({
  profileId,
  api = panelApi(),
}: {
  profileId: string;
  api?: ArtifactsPageApi;
}) {
  useNoInspector();
  useArtifactsPageFollow(profileId);
  const router = useRouter();
  const projects = useProjects();
  const [typed, setTyped] = useState('');
  const [filter, setFilter] = useState<ArtifactsFilter>({ q: '', type: '' });
  useEffect(() => {
    const timer = setTimeout(
      () => setFilter((was) => (was.q === typed.trim() ? was : { ...was, q: typed.trim() })),
      SEARCH_PAUSE,
    );
    return () => clearTimeout(timer);
  }, [typed]);
  const [placeKey, setPlaceKey] = useState(ALL);
  const opened = useSearchParams().get('artifact') ?? undefined;
  // The one last opened from the cards, whose way back is the history's step back; one the
  // address opened has nothing behind it here, and the cards take its place instead.
  const pushed = useRef<string>(undefined);
  const open = (id: string) => {
    pushed.current = id;
    router.push(`${artifactsPath(profileId)}?artifact=${encodeURIComponent(id)}`);
  };
  const close = () => {
    const back = opened !== undefined && pushed.current === opened;
    pushed.current = undefined;
    if (back) router.back();
    else router.replace(artifactsPath(profileId));
  };

  const found = useArtifactFolders(api, profileId).data;
  const places = useMemo(() => placesOf(found), [found]);
  // A place that is gone, as a folder just deleted, leaves the page looking at all of them.
  const place = places.find((one) => one.key === placeKey) ?? EVERYTHING;
  const reading = { ...filter, ...placeQuery(place) };
  const pinned = useProfileArtifacts(api, profileId, { ...reading, pinned: 'true' });
  const rest = useProfileArtifacts(api, profileId, { ...reading, pinned: 'false' });
  const first = pinned.data?.pages.flatMap((page) => page.items);
  const others = rest.data?.pages.flatMap((page) => page.items);
  const narrowed = Boolean(filter.q || filter.type);
  // One deleted meanwhile, by the agent's conversation going, is no longer listed: the grid.
  const artifact = opened
    ? [...(first ?? []), ...(others ?? [])].find((item) => item.id === opened)
    : undefined;

  const keeping = useArtifactKeeping(api, profileId);
  const { name, doom, dialogs } = useArtifactDialogs(keeping, (folder) =>
    setPlaceKey(`folder:${folder.id}`),
  );
  const home = (item: ProfileArtifact) => homeName(item, projects);

  const on: CardActions = {
    open: (item) => open(item.id),
    pin: (item) => void attempt(() => keeping.change(item, { pinned: !item.pinned })),
    rename: (item) => name({ kind: 'artifact', artifact: item }),
    duplicate: (item) => void attempt(() => keeping.duplicate(item), `Duplicated ${item.title}.`),
    go: (item) => {
      useCrew.getState().showArtifactIn(item.sessionId, item.id);
      router.push(agentPath(profileId, `sessions/${encodeURIComponent(item.sessionId)}`));
    },
    move: (item, folderId) => {
      const to = folderId
        ? found?.folders.find((folder) => folder.id === folderId)?.name
        : home(item);
      void attempt(() => keeping.change(item, { folderId }), `Moved to ${to ?? 'the folder'}.`);
    },
    moveToNew: (item) => name({ kind: 'new', moving: item }),
    delete: (item) => doom({ artifact: item }),
  };

  // The new conversation's field reads what was left written for it, which is how a request
  // begun here is found there; in a project's folder, it starts in that project.
  const start = (prompt: string) => {
    useDrafts.getState().write(draftKey(profileId), prompt);
    router.push(newChatPath(profileId, placeProject(place)));
  };

  if (artifact) {
    const send = api.send;
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
          onBack={close}
          // Asked in the conversation it was made in, which is where the agent then mends it,
          // in the Inspector: the page goes there with it.
          onFix={
            send &&
            ((text) => {
              sendNow({
                sessionId: artifact.sessionId,
                text,
                mediaIds: [],
                deliver: (key) => send(profileId, artifact.sessionId, text, [], key),
                delivered: () => {},
              });
              on.go(artifact);
            })
          }
        />
      </section>
    );
  }

  const failed = pinned.isError ? pinned.error : rest.isError ? rest.error : undefined;
  const grid = { api, profileId, folders: found?.folders ?? [], home, on };

  return (
    <div className="flex h-full min-h-0">
      <PageBody labelledBy="artifacts-title">
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
            options={TYPE_FILTERS}
            onValueChange={(type) =>
              setFilter((was) => ({ ...was, type: type as SessionArtifact['type'] | '' }))
            }
          />
          <Action tone="outline" size="field" onClick={() => name({ kind: 'new' })}>
            <FolderPlus size={14} aria-hidden="true" />
            New folder
          </Action>
        </PageToolbar>
        {places.length > 1 && (
          <ArtifactFolders
            places={places}
            at={place}
            onGo={setPlaceKey}
            onRename={(folder) => name({ kind: 'folder', folder })}
            onDelete={(folder) => doom({ folder })}
          />
        )}
        {!narrowed && <ArtifactStarters onStart={start} />}
        {failed && !(first && others) ? (
          <div className="grid justify-items-start gap-3">
            <p role="alert" className="text-sm text-muted">
              {failed instanceof Error ? failed.message : 'The Artifacts could not be read.'}
            </p>
            <Action onClick={() => void Promise.all([pinned.refetch(), rest.refetch()])}>
              Try again
            </Action>
          </div>
        ) : !(first && others) ? (
          <SkeletonRegion label="Loading artifacts…">
            <ArtifactsGridSkeleton />
          </SkeletonRegion>
        ) : (
          <>
            {first.length > 0 && (
              <section aria-label="Pinned" className="grid min-w-0 grid-cols-1 gap-2">
                <SectionHeading title="Pinned" />
                <ArtifactsGrid label="Pinned artifacts" artifacts={first} {...grid} />
              </section>
            )}
            {others.length > 0 ? (
              <section aria-label="Artifacts" className="grid min-w-0 grid-cols-1 gap-2">
                {first.length > 0 && <SectionHeading title="Everything else" />}
                <ArtifactsGrid label="Artifacts" artifacts={others} {...grid} />
              </section>
            ) : (
              first.length === 0 && (
                <p className={`px-4 py-3 text-[13px] text-muted ${surfaceCard}`}>
                  {narrowed
                    ? 'No Artifact matches.'
                    : place.key === ALL
                      ? 'Nothing here yet. What the agent makes to look at, such as a page, a document, a diagram or slides, is kept here.'
                      : 'Nothing in this folder yet. Move an Artifact here from the menu on its card.'}
                </p>
              )
            )}
            {rest.hasNextPage && (
              <div className="flex justify-center">
                <Action busy={rest.isFetchingNextPage} onClick={() => void rest.fetchNextPage()}>
                  Load more
                </Action>
              </div>
            )}
          </>
        )}
      </PageBody>
      {dialogs}
    </div>
  );
}
