import { z } from 'zod';

/** What a worker says when it opens the forwards a gateway assigns to its machine. */
export const REMOTE_FORWARDS_CAPABILITY = 'forwards-v1';

/** Forwards one agent keeps open at once. */
export const FORWARDS_PER_PROFILE = 10;
/** Connections open at once through one forward; the next is refused until one closes. */
export const FORWARD_CONNECTIONS_MAX = 64;
/** A connection that carried no byte for this long is closed, in ms. */
export const FORWARD_IDLE_MS = 5 * 60_000;
/** The most bytes one upload carries; a larger read from the local socket is sent in parts. */
export const FORWARD_CHUNK_MAX = 1024 * 1024;
/** The ports a worker listens on, on 127.0.0.1 of its own computer: first and last. */
export const FORWARD_LOCAL_PORTS = { first: 41000, last: 41999 } as const;

export const forwardStatusSchema = z.enum(['waiting', 'open', 'failed']);

/** A port of the server, made reachable on `localhost` of a connected computer. */
export const forwardSchema = z.strictObject({
  id: z.uuid(),
  sessionId: z.uuid(),
  machineId: z.uuid(),
  machineName: z.string().max(200),
  /** The port on the machine the gateway runs on; only its own loopback is reached. */
  remotePort: z.number().int().min(1).max(65_535),
  status: forwardStatusSchema,
  /** The port on the computer's `localhost`, once the worker has opened it. */
  localPort: z.number().int().min(1).max(65_535).optional(),
  /** Why it failed, for a person to read. */
  error: z.string().max(500).optional(),
  createdAt: z.iso.datetime(),
});

export const forwardParamsSchema = z.strictObject({
  profileId: z.uuid(),
  forwardId: z.uuid(),
});

/** One forward as its machine's worker is told: what to open, nothing about who asked. */
export const forwardAssignmentSchema = z.strictObject({
  id: z.uuid(),
  port: z.number().int().min(1).max(65_535),
});

/** What a worker reports about the listener it opened for a forward. */
export const forwardStateInputSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('open'),
    localPort: z.number().int().min(1).max(65_535),
  }),
  z.strictObject({ status: z.literal('failed'), error: z.string().min(1).max(500) }),
]);

export const forwardWorkerParamsSchema = z.strictObject({
  machineId: z.uuid(),
  forwardId: z.uuid(),
});

export const forwardConnectionParamsSchema = z.strictObject({
  machineId: z.uuid(),
  forwardId: z.uuid(),
  connectionId: z.uuid(),
});

/** A connection the gateway made to the server's port for one the computer accepted. */
export const forwardConnectionSchema = z.strictObject({ id: z.uuid() });

/** Bytes for the server's side of a connection, in base64. */
export const forwardChunkSchema = z.strictObject({
  data: z
    .string()
    .min(1)
    .max(Math.ceil(FORWARD_CHUNK_MAX / 3) * 4),
});

/**
 * What a connection's stream sends, as server-sent events: `data` with `{ data }` in base64 for
 * what the server wrote, and `end` once the server closed its side.
 */
export const forwardDataFrameSchema = z.strictObject({ data: z.string() });

export type Forward = z.infer<typeof forwardSchema>;
export type ForwardAssignment = z.infer<typeof forwardAssignmentSchema>;
export type ForwardStateInput = z.infer<typeof forwardStateInputSchema>;
