import { STREAM_OPENED_EVENT } from '@jian/contracts';
import { gatewayConnection } from '../../platform/gateway';
import { readFrames } from './frames';

/** One thing that happened on the gateway. `data` carries what the event is about, if anything. */
export type GatewayEvent = { id: number; type: string; data?: unknown };

/** A block this long is not one this panel understands, in characters. */
const FRAME_MAX = 64_000;

/**
 * Gateways, by origin, that refused to be asked for progress text: they predate it, and validate
 * a stream's query strictly. Asked again on every reopen, each would cost a refused request.
 */
const textless = new Set<string>();

/** The stream's address: from `after`, with the text of work under way when that is asked. */
function streamUrl(origin: string, profileId: string, after: number | undefined, text: boolean) {
  const query = new URLSearchParams();
  if (after !== undefined) query.set('after', String(after));
  if (text) query.set('progress', '1');
  const search = query.toString();

  return `${origin}/v1/profiles/${profileId}/events/stream${search ? `?${search}` : ''}`;
}

/**
 * The call resolves when the stream ends, and rejects with the gateway's refusal.
 *
 * Durable events carry an id, and the stream resumes after the last one. A live update, such as
 * an agent's progress, carries none: it is passed on as it arrives and never moves the cursor.
 * With no `after` the stream starts from now, and its first event gives the cursor.
 */
export async function readEvents(
  profileId: string,
  after: number | undefined,
  onEvent: (event: GatewayEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const { origin, headers, credentials } = gatewayConnection();
  let cursor = after ?? 0;
  const request = (text: boolean, opening: AbortSignal) =>
    fetch(streamUrl(origin, profileId, after, text), {
      headers,
      credentials,
      cache: 'no-store',
      signal: opening,
    });

  await readFrames({
    signal,
    refusal: 'The event stream is not available.',
    maxFrame: FRAME_MAX,
    open: async (opening) => {
      // The conversation draws what an agent is writing from the stream, so the panel asks for it.
      const response = await request(!textless.has(origin), opening);
      if (response.status !== 400 || textless.has(origin)) return response;
      textless.add(origin);
      // Left unread, the refusal's body would hold its stream on the connection every request
      // to this gateway shares.
      await response.body?.cancel().catch(() => {});
      return request(false, opening);
    },
    frame: (block) => {
      const told = parseBlock(block);
      if (!told) return;
      const { id, type, data } = told;
      if (id === undefined) {
        onEvent({ id: cursor, type, data });
      } else if (id > cursor || type === STREAM_OPENED_EVENT) {
        // A feed with nothing in it opens at 0, which is no later than the cursor but still told.
        cursor = id;
        onEvent({ id, type, data });
      }
    },
  });
}

/** One block of the stream, or nothing when it names no event, as a heartbeat does. */
function parseBlock(block: string) {
  let id: number | undefined;
  let type = '';
  let data: unknown;

  for (const line of block.split('\n')) {
    if (line.startsWith('id: ')) id = Number(line.slice(4).trim());
    if (line.startsWith('event: ')) type = line.slice(7).trim();
    if (line.startsWith('data: ')) {
      try {
        data = JSON.parse(line.slice(6));
      } catch {
        data = undefined;
      }
    }
  }

  if (!type) return undefined;
  // A durable event's data line is the whole event as the feed keeps it; what it is about
  // (its conversation, the Inspector tab it asks for) is that event's own `data`. A live
  // update without an id carries its data as it is.
  if (id !== undefined && data && typeof data === 'object' && 'data' in data) {
    data = (data as { data?: unknown }).data;
  }

  return { id, type, data };
}
