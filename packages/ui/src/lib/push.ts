import { gatewayConnection } from '../platform/gateway';
import { panelApi } from './query/client';

/**
 * Notifications on this device, through its browser's push service. The service worker shows
 * them; the gateway sends one when the agent answers or asks in a chat the owner is not looking
 * at. This flag only spares a device whose system shows them a second, in-panel notice.
 */
const FLAG = 'jian.push';

const supported = () =>
  typeof window !== 'undefined' &&
  gatewayConnection().push !== false &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

/**
 * A native host shows system notifications itself, for every conversation the owner is not
 * reading: the panel then adds none of its own.
 */
export const hostNotifies = () => gatewayConnection().push === false;

export function pushOnHere() {
  try {
    return localStorage.getItem(FLAG) === 'on';
  } catch {
    return false;
  }
}

function remember(on: boolean) {
  try {
    if (on) localStorage.setItem(FLAG, 'on');
    else localStorage.removeItem(FLAG);
  } catch {
    // A private window keeps nothing; the in-panel notice then simply shows as well.
  }
}

/** The key as the Push API takes it, from the URL-safe base64 the gateway sends. */
function bytes(key: string) {
  const padded = `${key}${'='.repeat((4 - (key.length % 4)) % 4)}`
    .replaceAll('-', '+')
    .replaceAll('_', '/');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/**
 * With permission given, this device subscribed and the gateway told so. Said again on every
 * visit: the gateway forgets a device its push service refused once, and a new one is made here.
 */
async function subscribe() {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  const worker = await navigator.serviceWorker.ready;
  const { publicKey } = await panelApi().pushKey();
  const subscription =
    (await worker.pushManager.getSubscription()) ??
    (await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: bytes(publicKey),
    }));
  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys.auth) return;
  await panelApi().subscribePush({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
  remember(true);
}

/**
 * Notifications on by default. A browser asks the owner only from something they did — iOS
 * shows nothing otherwise, and Chrome hides a request made on its own — so the question comes
 * with their first tap or key in the panel; once allowed, every visit keeps the device on.
 * Refused, nothing is asked again: only the browser's settings can allow it then.
 */
export function enablePush(): () => void {
  if (!supported()) return () => {};
  const keep = () => void subscribe().catch(() => remember(false));

  if (Notification.permission === 'granted') {
    keep();
    return () => {};
  }
  remember(false);
  if (Notification.permission === 'denied') return () => {};

  const ask = () => {
    stop();
    void Notification.requestPermission().then((answer) => {
      if (answer === 'granted') keep();
    });
  };
  const stop = () => {
    window.removeEventListener('pointerdown', ask, true);
    window.removeEventListener('keydown', ask, true);
  };
  window.addEventListener('pointerdown', ask, true);
  window.addEventListener('keydown', ask, true);
  return stop;
}
