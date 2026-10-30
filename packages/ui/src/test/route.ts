import { memoryNavigation } from '../platform/navigation';

/**
 * Puts a unit test at an address. Screens read it from the router they meet when no host gave
 * one, so a component that takes its agent or conversation from the URL can render alone.
 */
export function goTo(pathname: string) {
  memoryNavigation.go(pathname);
}
