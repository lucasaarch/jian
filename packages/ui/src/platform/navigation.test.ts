import { describe, expect, it } from 'vitest';
import { createMemoryNavigation } from './navigation';

describe('a history kept in memory', () => {
  it('goes back and forward over the places visited', () => {
    const memory = createMemoryNavigation('/');
    const { push } = memory.navigation(memory.current());
    push('/agents/a');
    push('/agents/a/sessions');
    memory.back();
    expect(memory.current()).toBe('/agents/a');
    expect(memory.canGoForward()).toBe(true);
    memory.forward();
    expect(memory.current()).toBe('/agents/a/sessions');
    expect(memory.canGoForward()).toBe(false);
  });

  it('drops what was ahead when it goes somewhere new from the middle', () => {
    const memory = createMemoryNavigation('/');
    const { push } = memory.navigation(memory.current());
    push('/a');
    push('/b');
    memory.back();
    push('/c');
    expect(memory.canGoForward()).toBe(false);
    memory.back();
    expect(memory.current()).toBe('/a');
  });

  it('stays where it is past either end, and does not repeat the place it is at', () => {
    const memory = createMemoryNavigation('/');
    memory.back();
    memory.forward();
    expect(memory.current()).toBe('/');
    memory.navigation('/').push('/');
    expect(memory.canGoBack()).toBe(false);
  });
});
