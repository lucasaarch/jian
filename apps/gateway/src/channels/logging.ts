type ChannelEvent =
  | 'dispatch.failed'
  | 'whatsapp.worker.failed'
  | 'whatsapp.decrypt.failed'
  | 'whatsapp.decrypt.recovered'
  | 'whatsapp.key.invalid'
  | 'delivery.result'
  | 'delivery.peer_failed'
  | 'picture.failed'
  | 'picture.refused'
  | 'ingress.no_model';

type Details = {
  channelId?: string;
  deliveryId?: string;
  runId?: string;
  status?: 'sent' | 'failed' | 'unknown' | 'pending';
};

const uuid = (value: unknown) =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;

/** Logs only bounded metadata: provider errors may contain message text, keys or binary data. */
export function channelLog(
  event: ChannelEvent,
  details: Details = {},
  error?: unknown,
  write: (line: string) => void = (line) => console.info(line),
) {
  const statusCode =
    error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const errorCode =
    typeof code === 'string' &&
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
      ? code
      : undefined;
  const status = ['sent', 'failed', 'unknown', 'pending'].find((value) => value === details.status);
  write(
    JSON.stringify({
      level:
        event.endsWith('.failed') || status === 'failed'
          ? 50
          : status === 'unknown' || event.endsWith('.invalid')
            ? 40
            : 30,
      time: Date.now(),
      component: 'channels',
      event,
      channelId: uuid(details.channelId),
      deliveryId: uuid(details.deliveryId),
      runId: uuid(details.runId),
      status,
      ...(typeof statusCode === 'number' &&
      Number.isInteger(statusCode) &&
      statusCode >= 400 &&
      statusCode <= 599
        ? { statusCode }
        : {}),
      ...(errorCode ? { errorCode } : {}),
    }),
  );
}
