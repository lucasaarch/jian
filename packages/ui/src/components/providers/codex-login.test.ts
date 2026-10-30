import { afterEach, expect, it, vi } from 'vitest';
import { handOff } from './codex-login';

const login = { verificationUrl: 'https://auth.example.com/device', userCode: 'ABCD-1234' };

afterEach(() => vi.restoreAllMocks());

it('copies the code before the login tab takes the focus away', async () => {
  const order: string[] = [];
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text) => {
    order.push(`copy ${text}`);
  });
  vi.spyOn(window, 'open').mockImplementation((url) => {
    order.push(`open ${url}`);
    return null;
  });

  expect(await handOff(login)).toBe(true);
  expect(order).toEqual(['copy ABCD-1234', 'open https://auth.example.com/device']);
});

it('still opens the login when the browser refuses the clipboard', async () => {
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  const open = vi.spyOn(window, 'open').mockReturnValue(null);

  expect(await handOff(login)).toBe(false);
  expect(open).toHaveBeenCalledWith(login.verificationUrl, '_blank', 'noopener,noreferrer');
});
