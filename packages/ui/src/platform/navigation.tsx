'use client';

import {
  type AnchorHTMLAttributes,
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';

/** A link the host draws its own way: Next's prefetching link on the web, a plain one elsewhere. */
export type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  /** Takes the current entry's place in the history instead of adding one. */
  replace?: boolean;
};

/**
 * Where the panel is and how it moves. Each host brings its own router — Next's on the web,
 * the native app's own — and the screens read only this.
 */
export type Navigation = {
  pathname: string;
  push(href: string): void;
  replace(href: string): void;
  back(): void;
  Link: ComponentType<LinkProps>;
};

/**
 * A router that is only a path in memory, with a history the way a browser keeps one: going back
 * and then somewhere new drops what was ahead. What a host without a router of its own uses, and
 * what a test renders at. `go` moves it from outside React and starts its history over.
 */
export function createMemoryNavigation(initial = '/') {
  let history = [initial];
  let index = 0;
  const listeners = new Set<() => void>();
  const set = (next: string[], at: number) => {
    history = next;
    index = at;
    for (const listener of listeners) listener();
  };
  const current = () => history[index] ?? '/';
  const push = (href: string) => {
    if (href === current()) return;
    set([...history.slice(0, index + 1), href], index + 1);
  };
  const replace = (href: string) => set(history.with(index, href), index);
  const back = () => {
    if (index > 0) set(history, index - 1);
  };
  const forward = () => {
    if (index < history.length - 1) set(history, index + 1);
  };

  function MemoryLink({ href, replace: replacing, onClick, ...props }: LinkProps) {
    return (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          (replacing ? replace : push)(href);
        }}
      />
    );
  }

  return {
    go: (href: string) => set([href], 0),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current,
    back,
    forward,
    canGoBack: () => index > 0,
    canGoForward: () => index < history.length - 1,
    navigation: (pathname: string): Navigation => ({
      pathname,
      push,
      replace,
      back,
      Link: MemoryLink,
    }),
  };
}

/** The router a screen meets when its host gave none. */
export const memoryNavigation = createMemoryNavigation();

const NavigationContext = createContext<Navigation | null>(null);

export function NavigationProvider({
  navigation,
  children,
}: {
  navigation: Navigation;
  children: ReactNode;
}) {
  return <NavigationContext.Provider value={navigation}>{children}</NavigationContext.Provider>;
}

function useNavigation(): Navigation {
  const given = useContext(NavigationContext);
  const pathname = useSyncExternalStore(
    memoryNavigation.subscribe,
    memoryNavigation.current,
    memoryNavigation.current,
  );
  const memory = useMemo(() => memoryNavigation.navigation(pathname), [pathname]);

  return given ?? memory;
}

export const usePathname = () => useNavigation().pathname;

/** How the panel moves, shaped as Next's router so a screen reads the same on any host. */
export function useRouter() {
  const { push, replace, back } = useNavigation();
  return useMemo(() => ({ push, replace, back }), [push, replace, back]);
}

/**
 * What the address names: the agent, and the conversation open in it. The panel's routes have
 * no other parameters, so they are read from the path itself on every host.
 */
export function useParams<T extends Record<string, string | undefined>>(): T {
  const pathname = usePathname();
  return useMemo(() => routeParams(pathname) as T, [pathname]);
}

function routeParams(pathname: string): { profileId?: string; sessionId?: string } {
  const match = /^\/agents\/([^/]+)(?:\/sessions\/([^/]+))?/.exec(pathname);
  if (!match) return {};
  return {
    ...(match[1] ? { profileId: decodeURIComponent(match[1]) } : {}),
    ...(match[2] ? { sessionId: decodeURIComponent(match[2]) } : {}),
  };
}

export function Link(props: LinkProps) {
  const { Link: HostLink } = useNavigation();
  return <HostLink {...props} />;
}
