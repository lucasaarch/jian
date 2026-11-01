import assert from 'node:assert/strict';
import test from 'node:test';
import {
  eligibility,
  planWrite,
  prepareTranslation,
  translationSchema,
  validateTranslation,
} from './translate-core.mjs';

const limits = { maxPrimaryBytes: 4096, maxInputBytes: 32768, maxOutputBytes: 16384 };
const repositories = ['lucasaarch/jian'];
const repo = {
  full_name: 'lucasaarch/jian',
  private: false,
  visibility: 'public',
  default_branch: 'main',
};
const context = {
  repo: 'lucasaarch/jian',
  kind: 'pull',
  number: 7,
  id: 70,
  event: 'opened',
  ref: 'refs/heads/main',
  defaultBranch: 'main',
  actor: 'person',
};
const pull = {
  number: 7,
  id: 70,
  state: 'open',
  title: 'fix(ui): corrige o botão',
  body: '## Resumo\n\nCorrige #12.',
  user: { login: 'person', type: 'User' },
  base: { ref: 'main' },
};
const reason = (change = {}, item = {}, repoChange = {}, permission) =>
  eligibility(
    { ...context, ...change },
    { ...repo, ...repoChange },
    { ...pull, ...item },
    permission,
    repositories,
  ).reason;

test('only an open item by a person, on the default branch of the public repository, is eligible', () => {
  assert.equal(reason(), 'VALIDATED');
  for (const refused of [
    reason({}, { state: 'closed' }),
    reason({}, { user: { login: 'mia-jian[bot]', type: 'Bot' } }),
    reason({}, { user: { login: 'odd[bot]', type: 'User' } }),
    reason({}, { base: { ref: 'release' } }),
    reason({}, { id: 71 }),
    reason({}, { number: 8 }),
    reason({ actor: 'dependabot[bot]' }),
    reason({ ref: 'refs/heads/other' }),
    reason({}, {}, { private: true, visibility: 'private' }),
    reason({ repo: 'someone/else' }, {}, { full_name: 'someone/else' }),
  ])
    assert.equal(refused, 'NOT_ELIGIBLE');
});

test('an Issue route never serves a pull request as an Issue', () => {
  const issue = { ...pull, base: undefined };
  const check = (item) =>
    eligibility({ ...context, kind: 'issue', event: 'edited' }, repo, item, undefined, repositories)
      .reason;
  assert.equal(check(issue), 'VALIDATED');
  assert.equal(check({ ...issue, pull_request: {} }), 'NOT_ELIGIBLE');
});

test('a manual run needs a verified maintainer, and a live one or an app item an administrator', () => {
  const manual = { event: 'manual', id: undefined },
    dry = { event: 'manualdry', id: undefined },
    app = { user: { login: 'mia-jian[bot]', type: 'Bot' } };
  assert.equal(reason(manual, {}, {}, 'admin'), 'VALIDATED');
  assert.equal(reason(manual, {}, {}, 'maintain'), 'NOT_ELIGIBLE');
  assert.equal(reason(manual, {}, {}, 'write'), 'NOT_ELIGIBLE');
  assert.equal(reason(dry, {}, {}, 'maintain'), 'VALIDATED');
  assert.equal(reason(dry, {}, {}, 'read'), 'NOT_ELIGIBLE');
  assert.equal(reason(manual, app, {}, 'admin'), 'VALIDATED');
  assert.equal(reason(dry, app, {}, 'maintain'), 'NOT_ELIGIBLE');
});

test('sensitive or oversized text never reaches a prompt', () => {
  for (const body of ['password: hunter2', 'Isto é confidencial.', '```\nsem fim'])
    assert.equal(prepareTranslation({ title: 'Falha', body }, limits).reason, 'UNSAFE_SOURCE');
  assert.equal(
    prepareTranslation({ title: 'Falha', body: 'a'.repeat(4097) }, limits).reason,
    'TOO_LARGE',
  );
  assert.equal(
    prepareTranslation({ title: 'Falha', body: 'a'.repeat(100) }, { ...limits, maxInputBytes: 10 })
      .reason,
    'TOO_LARGE',
  );
});

const prepared = (item = pull) => prepareTranslation(item, limits);
const translation = (p, change = {}) => {
  const [title] = p.tokens.title,
    [body] = p.tokens.body;
  return {
    title: `${title.token} fixes the button`,
    body: `## Summary\n\nFixes ${body.token}.`,
    needsTranslation: true,
    ...change,
  };
};

test('what the model returns is refused unless it keeps every token and adds nothing active', () => {
  const p = prepared(),
    good = translation(p);
  assert.equal(validateTranslation(good, p, limits).state, 'ready');
  for (const change of [
    { body: '## Summary\n\nFixes nothing.' },
    { body: `${good.body} ${p.tokens.body[0].token}` },
    { body: `${good.body} See https://example.test/x` },
    { body: `${good.body} [here](x)` },
    { body: `${good.body} Also fixes #99.` },
    { body: `${good.body} <img src=x>` },
    { body: `${good.body} password: hunter2` },
    { body: '' },
    { title: 'fixes the button' },
    { needsTranslation: 'yes' },
    { extra: true },
  ])
    assert.equal(
      validateTranslation({ ...good, ...change }, p, limits).reason,
      'INVALID_TRANSLATION',
      JSON.stringify(change),
    );
  const { needsTranslation: _, ...missing } = good;
  assert.equal(validateTranslation(missing, p, limits).reason, 'INVALID_TRANSLATION');
  assert.equal(validateTranslation(good, p, { maxOutputBytes: 10 }).reason, 'INVALID_TRANSLATION');
});

test('an empty body stays empty and cannot acquire invented text', () => {
  const item = { ...pull, body: null },
    p = prepared(item),
    title = `${p.tokens.title[0].token} fixes the button`;
  assert.deepEqual(translationSchema(p).properties.body.enum, ['']);
  assert.equal(
    validateTranslation({ title, body: 'Invented.', needsTranslation: true }, p, limits).reason,
    'INVALID_TRANSLATION',
  );
  const checked = validateTranslation({ title, body: '', needsTranslation: true }, p, limits);
  assert.deepEqual(planWrite(checked.translation, item), { title: 'fix(ui): fixes the button' });
});

test('English is never rewritten, and only the fields that changed are written', () => {
  const p = prepared();
  assert.equal(planWrite(translation(p, { needsTranslation: false }), pull), null);
  assert.deepEqual(planWrite(translation(p), pull), {
    title: 'fix(ui): fixes the button',
    body: '## Summary\n\nFixes #12.',
  });
  assert.deepEqual(planWrite(translation(p, { title: p.prose.title }), pull), {
    body: '## Summary\n\nFixes #12.',
  });
  assert.equal(planWrite(translation(p, { title: p.prose.title, body: p.prose.body }), pull), null);
});
