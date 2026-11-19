/**
 * What GitHub's callback answers someone who comes back with an installation and no state: an
 * organization owner approving a member's request, or anyone installing the App from GitHub
 * itself. Nothing is connected from here, since without the state nothing shows this gateway's
 * owner asked for it. The page is not the panel: the person reading it may not be signed in to
 * this Jian at all, so it only says what happens next and can be closed.
 */
export const APPROVED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Jian GitHub App installed</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: Canvas;
    color: CanvasText;
  }
  main { max-width: 32rem; padding: 2rem 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 0.75rem; opacity: 0.8; }
</style>
</head>
<body>
<main>
<h1>Jian's GitHub App is installed</h1>
<p>GitHub has the installation. Nothing was connected from this page: an installation joins a Jian only from that Jian.</p>
<p>If someone asked for it from their Jian, it connects there on its own in a moment. They can also finish it there, under Plugins → Connectors → GitHub, with Connect an approved installation.</p>
<p>You can close this tab.</p>
</main>
</body>
</html>
`;

/**
 * The page's own policy, over the gateway's: no script, no request of any kind, its one inline
 * style block, and no frame around it.
 */
export const APPROVED_PAGE_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
