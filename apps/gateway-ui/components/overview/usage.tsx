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
import { type MouseEvent, type ReactNode, useRef, useState } from 'react';
import type { ProfileStats } from '../../lib/api';
import { LOCALE } from '../../lib/format';
import { toolLabels } from '../sessions/progress';
import { CountUp, ProviderLogo, TelegramLogo, WhatsAppLogo } from '../ui';
import { compact, money, percent } from './format';

export const periods = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '3660', label: 'All time' },
];

const tokensOf = (mix: ProfileStats['period']['tokens']) => mix.input + mix.cached + mix.output;

/** A number with its label and a mark, as the tiles across the top of each section show it. */
export function Tile({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="stat-tile">
      <span className="stat-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="stat-copy">
        <strong>{children}</strong>
        <small>{label}</small>
      </span>
    </div>
  );
}

/** Half the tooltip's width: how close to an edge it may sit before it would be cut off. */
const TIP_REACH = 84;

const longDay: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
};

const tokenCount = (tokens: number) =>
  tokens ? `${tokens.toLocaleString('en')} tokens` : 'No tokens';

const dayLabel = (day: string, options: Intl.DateTimeFormatOptions) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(LOCALE, options);

/**
 * Every day of the period as a square, darker as more tokens were used, so a quiet week and a
 * busy one read at a glance. Levels are cut from this period's own busiest day.
 */
function Intensity({ stats }: { stats: ProfileStats }) {
  const { period } = stats;
  const card = useRef<HTMLElement>(null);
  const [hover, setHover] = useState<{ day: string; tokens: number; x: number; y: number }>();
  const days = Math.min(period.days, 90);
  const used = new Map(period.daily.map((item) => [item.day, item.tokens]));
  const busiest = Math.max(1, ...period.daily.map((item) => item.tokens));
  const best = period.daily.reduce<(typeof period.daily)[number] | undefined>(
    (top, item) => (!top || item.tokens > top.tokens ? item : top),
    undefined,
  );
  const today = new Date();
  const cells = Array.from({ length: days }, (_, index) => {
    const date = new Date(today);

    date.setDate(today.getDate() - (days - 1 - index));

    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const tokens = used.get(day) ?? 0;

    return {
      day,
      tokens,
      level: tokens ? Math.min(4, 1 + Math.floor(((tokens - 1) / busiest) * 4)) : 0,
    };
  });

  return (
    <section className="stat-card intensity-card" ref={card}>
      <header>
        <div>
          <h3>Daily intensity</h3>
          <p>Tokens used each day{period.days > 90 ? ', over the last 90 days' : ''}.</p>
        </div>
        {best && (
          <span className="stat-chip">
            Best: {dayLabel(best.day, { day: 'numeric', month: 'short' })}
          </span>
        )}
      </header>
      <div className="intensity" data-days={days}>
        {cells.map((cell) => (
          <span
            key={cell.day}
            className={`heatmap-day level-${cell.level}`}
            role="img"
            aria-label={`${dayLabel(cell.day, longDay)}: ${tokenCount(cell.tokens)}`}
            onMouseLeave={() => setHover(undefined)}
            onMouseEnter={(event: MouseEvent<HTMLSpanElement>) => {
              const box = card.current?.getBoundingClientRect();
              const square = event.currentTarget.getBoundingClientRect();

              if (!box) return;

              setHover({
                day: cell.day,
                tokens: cell.tokens,
                x: Math.min(
                  Math.max(square.left - box.left + square.width / 2, TIP_REACH),
                  box.width - TIP_REACH,
                ),
                y: square.top - box.top,
              });
            }}
          />
        ))}
      </div>
      {hover && (
        <div className="heatmap-tip" role="tooltip" style={{ left: hover.x, top: hover.y }}>
          <strong>{dayLabel(hover.day, longDay)}</strong>
          <span>{tokenCount(hover.tokens)}</span>
        </div>
      )}
      <footer>
        <span>{cells[0] && dayLabel(cells[0].day, { day: 'numeric', month: 'short' })}</span>
        <span className="intensity-legend" aria-hidden="true">
          Less
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className={`heatmap-day level-${level}`} />
          ))}
          More
        </span>
        <span>Today</span>
      </footer>
    </section>
  );
}

/** Where the tokens went: read fresh, read from the provider's cache, and written. */
function Mix({ stats }: { stats: ProfileStats }) {
  const { tokens } = stats.period;
  const all = tokensOf(tokens);
  const parts = [
    { key: 'input', label: 'New input', value: tokens.input },
    { key: 'cached', label: 'From cache', value: tokens.cached },
    { key: 'output', label: 'Output', value: tokens.output },
  ];

  return (
    <section className="stat-card">
      <header>
        <div>
          <h3>Token mix</h3>
          <p>The context sent fresh, the part a provider served from its cache, and the answers.</p>
        </div>
      </header>
      <div className="mix-bar" aria-hidden="true">
        {parts.map((part) => (
          <span
            key={part.key}
            className={`mix-${part.key}`}
            style={{ width: `${all ? (part.value / all) * 100 : 0}%` }}
          />
        ))}
      </div>
      <dl className="mix-legend">
        {parts.map((part) => (
          <div key={part.key}>
            <dt>
              <span className={`mix-dot mix-${part.key}`} />
              {part.label}
            </dt>
            <dd>
              <CountUp value={part.value} format={compact} />
              <small>{percent(part.value, all)}</small>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The headline numbers of the period, its two charts, and what the cost leaves out. */
export function UsageSummary({ stats }: { stats: ProfileStats }) {
  const { period } = stats;
  const all = tokensOf(period.tokens);
  const input = period.tokens.input + period.tokens.cached;

  return (
    <>
      <div className="stat-tiles">
        <Tile icon={<Sparkles size={18} />} label="Total tokens">
          <CountUp value={all} format={compact} />
        </Tile>
        <Tile icon={<Coins size={18} />} label="Est. cost">
          {period.cost === null ? '—' : <CountUp value={period.cost} format={money} />}
        </Tile>
        <Tile icon={<CalendarDays size={18} />} label="Active days">
          <CountUp value={period.activeDays} />
        </Tile>
        <Tile icon={<Database size={18} />} label="Cache share">
          {percent(period.tokens.cached, input)}
        </Tile>
      </div>
      <div className="stat-cards">
        <Intensity stats={stats} />
        <Mix stats={stats} />
      </div>
      <p className="stat-note">
        Cost is estimated from list prices in the models.dev catalog, not from a provider's bill.
        {period.unpricedTokens > 0 &&
          ` ${compact(period.unpricedTokens)} tokens used a subscription or a model without a known price and are not in it.`}
      </p>
    </>
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

  return (
    <div className="stat-grid">
      {stats.models.map((model) => {
        const tokens = tokensOf(model.tokens);
        const logo = providerLogo(model.provider);

        return (
          <article
            className="stat-row-card"
            key={`${model.provider}:${model.modelId}:${model.billing}`}
          >
            <header>
              <span className="stat-icon" aria-hidden="true">
                {logo ? <ProviderLogo kind={logo} size={18} /> : <Server size={18} />}
              </span>
              <strong>{model.modelId}</strong>
              <span className={`stat-chip ${model.billing}`}>{billingLabels[model.billing]}</span>
            </header>
            <dl>
              <div>
                <dt>Tokens</dt>
                <dd>
                  <CountUp value={tokens} format={compact} />
                </dd>
              </div>
              <div>
                <dt>Turns</dt>
                <dd>
                  <CountUp value={model.turns} />
                </dd>
              </div>
              <div>
                <dt>Cost</dt>
                <dd>
                  {model.cost !== null ? (
                    <CountUp value={model.cost} format={money} />
                  ) : model.billing === 'subscription' ? (
                    'Included'
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
            </dl>
            <div className="share-row">
              <div className="share-bar" aria-hidden="true">
                <span style={{ width: `${all ? (tokens / all) * 100 : 0}%` }} />
              </div>
              <small className="share-note">{percent(tokens, all)} of tokens</small>
            </div>
          </article>
        );
      })}
    </div>
  );
}

const channels: Record<string, { label: string; icon: ReactNode }> = {
  whatsapp: { label: 'WhatsApp', icon: <WhatsAppLogo size={18} /> },
  telegram: { label: 'Telegram', icon: <TelegramLogo size={18} /> },
  gateway: { label: 'Gateway', icon: <MessageCircle size={18} /> },
  agent: { label: 'Agents', icon: <Bot size={18} /> },
  learning: { label: 'Learning', icon: <GraduationCap size={18} /> },
  api: { label: 'API Server', icon: <Terminal size={18} /> },
};

/** Where the work came from: each channel's conversations, turns and tokens in the period. */
export function ChannelCards({ stats }: { stats: ProfileStats }) {
  return (
    <div className="stat-grid four">
      {stats.channels.map((channel) => {
        const kind = channels[channel.channel] ?? channels.api;

        return (
          <article className="stat-row-card compact" key={channel.channel}>
            <header>
              <span className="stat-icon" aria-hidden="true">
                {kind?.icon}
              </span>
              <strong>{kind?.label}</strong>
            </header>
            <p>
              <CountUp value={channel.turns} /> {channel.turns === 1 ? 'turn' : 'turns'} ·{' '}
              {channel.conversations}{' '}
              {channel.conversations === 1 ? 'conversation' : 'conversations'}
            </p>
            <small>
              <CountUp value={channel.tokens} format={compact} /> tokens
            </small>
          </article>
        );
      })}
    </div>
  );
}

const toolName = (name: string) => {
  const label = toolLabels[name];

  return label ? `${label[0]?.toUpperCase()}${label.slice(1)}` : name.replaceAll('_', ' ');
};

/** The tools the agent reached for most, as bars against the busiest one. */
export function ToolBars({ stats }: { stats: ProfileStats }) {
  const most = Math.max(1, ...stats.tools.map((tool) => tool.calls));

  return (
    <ol className="tool-bars">
      {stats.tools.map((tool) => (
        <li key={tool.name}>
          <span className="tool-bar-name">
            {toolName(tool.name)}
            <code>{tool.name}</code>
          </span>
          <span className="tool-bar-track" aria-hidden="true">
            <span style={{ width: `${(tool.calls / most) * 100}%` }} />
          </span>
          <span className="tool-bar-count">
            <CountUp value={tool.calls} />
            {tool.failed > 0 && <em className="tool-bar-failed">{tool.failed} failed</em>}
          </span>
        </li>
      ))}
    </ol>
  );
}
