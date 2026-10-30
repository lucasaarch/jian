import { TriangleAlert } from 'lucide-react';

/**
 * Shown instead of the panel when it and the gateway are different releases: the panel would
 * read the gateway's answers in shapes it may not know. The fix is the owner's, in how the two
 * images are run, so this says exactly which versions met.
 */
export function VersionMismatch({ web, gateway }: { web: string; gateway: string }) {
  return (
    <main className="version-mismatch">
      <section role="alert" aria-labelledby="version-mismatch-title">
        <span className="version-mismatch-mark" aria-hidden="true">
          <TriangleAlert size={22} />
        </span>
        <h1 id="version-mismatch-title">The panel and the gateway are on different versions</h1>
        <p>
          This panel is <strong>{web}</strong> and the gateway behind it is{' '}
          <strong>{gateway}</strong>. They only work together on the same release.
        </p>
        <p>
          Run both images at one version: set <code>JIAN_VERSION</code> to the same tag for{' '}
          <code>jian-web</code> and <code>jian-gateway</code>, or pull both again, then restart
          them.
        </p>
      </section>
    </main>
  );
}
