import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Playwright drives the existing Electron binary; it never launches or downloads Chromium.
const root = fileURLToPath(new URL('..', import.meta.url));
const gatewayRequire = createRequire(new URL('../../gateway/package.json', import.meta.url));
const { _electron } = gatewayRequire('playwright');
const electron = createRequire(import.meta.url)('electron');
const temporary = await mkdtemp(join(tmpdir(), 'jian-native-browser-'));
let app;
try {
  const assets = await readdir(join(root, 'out/renderer/assets'));
  const css = assets.find((name) => name.endsWith('.css'));
  assert.ok(css, 'Build the desktop before running the browser smoke test');
  const renderer = join(temporary, 'renderer.js');
  await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {BrowserInspector} from './src/renderer/chrome/browser-panel'; import {InspectorContent} from '../../packages/ui/src/components/sessions/inspector-host'; import {useCrew} from '../../packages/ui/src/lib/stores/crew'; function PreviewInspector(){const following=useCrew(s=>s.following); return following && following!=='browser' ? <InspectorContent><p className="p-6 text-ink">Reference: {following}</p></InspectorContent> : null;} window.openTestPull=()=>useCrew.getState().open({kind:'pull',owner:'atlas-example',repo:'site',number:7,url:'https://github.com/atlas-example/site/pull/7'}); window.openTestAgent=()=>{useCrew.setState({agents:[{runId:'reviewer',name:'Reviewer'}]});useCrew.getState().follow('reviewer')}; window.showTestConversation=(id)=>useCrew.getState().show(id,[]); function App(){const [hidden,setHidden]=React.useState(false); window.setPanelHidden=setHidden; return <div className="flex bg-canvas" style={{height:"100vh"}}><BrowserInspector hidden={hidden}><main className="min-w-0 flex-1 p-12 text-ink"><button onClick={()=>window.jian.browser.open()}>Open Jian Browser</button><p>Atlas conversation</p><PreviewInspector /></main></BrowserInspector></div>;} createRoot(document.getElementById('root')).render(<App />);`,
      resolveDir: root,
      loader: 'tsx',
    },
    outfile: renderer,
    bundle: true,
    platform: 'browser',
    jsx: 'automatic',
  });
  const html = join(temporary, 'index.html');
  await writeFile(
    html,
    `<html><head><link rel="stylesheet" href="${new URL(`file://${join(root, 'out/renderer/assets', css)}`).href}"></head><body style="margin:0"><div id="root"></div><script src="./renderer.js"></script></body></html>`,
  );
  const main = join(temporary, 'main.cjs');
  // What Vite does for the packaged app, for the one bundle that does not go through it.
  const inlinePng = {
    name: 'inline-png',
    setup(bundler) {
      bundler.onResolve({ filter: /\.png\?inline$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path.replace('?inline', '')),
        namespace: 'inline-png',
      }));
      bundler.onLoad({ filter: /.*/, namespace: 'inline-png' }, async (args) => ({
        contents: `data:image/png;base64,${(await readFile(args.path)).toString('base64')}`,
        loader: 'text',
      }));
    },
  };
  await build({
    plugins: [inlinePng],
    stdin: {
      contents: `
    import {app,BrowserWindow,ipcMain} from 'electron';
    import {createServer} from 'node:http';
    import {JianBrowser} from './src/main/browser';
    app.setPath('userData', ${JSON.stringify(join(temporary, 'data'))});
    app.whenReady().then(async()=>{
      const hits={};
      const login=(req)=>(req.headers.cookie??'').includes('session=synthetic');
      const framed=createServer((req,res)=>{
        res.setHeader('content-type',req.url==='/frame.css'?'text/css':'text/html');
        res.end(req.url==='/frame.css'?'p{color:rgb(1,2,3)}':'<link rel=stylesheet href=/frame.css><p>Inside the isolated frame</p><script>setTimeout(()=>fetch("/slow"),50)</script>');
      });
      framed.listen(0,'localhost'); await new Promise(r=>framed.once('listening',r));
      const frameUrl='http://localhost:'+framed.address().port+'/';
      const server=createServer((req,res)=>{
        const path=req.url.split('?')[0]; hits[path]=(hits[path]??0)+1;
        res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/html');
        if(path==='/login'){res.setHeader('set-cookie','session=synthetic; Path=/');res.statusCode=302;res.setHeader('location','/private');res.end();return;}
        if(path==='/private.css'){res.statusCode=login(req)?200:403;res.end('h1{color:rgb(9,8,7)}');return;}
        if(path==='/private'){if(!login(req)){res.statusCode=403;res.end('Forbidden');return;}res.end('<title>Atlas Private</title><link rel=stylesheet href=/private.css><h1>Signed in as Nova</h1><p id=state>initial</p>');return;}
        if(path==='/late'){res.end('<title>Atlas Late</title><p id=late>Loading</p><iframe src='+JSON.stringify(frameUrl)+'></iframe><script>setTimeout(()=>{document.getElementById("late").textContent="Rendered late"},1500);fetch("/slow")</script>');return;}
        if(path==='/slow'){setTimeout(()=>res.end('done'),1400);return;}
        if(path==='/write'){res.end('<title>Atlas Write</title><script>fetch("/recorded",{method:"POST"})</script>');return;}
        if(path==='/form'){res.end('<title>Atlas Form</title><input id=q name=q><button id=go>Go</button><p id=out>none</p><p id=clicks>0</p><div style="height:3000px"></div><p id=bottom>Bottom</p><script>let n=0;go.onclick=e=>{clicks.textContent=(++n)+":"+e.isTrusted};q.addEventListener("keydown",e=>{if(e.key==="Enter")out.textContent="sent "+q.value+":"+e.isTrusted});document.cookie="seen=1"</script>');return;}
        if(path==='/hang'){res.end('<title>Atlas Hang</title><button id=hang onclick="while(true){}">Hang</button>');return;}
        res.end('<html><head><title>Atlas Native Preview</title><style>body{background:#14233a;color:white;font:20px sans-serif}button{padding:14px;border-radius:10px;background:#97dbbe}h1{font-size:32px}@media(max-width:600px){h1{font-size:20px}}</style></head><body><h1>Atlas native preview</h1><button id="menu" onclick="document.getElementById(\\'panel\\').hidden=false">Open menu</button><div id="panel" hidden>Expanded details</div><input id="name"><div style="height:1500px">Footer</div><script>document.cookie="atlas=one;SameSite=Lax"</script></body></html>')});
      server.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
      const win=globalThis.smokeWindow=new BrowserWindow({width:1280,height:820,webPreferences:{preload:${JSON.stringify(join(root, 'out/preload/index.cjs'))},sandbox:true,contextIsolation:true,nodeIntegration:false}});
      const browser=new JianBrowser(()=>win,{keepMs:600,agentKeepMs:600,liveBackground:1,pointerIdleMs:300}); browser.register(); browser.attach(win);
      ipcMain.on('app:version',e=>{e.returnValue='0.0.0-test'});
      globalThis.nativeBrowserTest={browser,win,hits,url:'http://127.0.0.1:'+server.address().port+'/'};
      await win.loadFile(${JSON.stringify(html)}); win.show();
    });
  `,
      resolveDir: root,
      loader: 'ts',
    },
    outfile: main,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  app = await _electron.launch({ executablePath: electron, args: [main], timeout: 30000 });
  app.process().stdout.on('data', (data) => process.stdout.write(data));
  app.process().stderr.on('data', (data) => process.stderr.write(data));
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Open Jian Browser', exact: true }).click();
  await page.getByLabel('Browser address', { exact: true }).waitFor();
  const url = await app.evaluate(() => globalThis.nativeBrowserTest.url);
  await page.getByLabel('Browser address', { exact: true }).fill(url);
  await page.getByLabel('Browser address', { exact: true }).press('Enter');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await app.evaluate(() => globalThis.nativeBrowserTest.browser.state());
    if (state.url === url && state.title === 'Atlas Native Preview') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await app.evaluate(() => globalThis.nativeBrowserTest.browser.state().url), url);
  const divider = page.getByRole('separator', { name: 'Resize inspector' });
  await divider.focus();
  const before = Number(await divider.getAttribute('aria-valuenow'));
  await divider.press('ArrowLeft');
  assert.equal(Number(await divider.getAttribute('aria-valuenow')), before + 32);
  const box = await divider.boundingBox();
  assert.ok(box && box.height > 200, 'The divider runs the height of the inspector');
  await page.mouse.move(box.x + box.width / 2, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y + 120, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    (minimum) =>
      Number(
        document.querySelector('[aria-label="Resize inspector"]')?.getAttribute('aria-valuenow'),
      ) > minimum,
    before + 60,
  );
  assert.ok(
    Number(await divider.getAttribute('aria-valuenow')) > before + 60,
    'Pointer drag resizes the actual split view',
  );
  await page.evaluate(() => window.openTestPull());
  await page.getByRole('tab', { name: 'PR #7', exact: true }).waitFor();
  const hidden = await app.evaluate(() =>
    globalThis.nativeBrowserTest.win.contentView.children
      .filter((view) => view.webContents?.getURL().startsWith('http://127.0.0.1:'))
      .every((view) => !view.getVisible()),
  );
  assert.equal(hidden, true, 'The native page is hidden while the PR is selected');
  await page.evaluate(() => window.openTestAgent());
  await page.getByRole('tab', { name: 'Reviewer', exact: true }).waitFor();
  assert.equal(await page.getByRole('tab').count(), 3);
  await page.getByRole('tab', { name: 'Browser', exact: true }).click();
  await page.getByLabel('Browser address', { exact: true }).waitFor();
  const inspected = await app.evaluate(async () => {
    const { browser, url } = globalThis.nativeBrowserTest;
    const result = await browser.inspect(
      { profileId: 'atlas', sessionId: 'one' },
      {
        url,
        width: 500,
        height: 700,
        reusePage: false,
        actions: [
          { type: 'click', frame: 0, selector: '#menu' },
          { type: 'fill', frame: 0, selector: '#name', text: 'Nova' },
        ],
      },
    );
    return {
      snapshot: result.snapshot,
      screenshot: result.screenshot.byteLength,
      archive: result.archive.byteLength,
    };
  });
  assert.ok(inspected.snapshot.frames[0].text.includes('Expanded details'));
  assert.equal(
    inspected.snapshot.frames[0].elements.find((element) => element.tag === 'h1').styles[
      'font-size'
    ],
    '20px',
  );
  assert.ok(inspected.screenshot > 1000 && inspected.archive > 100);
  const isolated = await app.evaluate(async () => {
    const { browser, url } = globalThis.nativeBrowserTest;
    try {
      await browser.inspect(
        { profileId: 'other-profile', sessionId: 'two' },
        { url, width: 500, height: 700, reusePage: true, actions: [] },
      );
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(isolated, true, 'A different profile cannot inspect the previous profile browser');

  // The owner signs in by hand in the profile's browser, then an agent inspects that same page.
  const owner = '00000000-0000-4000-8000-000000000001';
  // The app tells both sides which conversation is open, the main process and the Inspector.
  const openConversation = async (sessionId) => {
    await app.evaluate(
      (_electron, place) => {
        globalThis.nativeBrowserTest.browser.showing({
          gatewayId: 'local',
          chat: { profileId: place.owner, sessionId: place.sessionId },
        });
      },
      { owner, sessionId },
    );
    await page.evaluate((id) => window.showTestConversation(id), sessionId);
  };
  await openConversation(owner);
  // A conversation does not inherit the browser the app had open before it.
  await page.waitForTimeout(200);
  assert.deepEqual(await page.getByRole('tab').allTextContents(), []);
  await page.getByRole('button', { name: 'Open Jian Browser', exact: true }).click();
  await page.getByLabel('Browser address', { exact: true }).waitFor();
  const reused = await app.evaluate(async (_electron, profileId) => {
    const { browser, url, hits } = globalThis.nativeBrowserTest;
    browser.showing({ gatewayId: 'local', chat: { profileId, sessionId: profileId } });
    await browser.navigate(`${url}login`);
    const contents = browser.view.webContents;
    await contents.executeJavaScript(
      `document.getElementById('state').textContent='Changed by the owner'`,
    );
    const before = { ...hits };
    // A fragment is state inside the page, not another page.
    const result = await browser.inspect(
      { profileId, sessionId: profileId },
      { url: `${url}private#section`, width: 900, height: 700, reusePage: true, actions: [] },
    );
    return {
      before,
      after: { ...hits },
      text: result.snapshot.frames[0].text,
      resources: result.snapshot.resources.map((resource) => resource.url),
      blocked: result.snapshot.blocked,
      open: contents.getURL(),
    };
  }, owner);
  assert.ok(reused.text.includes('Signed in as Nova'), 'The login survives into the inspection');
  assert.ok(reused.text.includes('Changed by the owner'), 'The page was not reloaded');
  assert.equal(reused.after['/private'], reused.before['/private'], 'The document is not re-read');
  assert.ok(
    reused.resources.some((resource) => resource.endsWith('/private.css')),
    `The cached stylesheet is exported: ${JSON.stringify(reused)}`,
  );
  assert.deepEqual(reused.blocked, []);

  // Content that arrives after load, in a cross-origin frame, is what an artifact viewer does.
  const late = await app.evaluate(async (_electron, profileId) => {
    const { browser, url } = globalThis.nativeBrowserTest;
    const result = await browser.inspect(
      { profileId, sessionId: profileId },
      { url: `${url}late`, width: 900, height: 700, reusePage: false, actions: [] },
    );
    return {
      frames: result.snapshot.frames.map((frame) => frame.text),
      resources: result.snapshot.resources.map((resource) => resource.url),
      blocked: result.snapshot.blocked,
    };
  }, owner);
  assert.ok(late.frames[0].includes('Rendered late'), JSON.stringify(late));
  assert.ok(late.frames.some((text) => text.includes('Inside the isolated frame')));
  assert.ok(
    late.resources.some((resource) => resource.endsWith('/frame.css')),
    `Resources of a cross-origin frame are exported: ${JSON.stringify(late)}`,
  );
  assert.deepEqual(late.blocked, []);

  const refused = await app.evaluate(async (_electron, profileId) => {
    const { browser, url, hits } = globalThis.nativeBrowserTest;
    const result = await browser.inspect(
      { profileId, sessionId: profileId },
      { url: `${url}write`, width: 900, height: 700, reusePage: false, actions: [] },
    );
    return { hits: hits['/recorded'] ?? 0, blocked: result.snapshot.blocked };
  }, owner);
  assert.equal(refused.hits, 0, 'A page cannot write over the network during an inspection');
  assert.ok(
    refused.blocked.some((item) => item.url.endsWith('/recorded')),
    `The refused write is reported: ${JSON.stringify(refused)}`,
  );

  // A page that locks its renderer fails that inspection alone, and the next one still runs.
  const hung = await app.evaluate(async (_electron, profileId) => {
    const { browser, url } = globalThis.nativeBrowserTest;
    const scope = { profileId, sessionId: profileId };
    const started = Date.now();
    const failure = await browser
      .inspect(
        scope,
        {
          url: `${url}hang`,
          width: 900,
          height: 700,
          reusePage: false,
          actions: [{ type: 'click', frame: 0, selector: '#hang' }],
        },
        AbortSignal.timeout(2500),
      )
      .then(
        () => null,
        (error) => error.message,
      );
    const elapsed = Date.now() - started;
    const next = await browser.inspect(scope, {
      url: `${url}private`,
      width: 900,
      height: 700,
      reusePage: false,
      actions: [],
    });
    return { failure, elapsed, next: next.snapshot.frames[0].text };
  }, owner);
  assert.ok(hung.failure, 'The locked page fails its own inspection');
  assert.ok(hung.elapsed < 10000, `The abort is honoured promptly: ${hung.elapsed}ms`);
  assert.ok(hung.next.includes('Signed in as Nova'), 'The queue and the profile session survive');

  // An agent can act while the owner is elsewhere: no visible view must not mean no capture.
  const unseen = await app.evaluate(async (_electron, profileId) => {
    const { browser, url, win } = globalThis.nativeBrowserTest;
    win.hide();
    browser.layout({ x: 0, y: 0, width: 0, height: 0 });
    try {
      const result = await browser.inspect(
        { profileId, sessionId: profileId },
        { url: `${url}private`, width: 900, height: 700, reusePage: false, actions: [] },
        AbortSignal.timeout(15000),
      );
      return { shot: result.screenshot.byteLength, text: result.snapshot.frames[0].text };
    } catch (error) {
      return { error: error.message };
    } finally {
      win.show();
    }
  }, owner);
  assert.ok(unseen.shot > 1000 && unseen.text.includes('Signed in'), JSON.stringify(unseen));

  // The agent drives the page the owner sees, with real input and its own pointer.
  const driven = await app.evaluate(async (_electron, profileId) => {
    const { browser, url, win } = globalThis.nativeBrowserTest;
    const scope = { profileId, sessionId: profileId };
    const act = (input) => browser.act(scope, input);
    const value = (id) =>
      browser.view.webContents.executeJavaScript(`document.getElementById('${id}').textContent`);
    const opened = await act({ action: 'open', url: `${url}form` });
    const pointerBefore = browser.pointer.view;
    await act({ action: 'click', selector: '#go' });
    const pointer = browser.pointer.view;
    const onTop = win.contentView.children.at(-1) === pointer;
    const pointerVisible = pointer.getVisible();
    const pointerBox = pointer.getBounds();
    const pageBox = browser.view.getBounds();
    const clicked = await value('clicks');
    await act({ action: 'type', selector: '#q', text: 'nova', submit: true });
    const sent = await value('out');
    const scrolled = await act({ action: 'scroll', deltaY: 900 });
    const scrollY = await browser.view.webContents.executeJavaScript('scrollY');
    const refused = await act({ action: 'click', selector: 'p' }).then(
      () => null,
      (error) => error.message,
    );
    await act({ action: 'click', selector: '#go' });
    const stayed = browser.pointer.view;
    await new Promise((resolve) => setTimeout(resolve, 600));
    const rest = {
      same: browser.pointer.view === stayed,
      visible: stayed.getVisible(),
      opacity: await stayed.webContents.executeJavaScript(
        `document.querySelector('img').style.opacity`,
      ),
    };
    return {
      opened: {
        url: opened.url,
        title: opened.title,
        frames: opened.frames.length,
        shot: opened.screenshot?.length,
        visible: opened.visible,
        viewport: opened.viewport,
      },
      noPointerUntilItActs: pointerBefore === undefined,
      onTop,
      pointerVisible,
      pointerBox,
      pageBox,
      clicked,
      sent,
      scrollY,
      scrolledShot: scrolled.screenshot?.length,
      refused,
      rest,
    };
  }, owner);
  assert.equal(driven.opened.title, 'Atlas Form');
  assert.ok(driven.opened.shot > 1000, 'Every action shows the agent the page');
  assert.equal(driven.opened.visible, true);
  assert.equal(driven.clicked, '1:true', 'A click is real input, as a person would make');
  assert.equal(driven.sent, 'sent nova:true', 'Typing and Enter reach the page as real input');
  assert.ok(driven.scrollY > 500, `The wheel scrolls the page: ${driven.scrollY}`);
  assert.equal(driven.noPointerUntilItActs, true);
  assert.equal(driven.onTop, true, 'The pointer is drawn over the page');
  assert.equal(driven.pointerVisible, true);
  assert.ok(
    driven.pointerBox.x >= driven.pageBox.x - 12 && driven.pointerBox.width === 60,
    `The pointer sits on the page: ${JSON.stringify(driven)}`,
  );
  assert.match(driven.refused, /exactly one element/);
  assert.deepEqual(
    driven.rest,
    { same: true, visible: true, opacity: '0.18' },
    'The pointer stays where it acted, and dims at rest',
  );

  // Agents keep to their profile's browser.
  const separate = await app.evaluate(async () => {
    const { browser } = globalThis.nativeBrowserTest;
    const other = { profileId: 'other-profile', sessionId: 'two' };
    const before = browser.view.webContents.getURL();
    const result = await browser.act(other, { action: 'read' }).then(
      (read) => read.url,
      (error) => error.message,
    );
    return { before, result };
  });
  assert.notEqual(separate.result, separate.before, 'Another profile does not read this page');

  await app.evaluate(async (_electron, profileId) => {
    const { browser } = globalThis.nativeBrowserTest;
    browser.showing({ gatewayId: 'local', chat: { profileId, sessionId: profileId } });
    await browser.act({ profileId, sessionId: profileId }, { action: 'read' });
  }, owner);

  // A picture holds the page's place while a menu is open over it, and the page comes back.
  const viewOf = () =>
    app.evaluate(() => {
      const { browser } = globalThis.nativeBrowserTest;
      return { visible: browser.view.getVisible(), bounds: browser.view.getBounds() };
    });
  await page.getByLabel('Browser options', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy address' }).waitFor();
  await page.waitForFunction(() =>
    document.querySelector('section[aria-label="Jian Browser"] img[src^="data:image"]'),
  );
  assert.equal((await viewOf()).visible, false, 'The menu is not under the native view');
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => !document.querySelector('section[aria-label="Jian Browser"] img[src^="data:image"]'),
  );
  assert.equal((await viewOf()).visible, true);

  // An overlay of the app sets the panel hidden: the page's picture stays behind its blur.
  await page.evaluate(() => window.setPanelHidden(true));
  await page.waitForFunction(() =>
    document.querySelector('section[aria-label="Jian Browser"] img[src^="data:image"]'),
  );
  assert.equal((await viewOf()).visible, false, 'The overlay is not under the native view');
  await page.evaluate(() => window.setPanelHidden(false));
  await page.waitForFunction(
    () => !document.querySelector('section[aria-label="Jian Browser"] img[src^="data:image"]'),
  );
  assert.equal((await viewOf()).visible, true);

  // The toolbar's controls share one height.
  const heights = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'section[aria-label="Jian Browser"] form > *, section[aria-label="Jian Browser"] form > div > button',
      ),
    ]
      .filter((element) => element.tagName !== 'LABEL' && element.tagName !== 'DIV')
      .map((element) => element.getBoundingClientRect().height),
  );
  assert.equal(new Set(heights).size, 1, `Toolbar heights: ${heights}`);

  // The page stays on screen and follows the divider while the owner drags it.
  const handle = await divider.boundingBox();
  const widthBefore = (await viewOf()).bounds.width;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x - 90, handle.y + 200, { steps: 6 });
  await page.waitForTimeout(150);
  const during = await viewOf();
  await page.mouse.up();
  assert.equal(during.visible, true, 'The page keeps rendering during a resize');
  assert.ok(during.bounds.width > widthBefore + 40, `It follows: ${JSON.stringify(during)}`);

  // Reloading the app takes the native view away first; the panel that returns places it again.
  const saved = Number(await divider.getAttribute('aria-valuenow'));
  const leaving = await app.evaluate(async () => {
    const { browser, win } = globalThis.nativeBrowserTest;
    const seen = new Promise((resolve) =>
      win.webContents.once('did-start-navigation', () =>
        setImmediate(() => resolve(browser.view.getVisible())),
      ),
    );
    win.webContents.reload();
    return seen;
  });
  assert.equal(leaving, false, 'The page is not left over the reloading app');
  await page.waitForFunction(() => window.showTestConversation);
  await page.evaluate((id) => window.showTestConversation(id), owner);
  await page.getByLabel('Browser address', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Resize inspector"]'));
  assert.equal(
    Number(await divider.getAttribute('aria-valuenow')),
    saved,
    'The size the owner chose survives the reload',
  );
  for (let attempt = 0; attempt < 60 && !(await viewOf()).visible; attempt += 1)
    await page.waitForTimeout(50);
  assert.equal((await viewOf()).visible, true, 'The page returns with the panel');

  // Each conversation has its own page, and one it is not showing costs no renderer.
  const conversations = await app.evaluate(async ({ webContents }, profileId) => {
    const { browser, url } = globalThis.nativeBrowserTest;
    const pages = () => webContents.getAllWebContents().filter((w) => w.getURL().startsWith(url));
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const place = (sessionId) =>
      browser.showing({ gatewayId: 'local', chat: { profileId, sessionId } });
    const A = '00000000-0000-4000-8000-00000000000a';
    const B = '00000000-0000-4000-8000-00000000000b';
    const C = '00000000-0000-4000-8000-00000000000c';
    place(A);
    await browser.navigate(`${url}private`);
    const inA = browser.state();
    place(B);
    const inB = browser.state();
    await browser.open();
    await browser.navigate(`${url}form`);
    const pageInB = browser.view;
    const inBAfter = browser.state();
    // An agent of A works while the owner looks at B: B is not touched, and nothing opens there.
    const focusBefore = browser.state().focus;
    const backgroundOpen = await browser.act(
      { profileId, sessionId: A },
      { action: 'open', url: `${url}form` },
    );
    const backgroundClick = await browser.act(
      { profileId, sessionId: A },
      { action: 'click', selector: '#go' },
    );
    const backgroundType = await browser.act(
      { profileId, sessionId: A },
      { action: 'type', selector: '#q', text: 'nova', submit: true },
    );
    const inBDuring = browser.state();
    const sameViewInB = browser.view === pageInB;
    const aTab = browser.tabs.get(`local:${profileId}:${A}`);
    const aFacts = await aTab.view.webContents.executeJavaScript(
      `[document.getElementById('clicks').textContent, document.getElementById('out').textContent]`,
    );
    const aLoginCookie = await aTab.view.webContents.session.cookies.get({ name: 'session' });
    const aVisibleToOwner = win_contains(aTab.view);
    function win_contains(view) {
      const { win } = globalThis.nativeBrowserTest;
      return (
        win.contentView.children.includes(view) && view.getVisible() && view.getBounds().x >= 0
      );
    }
    await wait(1200);
    const aReleased = aTab.view === undefined;
    const pagesWhileAReleased = pages().length;
    // Back in A: its own page returns from its address, and it asks to be focused for its work.
    place(A);
    const backInA = browser.state();
    await wait(300);
    const afterReturn = browser.view?.webContents.getURL();
    const bTab = browser.tabs.get(`local:${profileId}:${B}`);
    await wait(1200);
    const bReleased = bTab.view === undefined;
    // A conversation that never opened it has none, and leaves nothing behind.
    const before = browser.tabs.size;
    place(C);
    const inC = browser.state();
    place(A);
    const afterC = browser.tabs.size;
    return {
      inA,
      inB,
      inBAfter,
      inBDuring,
      focusBefore,
      sameViewInB,
      backgroundShot: backgroundOpen.screenshot?.length,
      backgroundUrl: backgroundOpen.url,
      backgroundClick: backgroundClick.visible,
      backgroundType: backgroundType.visible,
      aFacts,
      aLogin: aLoginCookie.length,
      aVisibleToOwner,
      aReleased,
      pagesWhileAReleased,
      backInA,
      afterReturn,
      bReleased,
      inC,
      before,
      afterC,
    };
  }, owner);
  assert.equal(
    conversations.inB.open,
    false,
    `B does not inherit A: ${JSON.stringify(conversations)}`,
  );
  assert.equal(conversations.inB.url, '');
  assert.ok(conversations.inBAfter.url.endsWith('/form'));
  assert.equal(conversations.inBDuring.url, conversations.inBAfter.url, 'A does not move B');
  assert.equal(conversations.inBDuring.focus, conversations.focusBefore, 'B is not asked to focus');
  assert.equal(conversations.sameViewInB, true);
  assert.equal(conversations.aVisibleToOwner, false, 'A works where the owner cannot see it');
  assert.ok(conversations.backgroundShot > 1000, 'The agent still sees its page off screen');
  assert.equal(conversations.aFacts[0], '1:true', 'Clicks land off screen, as real input');
  assert.equal(conversations.aFacts[1], 'sent nova:true', 'Typing works without the keyboard');
  assert.ok(conversations.aLogin >= 1, 'Conversations of a profile share its logins');
  assert.equal(conversations.aReleased, true, 'A page no one is using is freed');
  assert.ok(conversations.backInA.open, 'A keeps its browser for when the owner returns');
  assert.ok(conversations.backInA.url.endsWith('/form'), 'It remembers where it was');
  assert.ok(String(conversations.afterReturn).endsWith('/form'), 'Its page comes back');
  assert.equal(conversations.bReleased, true, 'Leaving B frees B');
  assert.equal(conversations.inC.open, false);
  assert.equal(conversations.afterC, conversations.before, 'A visit leaves nothing behind');

  // The same, as the owner sees it: another conversation shows none of this one's Inspector.
  const away = '00000000-0000-4000-8000-0000000000dd';
  await openConversation(away);
  await page.waitForTimeout(250);
  assert.deepEqual(await page.getByRole('tab').allTextContents(), []);
  assert.equal(await page.locator('[data-inspector-host]').count(), 0, 'Nothing is drawn for it');
  await openConversation(owner);
  await page.getByLabel('Browser address', { exact: true }).waitFor();
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Browser']);

  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await page.getByLabel('Browser address', { exact: true }).waitFor({ state: 'detached' });
  console.log(
    'Native Electron browser: navigation, keyboard and pointer resizing, responsive screenshots, DOM/styles/resources, interactions, profile isolation, reused signed-in pages, cross-origin frames, refused writes, locked pages, hidden windows, agent control with its pointer, the menu over the page, live resizing, app reloads and one browser per conversation passed.',
  );
} finally {
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
