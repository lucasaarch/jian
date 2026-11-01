'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect } from 'react';
import { useAppearance } from '../../lib/appearance';
import { type AppUpdate, type UpdatesHost, useAppUpdate } from './app-update';
import { UpdateSheet } from './update-sheet';

/**
 * The update sheet, kept in step with the host: it reads where updates stand once, follows every
 * change after, and checks when it was opened to. Mount it once, beside the app.
 */
export function AppUpdates({ host }: { host: UpdatesHost }) {
  const update = useAppUpdate((state) => state.update);
  const open = useAppUpdate((state) => state.open);
  const checkOnOpen = useAppUpdate((state) => state.checkOnOpen);
  const setUpdate = useAppUpdate((state) => state.setUpdate);
  const setOpen = useAppUpdate((state) => state.setOpen);

  useEffect(() => {
    let live = true;
    void host.state().then((state) => {
      if (live && state) setUpdate(state);
    });
    const stop = host.onChanged(setUpdate);
    return () => {
      live = false;
      stop();
    };
  }, [host, setUpdate]);

  const check = useCallback(() => {
    void host.check().then((state: AppUpdate | undefined) => {
      if (state) setUpdate(state);
    });
  }, [host, setUpdate]);

  useEffect(() => {
    if (!open || !checkOnOpen) return;
    useAppUpdate.setState({ checkOnOpen: false });
    check();
  }, [open, checkOnOpen, check]);

  return (
    <UpdateSheet
      open={open}
      onOpenChange={setOpen}
      update={update}
      onCheck={check}
      onInstall={() => host.install()}
    />
  );
}

/** What the status bar says of a release it knows of: nothing while none has been found. */
function word(update: AppUpdate | undefined): { label: string; title: string } | undefined {
  if (!update || !('release' in update) || !update.release) return undefined;
  const { version } = update.release;
  switch (update.status) {
    case 'ready':
      return { label: 'Update ready', title: `Jian ${version} is ready to install` };
    case 'downloading':
      return { label: 'Downloading update', title: `Downloading Jian ${version}` };
    // A download that failed still leaves a release to get: the sheet says why and tries again.
    default:
      return { label: 'Update available', title: `Jian ${version} is available` };
  }
}

/** A quiet word in the host's status bar once a release is known of, which opens the sheet. */
export function UpdateBadge() {
  const { still } = useAppearance();
  const update = useAppUpdate((state) => state.update);
  const show = useAppUpdate((state) => state.show);
  const said = word(update);
  return (
    <AnimatePresence initial={false}>
      {said && (
        <motion.button
          type="button"
          onClick={() => show(false)}
          title={said.title}
          className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-good/12 px-2.5 text-xs font-medium text-good transition-colors hover:bg-good/20"
          initial={still ? false : { opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={still ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.9 }}
          transition={{ type: 'spring', stiffness: 420, damping: 30 }}
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-good" />
          {said.label}
        </motion.button>
      )}
    </AnimatePresence>
  );
}
