import type { z } from 'zod';

/** Where a call that changes something lands, in the guard's words. A read has none. */
export type XActionKind = 'service' | 'message';

/** What X bills by the piece on this read, so its description can say so. */
export type XCharge = 'post' | 'user' | 'dm' | 'list' | 'space' | 'community' | 'note';

/**
 * One operation of X's API as a tool. `{me}` in the path is the acting account, filled in by the
 * gateway and never asked of the agent, so an agent cannot act as an account by naming its id.
 */
export type XOperation = {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  about: string;
  /** What X's API document requires of the token, checked before anything is spent. */
  scopes: string[];
  kind?: XActionKind;
  charge?: XCharge;
  query: z.ZodRawShape;
  body?: z.ZodRawShape;
  /**
   * Fields asked for on every call. X answers with little more than an id otherwise, and each of
   * these is free next to what asking a second time would cost.
   */
  preset: Record<string, string>;
};

type Options = Partial<Pick<XOperation, 'kind' | 'charge' | 'query' | 'body' | 'preset'>>;

export function op(
  name: string,
  route: string,
  about: string,
  scopes: string,
  options: Options = {},
): XOperation {
  const [method, path] = route.split(' ') as [XOperation['method'], string];

  return {
    name,
    method,
    path,
    about,
    scopes: scopes.split(' ').filter(Boolean),
    query: {},
    preset: {},
    ...options,
  };
}
