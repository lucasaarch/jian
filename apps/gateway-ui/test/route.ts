/**
 * The address a unit test renders at. `next/navigation` reads from here (see test/setup.ts),
 * so a component that takes its agent or conversation from the URL can be rendered alone.
 */
export const route: {
  params: Record<string, string>;
  pathname: string;
} = { params: {}, pathname: '/' };
