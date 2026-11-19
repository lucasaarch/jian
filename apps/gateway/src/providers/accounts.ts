import type { ProviderRecord } from '@jian/contracts';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { modelDefaults, providers, schedules, sessions } from '../storage/schema.js';
import { toProviderRecord } from './repository.js';

/**
 * The accounts of one vendor and authentication mode. An OpenAI key and a ChatGPT sign-in are
 * two modes of one vendor, each with accounts of its own; everything else has one mode.
 */
export type Vendor = { kind: ProviderRecord['kind']; authMode: 'api' | 'codex' };

/** Past this a vendor's list is a mistake to stop, not a set of plans anyone switches between. */
export const MAX_ACCOUNTS = 20;

export const vendorOf = (provider: Pick<ProviderRecord, 'kind' | 'authMode'>): Vendor => ({
  kind: provider.kind,
  authMode: provider.authMode ?? 'api',
});

const ofVendor = ({ kind, authMode }: Vendor) =>
  and(eq(providers.kind, kind), sql`coalesce(${providers.authMode}, 'api') = ${authMode}`);

/** Every live account, the inactive ones included; never a revoked one. */
export async function listAccounts(db: Queryable): Promise<ProviderRecord[]> {
  const rows = await db
    .select()
    .from(providers)
    .where(isNull(providers.revokedAt))
    .orderBy(asc(providers.createdAt))
    .limit(200);

  return rows.map(toProviderRecord);
}

/**
 * A vendor's live accounts, locked until the transaction ends. Two switches, or an add beside a
 * removal, then take turns: the second reads what the first committed, so neither leaves the
 * vendor with no active account or with two.
 */
export async function lockAccounts(db: Queryable, vendor: Vendor): Promise<ProviderRecord[]> {
  const rows = await db
    .select()
    .from(providers)
    .where(and(ofVendor(vendor), isNull(providers.revokedAt)))
    .orderBy(asc(providers.createdAt), asc(providers.id))
    .for('update');

  return rows.map(toProviderRecord);
}

/**
 * The account runs use in place of the one given: the active live account of the same vendor and
 * mode. A saved choice names whichever account was active when it was made, and may name one
 * since switched away from or removed; it still means this vendor. Null when the id is no account
 * or its vendor has none left.
 */
export async function activeAccountOf(
  db: Queryable,
  providerId: string,
): Promise<ProviderRecord | null> {
  const [named] = await db
    .select({ kind: providers.kind, authMode: providers.authMode })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1);
  if (!named) return null;

  const [active] = await db
    .select()
    .from(providers)
    .where(
      and(
        ofVendor(vendorOf({ kind: named.kind, authMode: named.authMode ?? undefined })),
        isNull(providers.revokedAt),
        eq(providers.active, true),
      ),
    )
    .limit(1);

  return active ? toProviderRecord(active) : null;
}

/**
 * Makes one live account the vendor's active one. Two statements, the others first: Postgres
 * checks a unique index row by row, so a single update could meet the new account before the old
 * one and refuse a swap that ends valid.
 */
export async function makeActive(db: Queryable, account: ProviderRecord): Promise<void> {
  await deactivate(db, vendorOf(account), account.id);
  await db.update(providers).set({ active: true }).where(eq(providers.id, account.id));
}

/** Leaves the vendor with no active account but `except`, before another is made active. */
export async function deactivate(db: Queryable, vendor: Vendor, except?: string): Promise<void> {
  await db
    .update(providers)
    .set({ active: false })
    .where(
      and(
        ofVendor(vendor),
        isNull(providers.revokedAt),
        ...(except ? [ne(providers.id, except)] : []),
      ),
    );
}

/** The newest live account but the one leaving, which takes over when the active one goes. */
export async function successorOf(
  db: Queryable,
  account: ProviderRecord,
): Promise<ProviderRecord | null> {
  const [row] = await db
    .select()
    .from(providers)
    .where(
      and(ofVendor(vendorOf(account)), isNull(providers.revokedAt), ne(providers.id, account.id)),
    )
    .orderBy(desc(providers.createdAt), desc(providers.id))
    .limit(1);

  return row ? toProviderRecord(row) : null;
}

export async function renameAccount(db: Queryable, id: string, label: string): Promise<void> {
  await db.update(providers).set({ label }).where(eq(providers.id, id));
}

/**
 * Points every saved choice of a model at the vendor's active account: the installation's model
 * defaults, each conversation's own model and each schedule's. A choice means the vendor, so the
 * panel, which lists only active accounts, keeps showing it as chosen after a switch, and a vendor
 * connected again picks up the choices made before it was removed. A run already frozen keeps its
 * id: the runtime resolves it the same way when the run starts.
 */
export async function repointChoices(db: Queryable, active: ProviderRecord): Promise<void> {
  const { kind, authMode } = vendorOf(active);
  const others = db
    .select({ id: providers.id })
    .from(providers)
    .where(and(ofVendor({ kind, authMode }), ne(providers.id, active.id)));

  await db
    .update(modelDefaults)
    .set({ providerId: active.id })
    .where(inArray(modelDefaults.providerId, others));

  for (const table of [sessions, schedules]) {
    await db.execute(sql`update ${table}
      set model = jsonb_set(model, '{providerId}', to_jsonb(${active.id}::text))
      where model ->> 'providerId' in (
        select id::text from providers
        where kind = ${kind} and coalesce(auth_mode, 'api') = ${authMode} and id <> ${active.id}
      )`);
  }
}

/** The first "Account N" no live account of the vendor is called. */
export function freeLabel(taken: Array<string | undefined>): string {
  for (let n = 1; ; n++) {
    const label = `Account ${n}`;
    if (!taken.includes(label)) return label;
  }
}

/**
 * Who a ChatGPT sign-in is, read from its access token: the account OpenAI bills, and the email
 * shown as its name. Signing in again as the same account refreshes it instead of adding a twin.
 */
export function chatgptIdentity(secret: string | undefined): { account?: string; email?: string } {
  try {
    const { access_token: token } = JSON.parse(secret ?? '') as { access_token?: string };
    const payload = JSON.parse(
      Buffer.from(token?.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as {
      'https://api.openai.com/auth'?: { chatgpt_account_id?: string };
      'https://api.openai.com/profile'?: { email?: string };
    };
    const account = payload['https://api.openai.com/auth']?.chatgpt_account_id;
    const email = payload['https://api.openai.com/profile']?.email;

    return {
      ...(typeof account === 'string' && account ? { account } : {}),
      ...(typeof email === 'string' && email ? { email: email.slice(0, 60) } : {}),
    };
  } catch {
    return {};
  }
}
