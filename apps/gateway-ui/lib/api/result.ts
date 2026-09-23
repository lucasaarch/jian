/**
 * Turns a generated client call into its body, or into the sentence the owner should read. The
 * gateway answers in English; the panel is the only place that decides how a failure reads.
 */

/** The shapes the gateway uses for a failure body. Both fields are optional on purpose. */
type Detail = { error?: string; issues?: Array<{ path: string; message: string }> };

/** Conflicts the owner can act on. Anything else falls back to the generic 409 sentence. */
const conflicts: Record<string, string> = {
  'Choose a default model before starting a run':
    'Choose a model under Model defaults before starting a conversation.',
  'This model does not accept the selected reasoning effort':
    'This model does not accept the selected reasoning effort.',
  'Reasoning effort is not catalogued for this model':
    'The reasoning levels of this model are not catalogued on this gateway.',
};

function message(status: number, detail: Detail | undefined): string {
  if (status === 401) {
    return 'The token is invalid or expired. Sign in again.';
  }

  if (status === 403) {
    return 'This action needs the host token.';
  }

  if (status === 409) {
    return (
      conflicts[detail?.error ?? ''] ??
      'Something changed, or the session is busy. Refresh and try again.'
    );
  }

  if (status === 429) {
    return 'Rate limit reached. Wait a minute before trying again.';
  }

  if (detail?.issues?.length) {
    return `Check these fields: ${detail.issues.map((issue) => issue.path).join(', ')}.`;
  }

  return detail?.error ?? `The request could not be completed (${status}).`;
}

export async function result<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await request;

  if (!response.ok || data === undefined) {
    throw new Error(message(response.status, error as Detail | undefined));
  }

  return data;
}
