'use client';

import type { Device, DevicePairing } from '@jian/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Action,
  ConfirmDialog,
  Overlay,
  OverlayActions,
  SettingsGroup,
  SettingsPageSkeleton,
  SettingsRow,
  SettingsRowsSkeleton,
  StatusPill,
  Toggle,
} from '../../kit';
import { date } from '../../lib/format';
import { panelApi } from '../../lib/query/client';
import { keys } from '../../lib/query/keys';
import { queries } from '../../lib/query/profile';

/** The phones' shape: a name with its platform, and Revoke. */
export function MobileWaiting() {
  return (
    <SettingsPageSkeleton label="Loading phones…">
      <SettingsGroup title="Phones">
        <SettingsRowsSkeleton count={2} pill buttons={1} />
      </SettingsGroup>
    </SettingsPageSkeleton>
  );
}

/** How often the list is read while a code is on screen, so the new phone shows within moments. */
const WATCH_MS = 3000;
/**
 * The least time between two codes, in ms. Each one is a row on the gateway, so a code that
 * arrives already spent must not set off a request per render.
 */
const RENEW_MS = 5000;

const failure = (error: unknown) => (error instanceof Error ? error.message : 'It failed.');

/**
 * The phones paired with the Jian app. A phone is paired by scanning a code the gateway makes,
 * which only a gateway that knows its public address can do, so that refusal is shown as it is.
 */
export function MobilePage() {
  const client = useQueryClient();
  const [pairing, setPairing] = useState(false);
  const devices = useQuery({
    ...queries.devices(),
    // Read faster only while a phone is expected.
    refetchInterval: pairing ? WATCH_MS : false,
  });
  // The phone asked about stays named while its dialog fades out.
  const [removing, setRemoving] = useState<Device>();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = devices.data ?? [];

  const setPreviews = async (device: Device, previews: boolean) => {
    try {
      const updated = await panelApi().updateDevice(device.id, { previews });
      client.setQueryData<Device[]>(keys.devices, (current = []) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (error) {
      toast.error(failure(error));
    }
  };

  const revoke = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await panelApi().revokeDevice(removing.id);
      client.setQueryData<Device[]>(keys.devices, (current = []) =>
        current.filter((item) => item.id !== removing.id),
      );
      setAsking(false);
      toast.success('Phone revoked.');
    } catch (error) {
      toast.error(failure(error));
    } finally {
      setBusy(false);
    }
  };

  const note = devices.error ? (
    <span role="alert" className="text-bad">
      Could not load phones.
    </span>
  ) : devices.isPending || list.length > 0 ? undefined : (
    'None yet'
  );

  return (
    <>
      <SettingsGroup
        title="Phones"
        note={note}
        loading={devices.isPending && !devices.error && 'Loading phones…'}
      >
        {devices.isPending && !devices.error && <SettingsRowsSkeleton count={2} pill buttons={1} />}
        {list.map((device) => (
          <div key={device.id} className="contents">
            <SettingsRow
              title={
                <span className="flex items-center gap-2">
                  <span className="truncate">{device.name}</span>
                  <StatusPill>{device.platform === 'ios' ? 'iPhone' : 'Android'}</StatusPill>
                </span>
              }
              description={
                device.lastSeenAt ? `Last seen ${date(device.lastSeenAt)}` : 'Not seen yet'
              }
            >
              <Action
                tone="danger"
                size="small"
                className="border border-bad/40"
                aria-label={`Revoke ${device.name}`}
                disabled={busy}
                onClick={() => {
                  setRemoving(device);
                  setAsking(true);
                }}
              >
                Revoke
              </Action>
            </SettingsRow>
            <Toggle
              label="Show previews"
              detail={`Put the start of a message in the notifications of ${device.name}.`}
              checked={device.previews}
              onCheckedChange={(next) => void setPreviews(device, next)}
            />
          </div>
        ))}
        <SettingsRow
          title="Pair a phone"
          description="Scan a code with the Jian app on your phone."
        >
          <Action tone="primary" size="small" onClick={() => setPairing(true)}>
            Pair a phone
          </Action>
        </SettingsRow>
      </SettingsGroup>
      <PairPhone
        open={pairing}
        onOpenChange={setPairing}
        known={devices.isSuccess ? list : undefined}
      />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Revoke ${removing?.name ?? 'this phone'}?`}
        action="Revoke phone"
        busy={busy}
        run={() => void revoke()}
      >
        The phone signs out and stops getting notifications. Pair it again to bring it back.
      </ConfirmDialog>
    </>
  );
}

/** A code, and when it arrived on this browser's clock: the gateway's clock may disagree. */
type Code = DevicePairing & { arrivedAt: number };

/** The address the Jian app reads from the QR code. */
const link = ({ url, code }: Code) => `jian://pair?url=${encodeURIComponent(url)}&code=${code}`;

function PairPhone({
  open,
  onOpenChange,
  known,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The paired phones, or undefined until the list has loaded. */
  known: Device[] | undefined;
}) {
  // The phones there were when the code was shown: any other one is the phone being paired.
  // Unset until the list has loaded, or every phone already paired would look new.
  const before = useRef<Set<string> | undefined>(undefined);
  const renewedAt = useRef(Number.NEGATIVE_INFINITY);
  const [code, setCode] = useState<Code>();
  const [problem, setProblem] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const renew = async () => {
    renewedAt.current = Date.now();
    try {
      const pairing = await panelApi().createDevicePairing();
      setCode({ ...pairing, arrivedAt: Date.now() });
      setNow(Date.now());
      setProblem('');
    } catch (error) {
      setCode(undefined);
      setProblem(failure(error));
    }
  };

  // Each opening asks for a first code; closing forgets the code and the phones seen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: renewed once per opening.
  useEffect(() => {
    if (!open) {
      setCode(undefined);
      setProblem('');
      before.current = undefined;
      return;
    }
    void renew();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  // Counted on this browser's clock from when the code arrived, never against `expiresAt`.
  const left = code
    ? Math.max(0, Math.ceil(code.expiresIn - Math.max(0, now - code.arrivedAt) / 1000))
    : 0;
  // A code lives five minutes and works once, so a spent one is swapped, never shown stale.
  const expired = code !== undefined && left === 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: renewed once per expired code.
  useEffect(() => {
    if (!expired) return;
    const timer = setTimeout(
      () => void renew(),
      Math.max(0, renewedAt.current + RENEW_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expired, code]);

  useEffect(() => {
    if (!open || !known) return;
    if (!before.current) {
      before.current = new Set(known.map((device) => device.id));
      return;
    }
    const seen = before.current;
    if (known.some((device) => !seen.has(device.id))) onOpenChange(false);
  }, [open, known, onOpenChange]);

  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Pair a phone" size="form">
      <div className="grid w-full gap-5 p-7">
        <header className="grid gap-1.5 pr-10">
          <h2 className="text-lg font-semibold tracking-tight">Pair a phone</h2>
          <ol className="list-decimal pl-5 text-sm leading-relaxed text-muted">
            <li>Open Jian on your phone and scan this code.</li>
            <li>The phone appears here once it is paired.</li>
          </ol>
        </header>
        <div className="grid min-h-64 place-items-center gap-3 rounded-xl border border-glass-edge bg-glass-hover p-5 text-center">
          {problem ? (
            <p role="alert" className="text-sm text-bad">
              {problem}
            </p>
          ) : code && !expired ? (
            <>
              {/* The code keeps its own white ground, as a phone's camera needs in either theme. */}
              <QRCodeSVG
                value={link(code)}
                size={208}
                level="M"
                marginSize={2}
                title="QR code to pair a phone"
                className="rounded-lg"
              />
              <span className="text-xs text-muted">
                Valid for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}. A new code
                follows on its own.
              </span>
            </>
          ) : (
            <span className="text-sm text-muted">Making a code…</span>
          )}
        </div>
        <OverlayActions>
          <Action tone="quiet" onClick={() => onOpenChange(false)}>
            Close
          </Action>
        </OverlayActions>
      </div>
    </Overlay>
  );
}
