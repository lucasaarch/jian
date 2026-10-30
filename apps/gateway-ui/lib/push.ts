import { panelApi } from './query/client';

/**
 * Notifications on this device, through its browser's push service. The service worker shows
 * them; the gateway sends one when the agent answers or asks in a chat the owner is not looking
 * at. Which devices are on is the gateway's to know; this flag only spares this one a second,
 * in-panel notice of what its system already shows.
 */
const FLAG = 'jian.push';

export type PushState = 'unsupported' | 'blocked' | 'off' | 'on';

const pushSupported = () =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

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

async function registration() {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const existing = await (await navigator.serviceWorker.getRegistration('/'))?.pushManager
    .getSubscription()
    .catch(() => null);
  remember(Boolean(existing));
  return existing ? 'on' : 'off';
}

/** Asks this device for permission, then subscribes it. Called from a press: iOS insists. */
export async function turnPushOn(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if ((await Notification.requestPermission()) !== 'granted') return 'blocked';
  const { publicKey } = await panelApi().pushKey();
  const worker = await registration();
  const subscription =
    (await worker.pushManager.getSubscription()) ??
    (await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: bytes(publicKey),
    }));
  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys.auth) throw new Error('This browser did not subscribe.');
  await panelApi().subscribePush({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
  remember(true);
  return 'on';
}

export async function turnPushOff(): Promise<PushState> {
  const subscription = await (
    await navigator.serviceWorker.getRegistration('/')
  )?.pushManager.getSubscription();
  if (subscription) {
    await panelApi().unsubscribePush(subscription.endpoint);
    await subscription.unsubscribe();
  }
  remember(false);
  return 'off';
}
