'use client';

import {
  Bot,
  CalendarDays,
  Coins,
  Database,
  GraduationCap,
  MessageCircle,
  Server,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { CountUp, ProviderLogo, TelegramLogo, WhatsAppLogo } from '../../components/ui';
import { Skeleton, StatusPill } from '../../kit';
import type { ProfileStats } from '../../lib/api';
import { LOCALE } from '../../lib/format';
import { card, Part, Share, Tile, Tiles } from './figures';
import { compact, money, percent } from './format';

const tokensOf = (mix: ProfileStats['period']['tokens']) => mix.input + mix.cached + mix.output;

/** How many models show before the rest wait behind a button. */
const FIRST_MODELS = 4;

/**
 * The period's headline numbers, where its tokens went, and what the cost leaves out. Before the
 * numbers arrive it draws their shape: the models as if there were some, since there usually are,
 * and the subscription windows not at all, since most agents have none.
 */
export function UsageSummary({ stats }: { stats?: ProfileStats }) {
  const period = stats?.period;

  return (
    <>
      <Tiles>
        <Tile icon={<Sparkles size={16} />} label="Total tokens">
          {period && <CountUp value={tokensOf(period.tokens)} format={compact} />}
        </Tile>
        <Tile icon={<Coins size={16} />} label="Est. cost">
          {period && (period.cost === null ? '—' : <CountUp value={period.cost} format={money} />)}
        </Tile>
        <Tile icon={<CalendarDays size={16} />} label="Active days">
          {period && <CountUp value={period.activeDays} />}
        </Tile>
        <Tile icon={<Database size={16} />} label="Cache share">
          {period && percent(period.tokens.cached, period.tokens.input + period.tokens.cached)}
        </Tile>
      </Tiles>
      <Mix tokens={period?.tokens} />
      {!stats ? <ModelCardsWaiting /> : stats.models.length > 0 && <ModelCards stats={stats} />}
      {stats && <SubscriptionLimits subscriptions={stats.subscriptions} />}
      <p className="px-1 text-xs leading-relaxed text-muted">
        Cost is estimated from list prices in the models.dev catalog, not from a provider's bill.
        {period &&
          period.unpricedTokens > 0 &&
          ` ${compact(period.unpricedTokens)} tokens used a subscription or a model without a known price and are not in it.`}
      </p>
    </>
  );
}

const mixParts = [
  { key: 'input', label: 'New input', tone: 'bg-ink/80' },
  { key: 'cached', label: 'From cache', tone: 'bg-ink/45' },
  { key: 'output', label: 'Output', tone: 'bg-ink/20' },
] as const;

/** Where the tokens went: read fresh, read from the provider's cache, and written. */
function Mix({ tokens }: { tokens?: ProfileStats['period']['tokens'] }) {
  const all = tokens ? tokensOf(tokens) : 0;

  return (
    <section className={`${card} grid gap-3 p-4`} aria-label="Token mix">
      <div className="grid gap-0.5">
        <h3 className="text-[13px] font-medium text-ink">Token mix</h3>
        <p className="text-xs text-muted">
          The context sent fresh, the part a provider served from its cache, and the answers.
        </p>
      </div>
      {tokens ? (
        <div className="flex h-2 overflow-hidden rounded-full bg-ink/10" aria-hidden="true">
          {mixParts.map((part) => (
            <span
              key={part.key}
              className={part.tone}
              style={{ width: `${all ? (tokens[part.key] / all) * 100 : 0}%` }}
            />
          ))}
        </div>
      ) : (
        <Skeleton className="h-2 rounded-full" />
      )}
      <dl className="grid grid-cols-3 gap-3">
        {mixParts.map((part) => (
          <div key={part.key} className="grid gap-0.5">
            <dt className="flex items-center gap-1.5 text-xs text-muted">
              <span className={`size-2 rounded-full ${part.tone}`} aria-hidden="true" />
              {part.label}
            </dt>
            <dd className="m-0 flex items-baseline gap-1.5 text-sm font-medium text-ink tabular-nums">
              {tokens ? (
                <>
                  <CountUp value={tokens[part.key]} format={compact} />
                  <small className="text-muted">{percent(tokens[part.key], all)}</small>
                </>
              ) : (
                <Skeleton className="my-0.5 h-4 w-20" />
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const providerLogo = (provider: string) =>
  provider === 'openai-codex' ? 'openai' : provider === 'openai-compatible' ? undefined : provider;

const billingLabels = {
  metered: 'API key',
  subscription: 'Subscription',
  unknown: 'No list price',
} as const;

/** One card per model used in the period, with the share of the period's tokens it took. */
export function ModelCards({ stats }: { stats: ProfileStats }) {
  const all = tokensOf(stats.period.tokens);
  const [expanded, setExpanded] = useState(false);
  const models = expanded ? stats.models : stats.models.slice(0, FIRST_MODELS);
  const turns = stats.period.turns;

  return (
    <Part
      title="Models"
      action={<StatusPill>{`${turns} ${turns === 1 ? 'turn' : 'turns'}`}</StatusPill>}
    >
      <ul className="grid grid-cols-2 gap-2.5 phone:grid-cols-1" aria-label="Model usage">
        {models.map((model) => {
          const tokens = tokensOf(model.tokens);
          const logo = providerLogo(model.provider);
          return (
            <li
              key={`${model.provider}:${model.modelId}:${model.billing}`}
              className={`${card} grid gap-3 p-4`}
            >
              <header className="flex min-w-0 items-center gap-2">
                <span className="text-muted" aria-hidden="true">
                  {logo ? <ProviderLogo kind={logo} size={16} /> : <Server size={16} />}
                </span>
                <strong className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                  {model.modelId}
                </strong>
                <StatusPill>{billingLabels[model.billing]}</StatusPill>
              </header>
              <dl className="grid grid-cols-3 gap-2">
                <Figure label="Tokens">
                  <CountUp value={tokens} format={compact} />
                </Figure>
                <Figure label="Turns">
                  <CountUp value={model.turns} />
                </Figure>
                <Figure label="Cost">
                  {model.cost !== null ? (
                    <CountUp value={model.cost} format={money} />
                  ) : model.billing === 'subscription' ? (
                    'Included'
                  ) : (
                    '—'
                  )}
                </Figure>
              </dl>
              <div className="grid gap-1.5">
                <Share part={tokens} whole={all} />
                <small className="text-muted">{percent(tokens, all)} of tokens</small>
              </div>
            </li>
          );
        })}
      </ul>
      {stats.models.length > FIRST_MODELS && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="w-fit px-1 text-xs font-medium text-muted transition-colors hover:text-ink"
        >
          {expanded ? 'Show fewer models' : `Show all ${stats.models.length} models`}
        </button>
      )}
    </Part>
  );
}

/**
 * The models' part before the numbers arrive: one row of cards, the height of the cards to come,
 * built from the same pieces so the row does not move when they land. A block standing for a
 * line of text sits in a box one line of that text tall (`1lh`), so it takes the line's height.
 */
function ModelCardsWaiting() {
  return (
    <Part title="Models" action={<Skeleton className="h-5 w-16 rounded-full" />}>
      <ul className="grid grid-cols-2 gap-2.5 phone:grid-cols-1">
        {[0, 1].map((index) => (
          <li key={index} className={`${card} grid gap-3 p-4 ${index ? 'phone:hidden' : ''}`}>
            <header className="flex min-w-0 items-center gap-2">
              <Skeleton className="size-4" />
              <span className="flex h-[1lh] min-w-0 flex-1 items-center text-[13px]">
                <Skeleton className="h-3.5 w-2/5" />
              </span>
              <Skeleton className="h-5 w-16 rounded-full" />
            </header>
            <dl className="grid grid-cols-3 gap-2">
              {['Tokens', 'Turns', 'Cost'].map((label) => (
                <Figure key={label} label={label}>
                  <Skeleton className="my-0.5 h-4 w-12" />
                </Figure>
              ))}
            </dl>
            <div className="grid gap-1.5">
              <Skeleton className="h-1 rounded-full" />
              <small className="flex h-[1lh] items-center">
                <Skeleton className="h-3 w-24" />
              </small>
            </div>
          </li>
        ))}
      </ul>
    </Part>
  );
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="m-0 text-sm font-medium text-ink tabular-nums">{children}</dd>
    </div>
  );
}

/** How much of each subscription's windows the period's work used, where a provider says. */
function SubscriptionLimits({ subscriptions }: { subscriptions: ProfileStats['subscriptions'] }) {
  const available = subscriptions.filter(
    (subscription) =>
      subscription.status === 'available' && (subscription.fiveHour || subscription.weekly),
  );
  if (available.length === 0) return null;

  return (
    <Part title="Subscription limits">
      <ul className="grid grid-cols-2 gap-2.5 phone:grid-cols-1">
        {available.map((subscription) => {
          const codex = subscription.provider === 'codex';
          // Codex reports its weekly window alone; Claude, a five-hour one beside it.
          const windows = codex
            ? ([['Weekly window', subscription.weekly]] as const)
            : ([
                ['5-hour window', subscription.fiveHour],
                ['Weekly window', subscription.weekly],
              ] as const);
          return (
            <li
              key={subscription.provider}
              aria-label={codex ? 'Codex' : 'Claude'}
              className={`${card} grid gap-3 p-4`}
            >
              <header className="flex items-center gap-2">
                <span className="text-muted" aria-hidden="true">
                  <ProviderLogo kind={codex ? 'openai' : 'anthropic'} size={16} />
                </span>
                <strong className="text-[13px] font-medium text-ink">
                  {codex ? 'Codex' : 'Claude'}
                </strong>
              </header>
              <dl className="grid gap-3">
                {windows.map(([label, window]) => (
                  <div key={label} className="grid gap-1.5">
                    <dt className="flex items-baseline justify-between gap-3 text-xs text-muted">
                      {label}
                      <span className="font-medium text-ink tabular-nums">
                        {window ? `${window.usedPercent.toFixed(0)}% used` : 'Unavailable'}
                      </span>
                    </dt>
                    {window && (
                      <dd className="m-0 grid gap-1">
                        <Share part={window.usedPercent} whole={100} />
                        {window.resetsAt && (
                          <small className="text-muted">
                            Resets {new Date(window.resetsAt).toLocaleString(LOCALE)}
                          </small>
                        )}
                      </dd>
                    )}
                  </div>
                ))}
              </dl>
            </li>
          );
        })}
      </ul>
    </Part>
  );
}

/** A channel the panel does not know reads as the API server, as the conversations do. */
const apiServer = { label: 'API Server', icon: <Terminal size={16} /> };

const channels: Record<string, { label: string; icon: ReactNode }> = {
  whatsapp: { label: 'WhatsApp (Baileys)', icon: <WhatsAppLogo size={16} /> },
  'whatsapp-business': { label: 'WhatsApp Business (Meta)', icon: <WhatsAppLogo size={16} /> },
  telegram: { label: 'Telegram', icon: <TelegramLogo size={16} /> },
  gateway: { label: 'Gateway', icon: <MessageCircle size={16} /> },
  agent: { label: 'Agents', icon: <Bot size={16} /> },
  learning: { label: 'Learning', icon: <GraduationCap size={16} /> },
  api: apiServer,
};

/** Where the work came from: each channel's conversations, turns and tokens in the period. */
export function ChannelCards({ stats }: { stats: ProfileStats }) {
  return (
    <ul className="grid grid-cols-3 gap-2.5 phone:grid-cols-1">
      {stats.channels.map((channel) => {
        const kind = channels[channel.channel] ?? apiServer;
        return (
          <li key={channel.channel} className={`${card} grid gap-2 p-4`}>
            <header className="flex min-w-0 items-center gap-2">
              <span className="text-muted" aria-hidden="true">
                {kind.icon}
              </span>
              <strong className="truncate text-[13px] font-medium text-ink">{kind.label}</strong>
            </header>
            <p className="text-sm text-ink tabular-nums">
              <CountUp value={channel.turns} /> {channel.turns === 1 ? 'turn' : 'turns'} ·{' '}
              {channel.conversations}{' '}
              {channel.conversations === 1 ? 'conversation' : 'conversations'}
            </p>
            <small className="text-muted tabular-nums">
              <CountUp value={channel.tokens} format={compact} /> tokens
            </small>
          </li>
        );
      })}
    </ul>
  );
}
