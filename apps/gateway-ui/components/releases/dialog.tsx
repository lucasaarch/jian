'use client';

import { useEffect, useState } from 'react';
import { type GatewayApi, gatewayApi } from '../../lib/api';
import { date } from '../../lib/format';
import { Button } from '../ui';
import { Markdown } from '../ui/markdown';
import { Modal } from '../ui/modal';

type Releases = Awaited<ReturnType<GatewayApi['releases']>>;

/**
 * Opens once after an update with what changed. Closing it is the owner saying they read it, and
 * the gateway keeps that mark, so the same notes do not open again on another browser.
 */
export function ReleaseDialog() {
  const [releases, setReleases] = useState<Releases>();

  useEffect(() => {
    let active = true;

    // A panel that cannot say what changed still works; the dialog is the only thing lost.
    void gatewayApi()
      .releases()
      .then((state) => {
        if (active) setReleases(state);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  if (!releases?.unseen.length) {
    return null;
  }

  const close = () => {
    setReleases(undefined);
    void gatewayApi()
      .markReleasesSeen()
      .catch(() => {});
  };

  const [latest] = releases.unseen;

  return (
    <Modal
      title={`What's new in Jian ${releases.version ?? latest?.version ?? ''}`}
      {...(latest?.summary ? { description: latest.summary } : {})}
      close={close}
    >
      <div className="release-notes">
        {releases.unseen.map((note) => (
          <section key={note.version}>
            {releases.unseen.length > 1 && (
              <h2>
                {note.version} <small>{date(note.date)}</small>
              </h2>
            )}
            {releases.unseen.length > 1 && note.summary && <p>{note.summary}</p>}
            <Markdown text={note.body} />
          </section>
        ))}
      </div>
      <footer>
        <Button type="button" onClick={close}>
          Got it
        </Button>
      </footer>
    </Modal>
  );
}
