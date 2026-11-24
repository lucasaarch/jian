import {
  type UpdateAttempt,
  type UpdateComponent,
  type UpdateResult,
  type UpdateStatus,
  type UpdateWebhook,
  updateAttemptSchema,
  updateInputSchema,
  updateWebhookInputSchema,
} from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Clock } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import type { ReleaseNotes } from '../releases/service.js';
import type { GatewayVault } from '../security/gateway-vault.js';
import type { Store } from '../storage/database.js';
import { gatewaySettings } from '../storage/schema.js';
import { needsBackup } from './backup.js';

/** The `gateway_settings` key holding the last attempts; plain JSON, no secret in it. */
const ATTEMPTS = 'updateAttempts';
const KEEP = 10;
/** A platform answers a redeploy hook at once and deploys behind it; this is generous. */
const TIMEOUT_MS = 15_000;

const secretOf = (component: UpdateComponent) => `updates:webhook:${component}`;

const savedSchema = updateWebhookInputSchema.extend({ updatedAt: z.string() });
type Saved = z.output<typeof savedSchema>;

/** The compose updater (`jian-updater` in compose.yaml), when its address and token are set. */
export type UpdaterSidecar = { url: string; token: string };

/**
 * The updater from the environment: both its address and its token, or nothing. `make setup`
 * writes a token for every installation, so the token alone does not mean one is running.
 */
export function updaterSidecar(env = process.env): { sidecar?: UpdaterSidecar } {
  const url = env.JIAN_UPDATER_URL?.trim();
  const token = env.JIAN_UPDATER_TOKEN?.trim();
  return url && token && URL.canParse(url) ? { sidecar: { url, token } } : {};
}

/**
 * The request a saved webhook makes for one release of one component: the placeholders filled
 * everywhere the owner may write them, the parameters encoded and added after the URL's own
 * query. Nothing is added that the owner did not configure, bar a content type for a body.
 */
export function webhookRequest(saved: Saved, version: string, component: UpdateComponent) {
  const fill = (text: string) =>
    text.replaceAll('{version}', version).replaceAll('{component}', component);
  const url = new URL(fill(saved.url));
  for (const param of saved.params) url.searchParams.append(param.name, fill(param.value));

  const headers = new Headers({ 'user-agent': 'jian-gateway' });
  for (const header of saved.headers) headers.set(header.name, fill(header.value));
  const body = saved.body?.trim() ? fill(saved.body) : undefined;
  if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', isJson(body) ? 'application/json' : 'text/plain');
  }
  return { url, init: { method: saved.method, headers, ...(body !== undefined ? { body } : {}) } };
}

function isJson(text: string) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function reason(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'it timed out';
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  // Never the error's message alone: a fetch error can spell the URL, and the path is a secret.
  return typeof cause === 'string' ? cause : 'the request failed';
}

/**
 * Updates a server installation in place, to the newest release GitHub lists, by asking what
 * deployed it to deploy that version again: the platform's redeploy webhooks, or the compose
 * updater beside the gateway. The gateway only starts it; the panel watches /health for the
 * new version to answer.
 */
export class GatewayUpdates {
  private busy = false;

  constructor(
    private readonly store: Store,
    private readonly vault: GatewayVault,
    private readonly releases: Pick<ReleaseNotes, 'releases' | 'lastCheck'>,
    private readonly fetcher: typeof fetch,
    private readonly options: { local: boolean; sidecar?: UpdaterSidecar; clock?: Clock },
  ) {}

  /** `fresh` asks GitHub now: "Check for updates", right after a release went out. */
  async status(fresh = false): Promise<UpdateStatus> {
    const { version, updates } = await this.releases.releases(fresh);
    const { checkedAt, error } = this.releases.lastCheck();
    const latest = updates[0];
    const [gateway, web] = await Promise.all([this.saved('gateway'), this.saved('web')]);

    return {
      ...(version ? { current: version } : {}),
      ...(latest
        ? { latest: { version: latest.version, date: latest.date, body: latest.body } }
        : {}),
      ...(checkedAt ? { checkedAt } : {}),
      ...(error ? { checkError: error } : {}),
      // Every release between the running one and the newest: skipping one skips no warning.
      backup: updates.some((note) => needsBackup(note.body)),
      method: this.method(Boolean(gateway)),
      webhooks: {
        ...(gateway ? { gateway: this.shown(gateway) } : {}),
        ...(web ? { web: this.shown(web) } : {}),
      },
      attempts: await this.attempts(),
    };
  }

  async saveWebhook(component: UpdateComponent, input: unknown): Promise<UpdateStatus> {
    this.refuseLocal();
    const webhook = updateWebhookInputSchema.parse(input);
    if (webhook.method === 'GET' && webhook.body?.trim()) {
      throw new GatewayError(400, 'A GET webhook cannot send a body');
    }
    const saved: Saved = { ...webhook, updatedAt: new Date(this.now()).toISOString() };
    try {
      webhookRequest(saved, '0.0.0', component);
    } catch {
      throw new GatewayError(400, 'The webhook URL is not valid once filled');
    }
    await this.vault.put(secretOf(component), JSON.stringify(saved));
    return this.status();
  }

  async removeWebhook(component: UpdateComponent): Promise<UpdateStatus> {
    await this.vault.discard(secretOf(component));
    return this.status();
  }

  async update(input: unknown): Promise<UpdateAttempt> {
    this.refuseLocal();
    const { version, confirmBackup } = updateInputSchema.parse(input);
    const status = await this.status();

    if (status.method === 'none') {
      throw new GatewayError(409, 'No update method is configured');
    }
    if (!status.latest) throw new GatewayError(409, 'Jian is already on the newest release');
    if (status.latest.version !== version) {
      throw new GatewayError(409, `Jian ${status.latest.version} is the newest release now`);
    }
    if (status.backup && !confirmBackup) {
      throw new GatewayError(409, 'This update asks for a database backup first: confirm it');
    }
    // One gateway replica starts one update; a second click would redeploy twice.
    if (this.busy) throw new GatewayError(409, 'An update is already starting');

    this.busy = true;
    try {
      const results =
        status.method === 'sidecar'
          ? await this.callSidecar(version)
          : await this.callHooks(version);
      const attempt: UpdateAttempt = {
        at: new Date(this.now()).toISOString(),
        ...(status.current ? { from: status.current } : {}),
        version,
        method: status.method,
        ok: results.every((result) => result.ok),
        results,
      };
      await this.record(attempt);
      console.info(
        `jian: update to ${version} by ${attempt.method}: ${results
          .map((result) => `${result.component} ${result.ok ? 'started' : 'failed'}`)
          .join(', ')}`,
      );
      return attempt;
    } finally {
      this.busy = false;
    }
  }

  private method(gatewayHook: boolean): UpdateStatus['method'] {
    if (this.options.local) return 'none';
    if (this.options.sidecar) return 'sidecar';
    return gatewayHook ? 'webhook' : 'none';
  }

  /** A desktop app's own gateway is updated with the app, never from here. */
  private refuseLocal() {
    if (this.options.local) {
      throw new GatewayError(409, 'This gateway updates with the desktop app');
    }
  }

  /**
   * The web first, then the gateway: the gateway's own redeploy may stop this very process, so
   * it goes last, once the web's answer is in hand. A web that refused leaves the gateway as it
   * is, so the two never end up a release apart.
   */
  private async callHooks(version: string): Promise<UpdateResult[]> {
    const results: UpdateResult[] = [];
    const web = await this.saved('web');

    if (web) results.push(await this.callHook('web', web, version));
    const gateway = await this.saved('gateway');
    if (!gateway) return results;

    if (results.some((result) => !result.ok)) {
      results.push({ component: 'gateway', ok: false, error: 'Not called: the web update failed' });
    } else {
      results.push(await this.callHook('gateway', gateway, version));
    }
    return results;
  }

  private async callHook(
    component: UpdateComponent,
    saved: Saved,
    version: string,
  ): Promise<UpdateResult> {
    try {
      const { url, init } = webhookRequest(saved, version, component);
      const response = await this.fetcher(url, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      return response.ok
        ? { component, ok: true, status: response.status }
        : {
            component,
            ok: false,
            status: response.status,
            error: `The ${component} webhook answered HTTP ${response.status}`,
          };
    } catch (error) {
      return {
        component,
        ok: false,
        error: `The ${component} webhook could not be reached: ${reason(error)}`,
      };
    }
  }

  /** The updater pulls and restarts both images itself, so one answer stands for both. */
  private async callSidecar(version: string): Promise<UpdateResult[]> {
    const sidecar = this.options.sidecar as UpdaterSidecar;
    const both = (result: Omit<UpdateResult, 'component'>): UpdateResult[] => [
      { component: 'web', ...result },
      { component: 'gateway', ...result },
    ];

    try {
      const response = await this.fetcher(new URL('/update', sidecar.url), {
        method: 'POST',
        headers: { authorization: `Bearer ${sidecar.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ version }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const answer = (await response.json().catch(() => ({}))) as { error?: unknown };
      if (response.ok) return both({ ok: true, status: response.status });
      const said = typeof answer.error === 'string' ? `: ${answer.error.slice(0, 200)}` : '';
      return both({
        ok: false,
        status: response.status,
        error:
          response.status === 401
            ? 'The updater refused the token: JIAN_UPDATER_TOKEN differs between the two'
            : `The updater answered HTTP ${response.status}${said}`,
      });
    } catch (error) {
      return both({ ok: false, error: `The updater could not be reached: ${reason(error)}` });
    }
  }

  private async saved(component: UpdateComponent): Promise<Saved | undefined> {
    const raw = await this.vault.read(secretOf(component));
    if (!raw) return undefined;
    const parsed = savedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  }

  private shown(saved: Saved): UpdateWebhook {
    return {
      // A placeholder in the host leaves no origin to show until it is filled.
      origin: URL.parse(saved.url)?.origin ?? 'unknown',
      method: saved.method,
      params: saved.params.map((param) => param.name),
      headers: saved.headers.map((header) => header.name),
      body: Boolean(saved.body?.trim()),
      updatedAt: saved.updatedAt,
    };
  }

  private async attempts(): Promise<UpdateAttempt[]> {
    const [row] = await this.store.db
      .select({ value: gatewaySettings.value })
      .from(gatewaySettings)
      .where(eq(gatewaySettings.key, ATTEMPTS))
      .limit(1);
    const parsed = z.array(updateAttemptSchema).safeParse(row?.value ?? []);
    return parsed.success ? parsed.data : [];
  }

  private async record(attempt: UpdateAttempt) {
    const value = [attempt, ...(await this.attempts())].slice(0, KEEP);
    await this.store.db
      .insert(gatewaySettings)
      .values({ key: ATTEMPTS, value })
      .onConflictDoUpdate({ target: gatewaySettings.key, set: { value, updatedAt: new Date() } });
  }

  private now() {
    return (this.options.clock ?? Date.now)();
  }
}
