import { appendFile, lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  eligibility,
  finalText,
  fingerprint,
  planWrite,
  prepareTranslation,
  request,
  TRANSLATION_INSTRUCTION,
  translationSchema,
  validateTranslation,
} from './translate-core.mjs';

const config = JSON.parse(await readFile(new URL('./translate-config.json', import.meta.url)));
const workflow = '.github/workflows/translate.yml';
const generationStep = 'Generate translation';
const contextKeys = [
  'repo',
  'kind',
  'number',
  'event',
  'eventName',
  'ref',
  'defaultBranch',
  'workflowSha',
  'runId',
  'runAttempt',
  'actor',
  'dryRun',
  'id',
  'contentHash',
];

// Three outcomes. 'refused' is the translator doing its job, a text left as it is, and ends green:
// a pull request must not show a failure because of what its author wrote. 'failed' is something
// that broke, and ends red.
const done = (state, reason, extra = {}) => ({ state, reason, ...extra });
const refused = (reason) => done('refused', reason);
const fail = (code) => {
  throw new Error(code);
};
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const createTransport = (fetchImpl = globalThis.fetch) => ({
  fetch: fetchImpl,
  now: Date.now,
  sleep: wait,
});

function githubURL(path, query = {}) {
  const prefix = `/repos/${config.repositories[0]}`;
  if (
    !path.startsWith(prefix) ||
    !/^(?:|\/issues\/[1-9]\d*|\/pulls\/[1-9]\d*|\/collaborators\/[A-Za-z0-9-]+\/permission|\/actions\/workflows\/translate\.yml\/runs|\/actions\/runs\/[1-9]\d*(?:\/attempts\/[1-9]\d*\/jobs)?)$/.test(
      path.slice(prefix.length),
    )
  )
    fail('ROUTE_REFUSED');
  const url = new URL(`https://api.github.com${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}
const headers = (token) => ({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': config.apiVersion,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});
async function read(path, transport, token, query) {
  const url = githubURL(path, query);
  for (let attempt = 0; attempt < config.githubReadAttempts; attempt++) {
    let response;
    try {
      response = await request(
        url,
        { method: 'GET', headers: headers(token), signal: AbortSignal.timeout(30000) },
        transport,
        [200],
      );
    } catch {
      response = { status: 503 };
    }
    if (response.data !== undefined) return response.data;
    if (![429, 500, 502, 503, 504].includes(response.status)) break;
    if (attempt < config.githubReadAttempts - 1) await transport.sleep(1000 * 2 ** attempt);
  }
  fail('GITHUB_READ_FAILED');
}
const root = (c) => `/repos/${c.repo}`;
const itemPath = (c) => `${root(c)}/${c.kind === 'pull' ? 'pulls' : 'issues'}/${c.number}`;

/** This very run, as GitHub records it, is the workflow it claims to be. */
async function verifyRun(c, transport, token) {
  const run = await read(`${root(c)}/actions/runs/${c.runId}`, transport, token);
  // A run's head fields describe the pull request under pull_request_target, so the checks stay on
  // what identifies the run itself.
  if (
    run?.id !== c.runId ||
    run.path !== workflow ||
    run.event !== c.eventName ||
    run.run_attempt !== 1 ||
    run.repository?.full_name !== c.repo ||
    run.status !== 'in_progress' ||
    (c.eventName === 'workflow_dispatch' && run.actor?.login !== c.actor)
  )
    fail('RUN_ORIGIN_REFUSED');
}

/** The item now, with the permission a manual run was asked by. */
async function fresh(c, transport, token) {
  const repo = await read(root(c), transport, token),
    item = await read(itemPath(c), transport, token);
  const permission =
    c.event === 'manual' || c.event === 'manualdry'
      ? (await read(`${root(c)}/collaborators/${c.actor}/permission`, transport, token)).permission
      : undefined;
  return {
    item,
    decision: eligibility(c, repo, item, permission, config.repositories),
  };
}

async function runsThisMonth(c, transport, token, since) {
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const data = await read(`${root(c)}/actions/workflows/translate.yml/runs`, transport, token, {
      created: `>=${since.toISOString().slice(0, 10)}`,
      per_page: '100',
      page: String(page),
    });
    if (!Array.isArray(data?.workflow_runs)) fail('GITHUB_READ_FAILED');
    runs.push(...data.workflow_runs);
    if (data.workflow_runs.length < 100) return runs;
  }
  return null;
}

/**
 * Whether another generation fits the budget, counted from what GitHub recorded. Runs for different
 * items can start together, so a burst may pass the limit by the few that were running: it bounds
 * spending, it is not a ledger. Only this month's runs are read, so a long history never blocks it.
 */
async function withinBudget(c, transport, token) {
  const now = transport.now(),
    since = new Date(now);
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  const runs = await runsThisMonth(c, transport, token, since);
  if (!runs) return false;
  let month = 0,
    hour = 0;
  for (const run of runs) {
    // A run whose gate refused it, like an app's pull request, did nothing and costs no read.
    if (run.id === c.runId || run.conclusion === 'skipped') continue;
    // The default jobs route shows only the latest attempt; an earlier one may have generated.
    for (let attempt = 1; attempt <= (run.run_attempt ?? 1); attempt++) {
      const data = await read(
        `${root(c)}/actions/runs/${run.id}/attempts/${attempt}/jobs`,
        transport,
        token,
        { per_page: '100' },
      );
      for (const job of data?.jobs ?? [])
        for (const step of job.steps ?? []) {
          const started = Date.parse(step.started_at);
          if (step.name !== generationStep || step.conclusion === 'skipped' || !started) continue;
          month++;
          if (started > now - 3600000) hour++;
        }
    }
  }
  return month < config.maxMonthlyGenerations && hour < config.maxHourlyGenerations;
}

function contextFrom(env, event) {
  const manual = env.TRANSLATE_EVENT_NAME === 'workflow_dispatch',
    dryRun = env.TRANSLATE_DRY_RUN === 'true',
    kind = manual
      ? env.TRANSLATE_KIND
      : env.TRANSLATE_EVENT_NAME === 'issues'
        ? 'issue'
        : env.TRANSLATE_EVENT_NAME === 'pull_request_target'
          ? 'pull'
          : null,
    item = kind === 'issue' ? event.issue : event.pull_request,
    number = manual ? Number(env.TRANSLATE_NUMBER) : item?.number,
    c = {
      repo: env.TRANSLATE_REPOSITORY,
      kind,
      number,
      event: manual ? (dryRun ? 'manualdry' : 'manual') : event.action,
      eventName: env.TRANSLATE_EVENT_NAME,
      ref: env.TRANSLATE_REF,
      defaultBranch: env.TRANSLATE_DEFAULT_BRANCH,
      workflowSha: env.SOURCE_SHA,
      runId: Number(env.TRANSLATE_RUN_ID),
      runAttempt: Number(env.TRANSLATE_RUN_ATTEMPT),
      actor: env.TRANSLATE_ACTOR,
      dryRun,
    };
  if (!manual) c.id = item?.id;
  validateContext(c);
  return c;
}

function validateContext(c) {
  if (
    !config.repositories.includes(c?.repo) ||
    !['issue', 'pull'].includes(c.kind) ||
    !positive(c.number) ||
    !['edited', 'opened', 'manual', 'manualdry'].includes(c.event) ||
    (c.event === 'opened' && c.kind !== 'pull') ||
    !['issues', 'pull_request_target', 'workflow_dispatch'].includes(c.eventName) ||
    typeof c.defaultBranch !== 'string' ||
    c.ref !== `refs/heads/${c.defaultBranch}` ||
    !/^[a-f0-9]{40}$/.test(c.workflowSha) ||
    !positive(c.runId) ||
    c.runAttempt !== 1 ||
    !/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(c.actor) ||
    typeof c.dryRun !== 'boolean' ||
    c.dryRun !== (c.event === 'manualdry') ||
    (c.id !== undefined && !positive(c.id)) ||
    (c.contentHash !== undefined && !/^[a-f0-9]{64}$/.test(c.contentHash)) ||
    Object.keys(c).some((key) => !contextKeys.includes(key))
  )
    fail('CONTEXT_REFUSED');
}
function storedContext(raw) {
  const c = JSON.parse(raw);
  validateContext(c);
  if (!c.id || !c.contentHash) fail('CONTEXT_REFUSED');
  return c;
}

/** Admits the run: nothing here costs a generation or holds a credential that could write. */
export async function collect(env, transport = createTransport()) {
  if (!config.enabled) return refused('DISABLED');
  const stat = await lstat(env.GITHUB_EVENT_PATH);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 3 * 1024 * 1024)
    fail('CONTEXT_REFUSED');
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')),
    c = contextFrom(env, event),
    token = env.GITHUB_TOKEN;
  await verifyRun(c, transport, token);
  const { item, decision } = await fresh(c, transport, token);
  if (decision.state !== 'ready') return decision;
  const prepared = prepareTranslation(item, config);
  if (prepared.state !== 'ready') return prepared;
  if (c.dryRun) return refused('DRY_RUN_VALIDATED');
  if (!(await withinBudget(c, transport, token))) return refused('BUDGET_EXHAUSTED');
  return done('ready', 'COLLECTED', {
    context: { ...c, id: item.id, contentHash: fingerprint(item) },
  });
}

async function unchanged(c, transport, token) {
  const { item, decision } = await fresh(c, transport, token);
  if (decision.state !== 'ready') return { refusal: decision };
  if (fingerprint(item) !== c.contentHash) return { refusal: refused('CHANGED') };
  return { item };
}

/** Asks the model. It holds the provider's key, so it must hold no way to write to GitHub. */
export async function infer(env, outputPath, transport = createTransport()) {
  if (Object.hasOwn(env, 'GITHUB_TOKEN') || !env.GEMINI_API_KEY) fail('CREDENTIAL_ISOLATION');
  const c = storedContext(env.TRANSLATE_CONTEXT),
    token = env.GITHUB_API_TOKEN;
  await verifyRun(c, transport, token);
  const { item, refusal } = await unchanged(c, transport, token);
  if (refusal) return refusal;
  const prepared = prepareTranslation(item, config);
  if (prepared.state !== 'ready') return prepared;
  const body = {
    systemInstruction: { parts: [{ text: TRANSLATION_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: prepared.prompt }] }],
    generationConfig: {
      candidateCount: 1,
      responseMimeType: 'application/json',
      responseJsonSchema: translationSchema(prepared),
      maxOutputTokens: config.maxOutputTokens,
      thinkingConfig: { includeThoughts: false },
    },
  };
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}`,
    options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    };
  const count = await request(
    `${base}:countTokens`,
    {
      ...options,
      body: JSON.stringify({
        generateContentRequest: { model: `models/${config.model}`, ...body },
      }),
      signal: AbortSignal.timeout(config.countTimeoutSeconds * 1000),
    },
    transport,
    [200],
    16384,
  );
  if (!Number.isSafeInteger(count.data?.totalTokens))
    return done('failed', 'TOKEN_COUNT_FAILED', { httpStatus: count.status });
  if (count.data.totalTokens > config.maxInputTokens) return refused('TOO_LARGE');
  // The author may have edited while the count ran: the paid call is for the current text only.
  const again = await unchanged(c, transport, token);
  if (again.refusal) return again.refusal;
  const response = await request(
    `${base}:generateContent`,
    {
      ...options,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.generationTimeoutSeconds * 1000),
    },
    transport,
    [200],
    65536,
  );
  if (response.status !== 200 || !response.data)
    return done('failed', 'GENERATION_FAILED', { httpStatus: response.status });
  let parsed;
  try {
    parsed = JSON.parse(finalText(response.data, config.maxOutputBytes));
  } catch {
    return refused('INVALID_TRANSLATION');
  }
  const checked = validateTranslation(parsed, prepared, config);
  if (checked.state !== 'ready') return checked;
  if (!checked.translation.needsTranslation) return refused('ALREADY_ENGLISH');
  await writeFile(outputPath, JSON.stringify({ context: c, translation: checked.translation }), {
    mode: 0o600,
    flag: 'wx',
  });
  return done('ready', 'INFERRED');
}

async function readArtifact(directory) {
  const stat = await lstat(directory),
    entries = await readdir(directory);
  if (!stat.isDirectory() || entries.length !== 1 || entries[0] !== 'artifact.json')
    fail('ARTIFACT_REFUSED');
  const file = await lstat(`${directory}/artifact.json`);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 32768)
    fail('ARTIFACT_REFUSED');
  return JSON.parse(await readFile(`${directory}/artifact.json`, 'utf8'));
}

/**
 * Writes the translation, and only over the exact text it was made from. GitHub has no conditional
 * write, so an edit landing between the last read and the PATCH is overwritten; it stays in the
 * item's edit history.
 */
export async function publish(env, directory, transport = createTransport()) {
  if (Object.hasOwn(env, 'GEMINI_API_KEY') || !env.GITHUB_TOKEN) fail('CREDENTIAL_ISOLATION');
  if (!config.enabled || !config.publishEnabled) return refused('DISABLED');
  const c = storedContext(env.TRANSLATE_CONTEXT),
    token = env.GITHUB_TOKEN,
    artifact = await readArtifact(directory);
  if (contextKeys.some((key) => artifact.context?.[key] !== c[key])) fail('ARTIFACT_REFUSED');
  await verifyRun(c, transport, token);
  const { item, refusal } = await unchanged(c, transport, token);
  if (refusal) return refusal;
  const prepared = prepareTranslation(item, config);
  if (prepared.state !== 'ready') return prepared;
  const checked = validateTranslation(artifact.translation, prepared, config);
  if (checked.state !== 'ready') return checked;
  const write = planWrite(checked.translation, item);
  if (!write) return refused('NOTHING_TO_WRITE');
  const again = await unchanged(c, transport, token);
  if (again.refusal) return again.refusal;
  let response;
  try {
    response = await request(
      githubURL(itemPath(c)),
      {
        method: 'PATCH',
        headers: { ...headers(token), 'Content-Type': 'application/json' },
        body: JSON.stringify(write),
        signal: AbortSignal.timeout(30000),
      },
      transport,
      [200],
    );
  } catch {
    fail('WRITE_UNCONFIRMED');
  }
  if (!response.data) fail('WRITE_UNCONFIRMED');
  const after = await read(itemPath(c), transport, token);
  if (
    after.title !== (write.title ?? item.title) ||
    (after.body ?? '') !== (write.body ?? item.body ?? '')
  )
    fail('WRITE_UNCONFIRMED');
  return done('ready', 'PUBLISHED');
}

const known = new Set([
  'ARTIFACT_REFUSED',
  'CONTEXT_REFUSED',
  'CREDENTIAL_ISOLATION',
  'GITHUB_READ_FAILED',
  'INVALID_RESPONSE',
  'REQUEST_FAILED',
  'ROUTE_REFUSED',
  'RUN_ORIGIN_REFUSED',
  'WRITE_UNCONFIRMED',
]);
export async function runCLI(argv, env = process.env, transport = createTransport()) {
  const [command, path] = argv;
  try {
    if (command === 'collect' && argv.length === 1) return await collect(env, transport);
    if (command === 'infer' && argv.length === 2) return await infer(env, path, transport);
    if (command === 'publish' && argv.length === 2) return await publish(env, path, transport);
    return done('failed', 'COMMAND_REFUSED');
  } catch (e) {
    return done('failed', known.has(e?.message) ? e.message : 'REQUEST_FAILED');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const decision = await runCLI(process.argv.slice(2));
  const { context, ...shown } = decision;
  process.stdout.write(`${JSON.stringify(shown)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `ready=${decision.state === 'ready'}\n${context ? `context=${JSON.stringify(context)}\n` : ''}`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `Translation: ${decision.reason}\n`);
  if (decision.state === 'failed') process.exitCode = 1;
}
