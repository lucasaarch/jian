'use client';

import { CodeBlock } from '../ui/code-block';

/** Display values have already been bounded and redacted at the timeline boundary. */
export type ToolValue = { text?: string; truncated?: boolean };

/** A value longer than this, in characters, reads better in a block than beside its label. */
const FIELD_CHARS = 80;
/** What is written to be run or read as code stays in a block, however short. */
const BLOCK_FIELDS = new Set(['code', 'command', 'patch', 'query', 'script', 'sql']);

/** Whether a line of the trace has anything to open: never a fold with nothing inside. */
export function hasDetails(step: {
  input?: ToolValue;
  output?: ToolValue;
  diff?: unknown;
  note?: string;
  detail?: string;
}): boolean {
  return (
    step.input?.text !== undefined ||
    step.output?.text !== undefined ||
    Boolean(step.diff) ||
    Boolean(step.note && step.detail)
  );
}

/** A field as the owner reads it: `subscription_id` and `subscriptionId` are "Subscription id". */
function named(field: string): string {
  const words = field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();

  return `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}`;
}

/** A value cut by the gateway is not valid JSON any more, and is shown as it stands. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** What a tool server said, without the envelope every one of its answers comes in. */
function unwrapped(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('content' in value)) return value;
  const { content } = value;
  if (!Array.isArray(content) || !content.length) return value;
  const texts = content.map((part: unknown) =>
    part && typeof part === 'object' && 'text' in part ? part.text : undefined,
  );

  return texts.every((text) => typeof text === 'string') ? texts.join('\n\n') : value;
}

const isScalar = (value: unknown) => value === null || typeof value !== 'object';

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  return String(value);
}

function Block({ value }: { value: unknown }) {
  return (
    <pre className="tool-block">
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Fields({ value }: { value: Record<string, unknown> }) {
  return (
    <dl className="tool-fields">
      {Object.entries(value).map(([field, item]) => {
        const inline =
          isScalar(item) &&
          !BLOCK_FIELDS.has(field) &&
          scalar(item).length <= FIELD_CHARS &&
          !scalar(item).includes('\n');

        return inline ? (
          <div key={field} className="tool-field">
            <dt>{named(field)}</dt>
            <dd>{scalar(item)}</dd>
          </div>
        ) : (
          <div key={field} className="tool-field-block">
            <dt>{named(field)}</dt>
            <dd>
              <Block value={item} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function Value({ value, none }: { value: unknown; none: string }) {
  if (value === null || value === '') return <p className="tool-empty">{none}</p>;
  if (Array.isArray(value)) {
    return value.length ? <Block value={value} /> : <p className="tool-empty">{none}</p>;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.keys(object).length ? (
      <Fields value={object} />
    ) : (
      <p className="tool-empty">{none}</p>
    );
  }

  return <Block value={scalar(value)} />;
}

/**
 * A value as JSON, the way a tool server takes and gives it. A server's text that is itself
 * JSON is laid out too; a value the gateway cut, no longer JSON, is shown as it stands.
 */
function JsonValue({ value, none }: { value: unknown; none: string }) {
  const shown = typeof value === 'string' ? parsed(value) : value;
  const empty =
    shown === null ||
    shown === '' ||
    (typeof shown === 'object' && Object.keys(shown as object).length === 0);

  if (empty) return <p className="tool-empty">{none}</p>;
  if (typeof shown === 'string') return <Block value={shown} />;

  return <CodeBlock text={JSON.stringify(shown, null, 2)} language="json" wrapped />;
}

function Section({
  title,
  value,
  none,
  json,
}: {
  title: 'Input' | 'Output';
  value: ToolValue;
  none: string;
  json: boolean;
}) {
  const shown = unwrapped(parsed(value.text ?? ''));

  return (
    <section>
      <h4>{title}</h4>
      {json ? <JsonValue value={shown} none={none} /> : <Value value={shown} none={none} />}
      {value.truncated && <p className="thought-truncated">{title} truncated.</p>}
    </section>
  );
}

/**
 * What a tool was asked and what it answered. Jian's own tools read in the owner's words; an
 * MCP server's (`json`) as JSON, since its fields are the server's own and many, and a list of
 * them labelled one by one is harder to read than the object they make.
 */
export function ToolDetails({
  input,
  output,
  json = false,
}: {
  input?: ToolValue;
  output?: ToolValue;
  json?: boolean;
}) {
  if (input?.text === undefined && output?.text === undefined) return null;

  return (
    <div className="tool-details">
      {input?.text !== undefined && (
        <Section title="Input" value={input} none="No arguments" json={json} />
      )}
      {output?.text !== undefined && (
        <Section title="Output" value={output} none="No result" json={json} />
      )}
    </div>
  );
}
