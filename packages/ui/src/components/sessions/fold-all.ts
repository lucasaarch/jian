import { createContext, useContext, useEffect } from 'react';

/**
 * Folding or opening everything under it at once: what each part does when asked, as a request
 * rather than a state, so each still folds on its own afterwards. `round` makes the same ask
 * twice count twice.
 */
export type FoldAll = { open: boolean; round: number };

export const FoldAllContext = createContext<FoldAll | null>(null);

/** Follows each ask to fold or open everything; a part outside any such place keeps its own. */
export function useFoldAll(set: (open: boolean) => void) {
  const all = useContext(FoldAllContext);
  useEffect(() => {
    if (all) set(all.open);
  }, [all, set]);
}
