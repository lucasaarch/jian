'use client';

import { Popover } from '@base-ui/react/popover';
import {
  Check,
  ChevronDown,
  MessageSquarePlus,
  MessagesSquare,
  Search,
  Terminal,
} from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';
import { matchesQuery } from '@/lib/search';
import { TelegramLogo, WhatsAppLogo } from '../ui';
import { type Choice, type Provider, providers } from './conversations';

const marks: Record<Provider, ReactNode> = {
  chats: <MessagesSquare size={16} aria-hidden="true" />,
  whatsapp: <WhatsAppLogo size={16} />,
  telegram: <TelegramLogo size={16} />,
  api: <Terminal size={16} aria-hidden="true" />,
};

/** The first choice of all: no conversation of its own, a new chat each time it runs. */
const NEW_CHAT = { name: 'A new chat each time', where: 'Opens a chat in Chats when it runs' };

/**
 * Where a schedule runs, picked from every conversation it can run in: searchable, grouped by
 * where each happens, each with its provider's mark. `null` is a new chat each time.
 */
export function ConversationPicker({
  value,
  choices,
  onChange,
}: {
  value: string | null;
  choices: Choice[];
  onChange: (sessionId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // A modal dialog sits in the top layer, above anything portalled to the body: the list opens
  // inside the dialog it was opened from, as the panel's selects do.
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const current = choices.find((choice) => choice.session.id === value);
  const listed = choices.filter((choice) => matchesQuery(`${choice.name} ${choice.where}`, query));
  const offerNew = matchesQuery(`${NEW_CHAT.name} ${NEW_CHAT.where} Chats`, query);
  const choose = (sessionId: string | null) => {
    onChange(sessionId);
    setOpen(false);
    setQuery('');
  };
  // Up and down walk the options, from the search box into the list and back.
  const walk = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const options = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []),
    ];
    if (!options.length) return;
    event.preventDefault();
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'ArrowDown'
        ? options[Math.min(at + 1, options.length - 1)]
        : at <= 0
          ? undefined
          : options[at - 1];
    (next ?? list.current?.parentElement?.querySelector('input'))?.focus();
  };
  const option = (
    key: string,
    sessionId: string | null,
    mark: ReactNode,
    name: string,
    where: string,
  ) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={value === sessionId}
      className="conversation-option"
      onClick={() => choose(sessionId)}
    >
      <span className="conversation-option-mark">{mark}</span>
      <span className="conversation-option-name">
        {name}
        <small>{where}</small>
      </span>
      {value === sessionId && <Check size={14} aria-hidden="true" />}
    </button>
  );

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setContainer(trigger.current?.closest<HTMLElement>('dialog, aside') ?? null);
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Popover.Trigger ref={trigger} className="conversation-picker" aria-label="Conversation">
        <span className="conversation-option-mark">
          {current ? marks[current.provider] : <MessageSquarePlus size={16} aria-hidden="true" />}
        </span>
        <span className="conversation-option-name">
          {current?.name ?? (value ? 'A deleted conversation' : NEW_CHAT.name)}
          <small>{current?.where ?? (value ? '' : NEW_CHAT.where)}</small>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal container={container ?? undefined}>
        <Popover.Positioner
          className="select-positioner"
          side="bottom"
          align="start"
          sideOffset={6}
          positionMethod="fixed"
        >
          <Popover.Popup className="model-menu conversation-picker-popup" aria-label="Conversation">
            {/* biome-ignore lint/a11y/noStaticElementInteractions: arrows move between its options. */}
            <div onKeyDown={walk}>
              <label className="model-menu-search">
                <Search size={14} aria-hidden="true" />
                <input
                  aria-label="Search conversations"
                  placeholder="Search conversations"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div ref={list} role="listbox" aria-label="Conversations">
                {providers.map(({ provider, name }) => {
                  const group = listed.filter((choice) => choice.provider === provider);
                  const fresh = provider === 'chats' && offerNew;
                  if (!group.length && !fresh) return null;

                  return (
                    <section key={provider} className="conversation-group" aria-label={name}>
                      <h3>{name}</h3>
                      {fresh &&
                        option(
                          'new',
                          null,
                          <MessageSquarePlus size={16} aria-hidden="true" />,
                          NEW_CHAT.name,
                          NEW_CHAT.where,
                        )}
                      {group.map((choice) =>
                        option(
                          choice.session.id,
                          choice.session.id,
                          marks[provider],
                          choice.name,
                          choice.where,
                        ),
                      )}
                    </section>
                  );
                })}
                {!listed.length && !offerNew && (
                  <p className="model-menu-empty">No conversation matches that search.</p>
                )}
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
