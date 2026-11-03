'use client';

import { Popover } from '@base-ui/react/popover';
import { useQuery } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Folder,
  FolderOpen,
  Laptop,
  Plus,
  Search,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { SwitchControl } from '../../kit';
import { useAppearance } from '../../lib/appearance';
import { useGatewayMode } from '../../lib/gateway-mode';
import { usePhone } from '../../lib/phone';
import { queries } from '../../lib/query/profile';
import {
  type ChatPlace,
  FROM_SCRATCH,
  folderName,
  type RepositoryItem,
  useWorkspaces,
  type WorkspaceChoice,
} from '../../lib/stores/workspace-choice';
import { useThisMachine } from '../../lib/this-machine';
import { GitHubLogo } from '../ui';
import { choiceLabel } from './workspace-choice';

const trigger =
  'flex h-8 max-w-56 items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted transition-colors hover:bg-glass-hover hover:text-ink data-popup-open:bg-glass-hover disabled:pointer-events-none aria-disabled:pointer-events-none';
/** The kit's glass, as every list that opens over the composer draws it: see `.model-menu`. */
const panel = 'glass flex flex-col overflow-hidden rounded-xl text-[13px] text-ink';
/** How `.model-menu` comes and goes: the first list goes by the popover's state, as it does. */
const arrive = { opacity: 0, y: 4, scale: 0.98 };
const motions =
  'origin-(--transform-origin) outline-none transition-[opacity,translate,scale] duration-150 data-starting-style:translate-y-1 data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:translate-y-1 data-ending-style:scale-[0.98] data-ending-style:opacity-0';
/** A line across the whole list, out over the padding of what it parts. */
const divider = '-mx-1.5 my-1 border-t border-glass-edge';
const row =
  // No fade: passing over a list, the row left behind would still be lit beside the next.
  'flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left hover:bg-glass-press focus-visible:bg-glass-press disabled:pointer-events-none disabled:opacity-50';
const icon = 'grid size-4 shrink-0 place-items-center text-muted';

function Row({
  mark,
  children,
  chosen = false,
  more = false,
  disabled = false,
  onClick,
  onHover,
}: {
  mark: ReactNode;
  children: ReactNode;
  chosen?: boolean;
  more?: boolean;
  disabled?: boolean;
  onClick: (row: HTMLElement) => void;
  onHover?: (row: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      className={row}
      disabled={disabled}
      aria-pressed={more ? undefined : chosen}
      onClick={(event) => onClick(event.currentTarget)}
      onMouseEnter={(event) => onHover?.(event.currentTarget)}
    >
      <span className={icon} aria-hidden="true">
        {mark}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {chosen && <Check size={14} className="shrink-0 text-muted" aria-hidden="true" />}
      {more && <ChevronRight size={14} className="shrink-0 text-muted" aria-hidden="true" />}
    </button>
  );
}

function SearchBox({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="model-menu-search">
      <Search size={14} className="shrink-0" aria-hidden="true" />
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function MultipleRow({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const label = useId();
  return (
    <div className="flex h-8 items-center gap-2.5 px-2.5">
      <span className={icon} aria-hidden="true">
        <Folder size={14} />
      </span>
      <span id={label} className="min-w-0 flex-1 truncate">
        Select multiple
      </span>
      <SwitchControl checked={on} onCheckedChange={onChange} labelledBy={label} />
    </div>
  );
}

const matches = (text: string, query: string) =>
  text.toLowerCase().includes(query.trim().toLowerCase());
const repositoryKey = (item: RepositoryItem) => item.name.toLowerCase();
/** The composer is under the choosers: opening down would cover what is being written. */
const ALWAYS_ABOVE = { side: 'none' } as const;
/** How long the pointer stays on a row before its list opens, in milliseconds. */
const REST_MS = 90;
/** The `p-1.5` around a list's rows, in pixels. */
const LIST_PADDING = 6;
/** How close to the window's edge a list may come, in pixels. */
const WINDOW_MARGIN = 8;

/**
 * What a new chat works on: nothing yet, folders of this computer or repositories on GitHub. A list
 * of what was used lately, and beside it each place's whole list. Only a chat that starts turns a
 * choice into anything on the gateway.
 */
export function ProjectPicker({
  choice,
  onChange,
}: {
  choice: WorkspaceChoice;
  onChange: (choice: WorkspaceChoice) => void;
}) {
  const machine = useThisMachine();
  const server = useGatewayMode() !== 'local';
  const phone = usePhone();
  const { still } = useAppearance();
  const folders = useWorkspaces((state) => state.folders);
  const remember = useWorkspaces((state) => state.remember);
  const [open, setOpen] = useState(false);
  const [opened, setPlace] = useState<'here' | 'cloud'>();
  // How far above the first list's foot the row that opened a place ends: its list ends level
  // with that row and grows upward, away from the composer.
  const [level, setLevel] = useState(0);
  const beside = useRef<HTMLDivElement>(null);
  const [inner, setInner] = useState('');
  const [multiple, setMultiple] = useState(false);
  const { data: repositories = [] } = useQuery({
    ...queries.githubRepositories(),
    enabled: server,
  });
  const { data: integration } = useQuery({ ...queries.githubIntegration(), enabled: server });
  // One repository reached through two accounts is still one.
  const listed: RepositoryItem[] = repositories
    .filter((item, index) => repositories.findIndex((other) => other.id === item.id) === index)
    .map((item) => ({
      name: item.fullName,
      githubAccountId: item.accountId,
      githubRepositoryId: item.id,
    }));
  // A desktop app's own gateway has nothing but this computer, so there is nothing to pick between.
  const only = !server && Boolean(machine);
  const place = only ? 'here' : opened;

  // Level with its row, unless that would run off the top of the window.
  useLayoutEffect(() => {
    const element = beside.current;
    if (!element || !place || only || phone) return;
    element.style.bottom = `${level}px`;
    const over = WINDOW_MARGIN - element.getBoundingClientRect().top;
    if (over > 0) element.style.bottom = `${level - over}px`;
  });

  // Only where the pointer rests: passing over the rows on the way somewhere opens and closes
  // nothing, which would redraw the glass of both lists under it at every row.
  const resting = useRef<ReturnType<typeof setTimeout>>(undefined);
  const afterRest = (then: () => void) => {
    clearTimeout(resting.current);
    resting.current = setTimeout(then, REST_MS);
  };
  useEffect(() => () => clearTimeout(resting.current), []);

  const close = () => {
    clearTimeout(resting.current);
    setOpen(false);
    setPlace(undefined);
    setInner('');
    setMultiple(false);
  };
  const openPlace = (next: 'here' | 'cloud') => (row: HTMLElement) => {
    clearTimeout(resting.current);
    setPlace(next);
    const list = row.offsetParent as HTMLElement | null;
    // Less the padding each list has at its foot, so its last row and this one stand level.
    setLevel(list ? list.offsetHeight - row.offsetTop - row.offsetHeight - LIST_PADDING : 0);
  };
  const chooseFolder = (path: string) => {
    remember(path);
    const already = choice.kind === 'folders' ? choice.folders : [];
    if (!multiple) {
      onChange({ kind: 'folders', folders: [path] });
      return close();
    }
    const next = already.includes(path)
      ? already.filter((item) => item !== path)
      : [...already, path];
    onChange(next.length ? { kind: 'folders', folders: next } : FROM_SCRATCH);
  };
  const chooseRepository = (repository: RepositoryItem) => {
    const already = choice.kind === 'repositories' ? choice.repositories : [];
    const at: ChatPlace = choice.kind === 'folders' ? { kind: 'cloud' } : choice.place;
    if (!multiple) {
      onChange({ kind: 'repositories', repositories: [repository], place: at });
      return close();
    }
    const has = already.some((item) => repositoryKey(item) === repositoryKey(repository));
    const next = has
      ? already.filter((item) => repositoryKey(item) !== repositoryKey(repository))
      : [...already, repository];
    onChange(next.length ? { kind: 'repositories', repositories: next, place: at } : FROM_SCRATCH);
  };
  const openFolder = async () => {
    const path = await machine?.pickFolder();
    if (path) chooseFolder(path);
  };
  const folderChosen = (path: string) => choice.kind === 'folders' && choice.folders.includes(path);
  const repositoryChosen = (repository: RepositoryItem) =>
    choice.kind === 'repositories' &&
    choice.repositories.some((item) => repositoryKey(item) === repositoryKey(repository));

  const folderRow = (path: string, label: string) => (
    <Row
      key={path}
      mark={<Folder size={14} />}
      chosen={folderChosen(path)}
      onClick={() => chooseFolder(path)}
    >
      {label}
    </Row>
  );
  const repositoryRow = (repository: RepositoryItem) => (
    <Row
      key={repository.name}
      mark={<GitHubLogo size={13} />}
      chosen={repositoryChosen(repository)}
      onClick={() => chooseRepository(repository)}
    >
      {repository.name}
    </Row>
  );

  const shownFolders = folders.filter((path) => matches(path, inner));
  const shownRepositories = listed.filter((item) => matches(item.name, inner));
  const empty =
    place === 'here'
      ? folders.length
        ? 'No folder matches.'
        : 'No folders yet. Open one to start.'
      : listed.length
        ? 'No repository matches.'
        : integration?.accounts.length
          ? 'No repository is shared with this gateway yet.'
          : 'Connect GitHub under Apps in Settings to work on a repository.';
  const nothing = place === 'here' ? !shownFolders.length : !shownRepositories.length;

  const places = place && (
    <motion.div
      key="place"
      ref={beside}
      className={`${panel} w-80 phone:w-[calc(100vw-2rem)] ${only || phone ? '' : 'absolute left-full ml-2 origin-bottom-left'}`}
      // Alone, it is the popover itself, which comes and goes with its own motion.
      initial={still || only ? false : arrive}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={still ? { opacity: 0 } : arrive}
      transition={{ duration: still ? 0 : 0.15, ease: 'easeOut' }}
    >
      <SearchBox
        label={place === 'here' ? 'Search folders' : 'Search repositories'}
        value={inner}
        onChange={setInner}
      />
      <div className="p-1.5">
        <MultipleRow on={multiple} onChange={setMultiple} />
        <div className={divider} />
        {/* A thin scrollbar out over the panel's padding, so it takes nothing from the rows. */}
        <div className="-mr-1.5 grid max-h-60 gap-px overflow-y-auto [scrollbar-gutter:stable] [&::-webkit-scrollbar]:w-1.5">
          {place === 'here'
            ? shownFolders.map((path) => folderRow(path, path))
            : shownRepositories.map(repositoryRow)}
          {nothing && <p className="px-2.5 py-2 text-[13px] text-muted">{empty}</p>}
        </div>
        {place === 'here' && (
          <>
            <div className={divider} />
            <Row mark={<FolderOpen size={14} />} onClick={() => void openFolder()}>
              Open folder…
            </Row>
            {only && (
              <Row
                mark={<Plus size={14} />}
                chosen={choice.kind === 'scratch'}
                onClick={() => {
                  onChange(FROM_SCRATCH);
                  close();
                }}
              >
                Start from scratch
              </Row>
            )}
          </>
        )}
      </div>
    </motion.div>
  );

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <Popover.Trigger aria-label="Project" className={trigger}>
        <span className="truncate">{choiceLabel(choice, folderName)}</span>
        <ChevronDown size={13} className="shrink-0" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="start"
          sideOffset={6}
          collisionAvoidance={ALWAYS_ABOVE}
          className="z-50"
        >
          <Popover.Popup className={`relative ${motions}`}>
            {/* On a phone there is no room beside it: a place's list takes the list's turn. */}
            {!only && !(phone && place) && (
              <div className={`${panel} w-64 phone:w-[calc(100vw-2rem)]`}>
                <div className="grid gap-px p-1.5">
                  <Row
                    mark={<Plus size={14} />}
                    chosen={choice.kind === 'scratch'}
                    onClick={() => {
                      onChange(FROM_SCRATCH);
                      close();
                    }}
                    onHover={() => afterRest(() => setPlace(undefined))}
                  >
                    Start from scratch
                  </Row>
                  {machine && (
                    <Row
                      mark={<Laptop size={14} />}
                      more
                      onClick={openPlace('here')}
                      onHover={(row) => afterRest(() => openPlace('here')(row))}
                    >
                      This Machine
                    </Row>
                  )}
                  {server && (
                    <Row
                      mark={<Cloud size={14} />}
                      more
                      onClick={openPlace('cloud')}
                      onHover={(row) => afterRest(() => openPlace('cloud')(row))}
                    >
                      Remote Gateway
                    </Row>
                  )}
                </div>
              </div>
            )}
            <AnimatePresence>{places}</AnimatePresence>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Where a repository is worked on: filled in by what was chosen, and changed here. Folders of this
 * computer are where they are, so it only says so. A desktop app's own gateway has no other place,
 * and shows none of this.
 */
export function PlacePicker({
  choice,
  onChange,
}: {
  choice: WorkspaceChoice;
  onChange: (choice: WorkspaceChoice) => void;
}) {
  const machine = useThisMachine();
  const server = useGatewayMode() === 'server';
  const remember = useWorkspaces((state) => state.remember);
  const [open, setOpen] = useState(false);
  const { data: machines = [] } = useQuery({ ...queries.remoteMachines(), enabled: server });
  if (!server) return null;

  if (choice.kind === 'folders') {
    return (
      <span className={`${trigger} pointer-events-none`}>
        <Laptop size={14} aria-hidden="true" />
        This Machine
      </span>
    );
  }

  const others = machines.filter((item) => item.online && item.id !== machine?.machineId);
  const at = choice.place;
  const named =
    at.kind === 'cloud'
      ? 'Remote Gateway'
      : at.kind === 'here'
        ? 'This Machine'
        : (machines.find((item) => item.id === at.id)?.name ?? 'A machine');
  const mark =
    // Whatever is not this computer is elsewhere, the gateway or another machine alike.
    at.kind === 'here' ? <Laptop size={14} /> : <Cloud size={14} />;
  const put = (place: ChatPlace) => {
    onChange({ ...choice, place });
    setOpen(false);
  };
  const here = async () => {
    const path = await machine?.pickFolder();
    if (!path) return;
    if (choice.kind === 'scratch') {
      // From scratch there is nothing to clone: the folder is what the chat works on.
      remember(path);
      onChange({ kind: 'folders', folders: [path] });
      setOpen(false);
      return;
    }
    put({ kind: 'here', cloneInto: path });
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger aria-label="Local" className={trigger}>
        <span className="shrink-0" aria-hidden="true">
          {mark}
        </span>
        <span className="truncate">{named}</span>
        <ChevronDown size={13} className="shrink-0" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="start"
          sideOffset={6}
          collisionAvoidance={ALWAYS_ABOVE}
          className="z-50"
        >
          <Popover.Popup className={`${panel} w-56 p-1.5 ${motions}`}>
            <Row
              mark={<Cloud size={14} />}
              chosen={at.kind === 'cloud'}
              onClick={() => put({ kind: 'cloud' })}
            >
              Remote Gateway
            </Row>
            {others.map((item) => (
              <Row
                key={item.id}
                mark={<Cloud size={14} />}
                chosen={at.kind === 'machine' && at.id === item.id}
                onClick={() => put({ kind: 'machine', id: item.id })}
              >
                {item.name}
              </Row>
            ))}
            {machine && (
              <Row
                mark={<Laptop size={14} />}
                chosen={at.kind === 'here'}
                disabled={!machine.machineId}
                onClick={() => void here()}
              >
                {machine.machineId ? 'This Machine' : 'This Machine (connecting)'}
              </Row>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
