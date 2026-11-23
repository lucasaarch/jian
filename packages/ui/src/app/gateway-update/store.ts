'use client';

import type { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { panelApi } from '../../lib/query/client';
import { keys } from '../../lib/query/keys';
import { failures, waitForVersion } from './wait';

export type UpdatePhase =
  | { step: 'idle' }
  | { step: 'starting'; version: string }
  | { step: 'waiting'; version: string }
  | { step: 'done'; version: string }
  | { step: 'failed'; version: string; reasons: string[] };

/**
 * The update dialog, open or not, and where the update it started stands. Kept outside any
 * screen: Settings and the command palette open the same dialog, and an update goes on while
 * the panel waits for the gateway to come back, whatever is on screen.
 */
export const useGatewayUpdate = create<{
  open: boolean;
  phase: UpdatePhase;
  setOpen: (open: boolean) => void;
}>()((set, get) => ({
  open: false,
  phase: { step: 'idle' },
  setOpen: (open) => {
    // A finished or failed update is forgotten on closing; one under way is still shown.
    const { step } = get().phase;
    set({
      open,
      ...(!open && (step === 'done' || step === 'failed') ? { phase: { step: 'idle' } } : {}),
    });
  },
}));

export const askToUpdate = () => useGatewayUpdate.getState().setOpen(true);

/**
 * Asks the gateway to update to `version`, then waits for /health to answer on it. The gateway
 * goes down on the way, so only a read on the new version says it worked.
 */
export async function runUpdate(client: QueryClient, version: string, confirmBackup: boolean) {
  const set = (phase: UpdatePhase) => useGatewayUpdate.setState({ phase });
  set({ step: 'starting', version });
  try {
    const attempt = await panelApi().startUpdate(version, confirmBackup);
    if (!attempt.ok) {
      set({ step: 'failed', version, reasons: failures(attempt) });
      return;
    }
  } catch (error) {
    set({ step: 'failed', version, reasons: [reason(error)] });
    return;
  } finally {
    void client.invalidateQueries({ queryKey: keys.updates });
  }

  set({ step: 'waiting', version });
  const back = await waitForVersion(() => panelApi().health(), version);
  set(
    back
      ? { step: 'done', version }
      : {
          step: 'failed',
          version,
          reasons: [
            `Jian did not come back on ${version} within 10 minutes. Check the deploy on your platform.`,
          ],
        },
  );
  if (back) void client.invalidateQueries();
}

const reason = (error: unknown) =>
  error instanceof Error ? error.message : 'The update could not be started.';
