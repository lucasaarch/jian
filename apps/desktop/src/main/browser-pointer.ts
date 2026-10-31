import { type WebContents, WebContentsView } from 'electron';
import sprite from '../../../../packages/remote-core/native/jian-pointer.png?inline';

/** The sprite's canvas and where its tip is in it, as the Computer Use helpers draw it. */
const SIZE = 60;
const HOTSPOT = 12;
const ACTIVE_ALPHA = 0.94;
const IDLE_ALPHA = 0.18;

/** How the sprite's page says what the mouse did: it is ours, and has no bridge of its own. */
const MOUSE = 'jian-pointer-mouse:';

const page = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden}
img{position:absolute;inset:0;width:${SIZE}px;height:${SIZE}px;transition:opacity .25s;opacity:${ACTIVE_ALPHA}}
i{position:absolute;left:${HOTSPOT}px;top:${HOTSPOT}px;width:0;height:0;border-radius:50%;background:rgba(255,255,255,.35);transform:translate(-50%,-50%)}
i.on{animation:r .16s ease-out}@keyframes r{from{width:6px;height:6px;opacity:1}to{width:48px;height:48px;opacity:0}}
</style><img src="${sprite}" alt=""><i></i><script>
const tell = (e) => console.log('${MOUSE}' + JSON.stringify({ type: e.type, x: e.clientX, y: e.clientY, button: e.button, clicks: e.detail, dx: e.deltaX || 0, dy: e.deltaY || 0 }));
for (const type of ['mousemove', 'mousedown', 'mouseup']) addEventListener(type, tell);
addEventListener('wheel', tell, { passive: true });
</script>`;
const BUTTONS = ['left', 'middle', 'right'] as const;
const INPUT = { mousemove: 'mouseMove', mousedown: 'mouseDown', mouseup: 'mouseUp' } as const;

/**
 * The agent's own pointer over the page, the sprite Computer Use draws. It is a small transparent
 * view of its own: nothing is added to the website, so no page can read, block or capture it.
 */
export class BrowserPointer {
  private view?: WebContentsView;
  private tip?: { x: number; y: number };
  private idle?: NodeJS.Timeout;
  private origin = { x: 0, y: 0, width: 0, height: 0 };

  constructor(
    private readonly host: () => { contentView: Electron.View } | undefined,
    /** The page under the sprite, which gets the owner's mouse where the sprite covers it. */
    private readonly target: () => WebContents | undefined,
    /** How long without an action before it dims, as Computer Use's does. */
    private readonly idleMs: number,
  ) {}

  /** Where it stands in the page, to come back to with its conversation. */
  get position() {
    return this.tip;
  }

  /**
   * A view takes the mouse from what is under it, and this one stays on the page: what lands on
   * the sprite goes on to the page, so the owner can click and scroll right through it.
   */
  private passThrough(message: string) {
    if (!message.startsWith(MOUSE) || !this.tip) return;
    const page = this.target();
    if (!page || page.isDestroyed()) return;
    const mouse = JSON.parse(message.slice(MOUSE.length));
    const x = Math.round(this.tip.x - HOTSPOT + mouse.x);
    const y = Math.round(this.tip.y - HOTSPOT + mouse.y);
    if (mouse.type === 'wheel') {
      page.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -mouse.dx, deltaY: -mouse.dy });
      return;
    }
    const type = INPUT[mouse.type as keyof typeof INPUT];
    if (!type) return;
    // The click took the keyboard to the sprite's page, where typing would go nowhere.
    if (type === 'mouseDown') page.focus();
    page.sendInputEvent({
      type,
      x,
      y,
      ...(type === 'mouseMove'
        ? {}
        : { button: BUTTONS[mouse.button] ?? 'left', clickCount: mouse.clicks || 1 }),
    });
  }

  private ensure() {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    view.setBackgroundColor('#00000000');
    view.webContents.on('console-message', (event) => this.passThrough(event.message));
    void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    this.view = view;
    return view;
  }

  private place() {
    if (!this.view || !this.tip) return;
    this.view.setBounds({
      x: Math.round(this.origin.x + this.tip.x - HOTSPOT),
      y: Math.round(this.origin.y + this.tip.y - HOTSPOT),
      width: SIZE,
      height: SIZE,
    });
  }

  private script(code: string) {
    void this.view?.webContents.executeJavaScript(code).catch(() => {});
  }

  /** Follows the page as the owner resizes the panel, and hides with it. */
  follow(bounds: { x: number; y: number; width: number; height: number }, visible: boolean) {
    this.origin = bounds;
    this.place();
    this.view?.setVisible(visible);
  }

  /** Back on top after the page's view was added again. */
  raise() {
    if (this.view) this.host()?.contentView.addChildView(this.view);
  }

  hide() {
    this.free();
  }

  private free() {
    clearTimeout(this.idle);
    const view = this.view;
    this.view = undefined;
    this.tip = undefined;
    if (!view) return;
    this.host()?.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  }

  async moveTo(to: { x: number; y: number }, signal: AbortSignal) {
    const view = this.ensure();
    this.host()?.contentView.addChildView(view);
    clearTimeout(this.idle);
    const from = this.tip ?? { x: this.origin.width / 2, y: this.origin.height / 2 };
    view.setVisible(true);
    this.script(`document.querySelector('img').style.opacity=${ACTIVE_ALPHA}`);
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.min(28, Math.round(distance / 24)));
    for (let step = 1; step <= steps && !signal.aborted; step += 1) {
      const t = step / steps;
      const eased = 1 - (1 - t) ** 3;
      this.tip = { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased };
      this.place();
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    this.tip = to;
    this.place();
  }

  press() {
    this.script(
      `(()=>{const r=document.querySelector('i');r.classList.remove('on');void r.offsetWidth;r.classList.add('on')})()`,
    );
  }

  /** It stays where it last acted, and dims when the agent has been away a while. */
  rest() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.dim(), this.idleMs);
  }

  private dim() {
    this.script(`document.querySelector('img').style.opacity=${IDLE_ALPHA}`);
  }

  /** Back where it stood when the owner returns to its conversation, already at rest. */
  restore(tip: { x: number; y: number }, visible: boolean) {
    const view = this.ensure();
    this.host()?.contentView.addChildView(view);
    this.tip = tip;
    this.place();
    view.setVisible(visible);
    view.webContents.once('did-finish-load', () => this.dim());
  }
}
