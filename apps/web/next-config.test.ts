import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { describe, expect, it } from 'vitest';
import configuration from './next.config.mjs';

// Headers as Next adds them to an address: every rule whose source matches it.
async function headersAt(path: string) {
  const rules = await configuration().headers();
  return rules
    .filter((rule) => getPathMatch(rule.source, { removeUnnamedParams: true, strict: true })(path))
    .flatMap((rule) => rule.headers.map((header) => header.key));
}

// Electron 45 dies on a CHECK when a sandboxed frame it loads through jian:// commits with
// Origin-Agent-Cluster: the desktop app crashed whenever it opened an Artifact.
describe('the headers the web host adds', () => {
  it.each(['html', 'deck', 'markdown'])(
    'leave Origin-Agent-Cluster off the %s frame',
    async (type) => {
      const keys = await headersAt(`/v1/artifact-frames/${type}`);
      expect(keys).not.toContain('Origin-Agent-Cluster');
      expect(keys).toContain('X-Content-Type-Options');
    },
  );

  it.each(['/', '/agents/a/sessions', '/v1/profiles/a/sessions'])('keep it on %s', async (path) => {
    expect(await headersAt(path)).toContain('Origin-Agent-Cluster');
  });
});
