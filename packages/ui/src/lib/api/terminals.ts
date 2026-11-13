import { TERMINALS_MAX, type TerminalInput } from '@jian/contracts';
import { gatewayConnection } from '../../platform/gateway';
import { type Client, profile } from './params';
import { GatewayAnswer, result } from './result';

type TerminalSize = Pick<TerminalInput, 'cols' | 'rows'>;

/** What a terminal's stream tells its screen, in the order it happened. */
type TerminalStreamHandlers = {
  /** The gateway answered: what follows starts with everything the terminal kept so far. */
  opened(): void;
  output(data: string): void;
  exit(exitCode: number): void;
};

/**
 * How long a stream may say nothing before it is given up as dead, in ms. The gateway says
 * something at least every 25 seconds; a connection lost without a word never fails by itself.
 */
const QUIET_MS = 60_000;
/**
 * The longest frame a screen takes, in characters: the whole scrollback as JSON, where a control
 * character is six. Past it the stream is not one this panel understands.
 */
const FRAME_MAX = 8_000_000;

/** Shells on the gateway's machine, for the Inspector's terminal tabs. */
export const terminalCalls = (client: Client) => ({
  openTerminal: (profileId: string, input: TerminalInput) =>
    result(
      client.POST('/v1/profiles/{profileId}/terminals', {
        params: profile(profileId),
        body: input,
      }),
    ).catch((error: unknown) => {
      // The owner is never rate limited: on this route a 429 is the gateway's limit of terminals.
      if (error instanceof GatewayAnswer && error.status === 429) {
        throw new GatewayAnswer(
          `This gateway already has ${TERMINALS_MAX} terminals open. Close one to open another.`,
          429,
        );
      }
      throw error;
    }),
  writeTerminal: (profileId: string, terminalId: string, data: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/terminals/{terminalId}/input', {
        params: { path: { profileId, terminalId } },
        body: { data },
      }),
    ),
  resizeTerminal: (profileId: string, terminalId: string, size: TerminalSize) =>
    result(
      client.POST('/v1/profiles/{profileId}/terminals/{terminalId}/resize', {
        params: { path: { profileId, terminalId } },
        body: size,
      }),
    ),
  closeTerminal: (profileId: string, terminalId: string) =>
    result(
      client.DELETE('/v1/profiles/{profileId}/terminals/{terminalId}', {
        params: { path: { profileId, terminalId } },
      }),
    ),
  terminalOutput: readTerminal,
});

/**
 * Reads a terminal's output until its stream ends, which it does by itself once the shell has
 * exited. The panel signs in with a cookie and a header, which EventSource cannot send, so the
 * stream is read from a plain response body, as the gateway's events are. A terminal the gateway
 * does not have is a `GatewayAnswer` with status 404.
 */
async function readTerminal(
  profileId: string,
  terminalId: string,
  handlers: TerminalStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const { origin, headers, credentials } = gatewayConnection();
  const quiet = new AbortController();
  let reader: ReadableStreamDefaultReader<string> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const heard = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      quiet.abort();
      void reader?.cancel().catch(() => {});
    }, QUIET_MS);
  };

  heard();
  try {
    const response = await fetch(
      `${origin}/v1/profiles/${profileId}/terminals/${terminalId}/stream`,
      { headers, credentials, cache: 'no-store', signal: AbortSignal.any([signal, quiet.signal]) },
    );

    if (!response.ok || !response.body) {
      // Left unread, the refusal's body would hold its stream on the connection every request
      // to this gateway shares.
      await response.body?.cancel().catch(() => {});
      throw new GatewayAnswer('The terminal is not available.', response.status);
    }

    handlers.opened();
    reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      heard();

      const blocks = (buffer + value).split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) tell(block, handlers);
      if (buffer.length > FRAME_MAX) buffer = '';
    }
  } finally {
    clearTimeout(timer);
  }
}

function tell(block: string, handlers: TerminalStreamHandlers) {
  let type = '';
  let data: { data?: unknown; exitCode?: unknown } | undefined;

  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) type = line.slice(7).trim();
    if (line.startsWith('data: ')) {
      try {
        data = JSON.parse(line.slice(6));
      } catch {
        data = undefined;
      }
    }
  }

  if (type === 'output' && typeof data?.data === 'string') handlers.output(data.data);
  if (type === 'exit' && typeof data?.exitCode === 'number') handlers.exit(data.exitCode);
}
