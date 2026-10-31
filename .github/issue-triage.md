# Public Issue triage

The workflow and runner are adapted from `cubeshipd/cubeship`, with the repository,
branch, technical-content tokens and comment markers scoped to `lucasaarch/jian`.
Both `enabled` and `publishEnabled` are true. The existing `GEMINI_API_KEY` secret
is used only by the inference step.

## Triggers and retries

Newly opened public, human-authored Issues enter automatic triage. PRs, edits,
comments, private repositories, other branches and untrusted contexts are refused.
Bot-authored Issues and bot senders are skipped at the job gate rather than starting a doomed collection. The runner independently refuses bot contexts. Manual dispatch defaults to `dry_run=true`,
verifies maintain/admin permission, and performs no Google request or publication.
An administrator may set `dry_run=false` to triage an open Issue whose earlier
attempt failed or succeeded with inference skipped. Explicit administrator dispatch
also admits bot-authored Issues and backfills Issues with no remaining original run; automatic triggers and non-admin dispatch still exclude them. Retry history, source identity and generation
limits are checked again; ambiguous history fails closed. Re-running an old
Actions attempt is not a retry mechanism. Historical reruns are read attempt by
attempt so a later skipped attempt cannot hide an earlier generation.

## Repository metadata

The configured Task, Bug and Feature IDs were read from the Jian repository's
Issue type catalog. Personal repositories omit native Issue types from their Issue
responses, so `nativeTypes` is false: type suggestions remain classification context
and only existing labels are written. Missing type metadata is accepted only when
this explicit capability is disabled. Only configured labels that actually exist are proposed:
`bug`, `enhancement`, `documentation`, `question` and `accessibility`.
Human classifications are preserved. Duplicate links are suggestions, never
automatic closure.

This is a personal repository. Its native Issue field endpoint returns 404, so
`priority` is explicitly null. The model must return null for priority and the
writer makes no Issue field request. Organization repositories can configure a
verified native Priority catalog; this path remains covered by synthetic tests.
An unexpected failure reading any configured catalog still blocks publication.

## Validation and preservation

Gemini receives sanitized public prose and at most ten same-repository duplicate
candidates. Code, commands, links and other technical content are protected with
opaque `JIAN_KEEP` tokens and restored locally. Each token must appear exactly
once. Existing dotted terms, including product domains, can survive translation;
invented dotted terms cannot. Scheme detection uses a word boundary so an ordinary
word such as `profile:` does not become a false link rejection.

The model returns a closed JSON schema. The trusted runner attaches the snapshot
rather than asking the model to reproduce repository identity. A fingerprint of
the original title and body binds collection, inference and publication. Every
write is preceded by fresh source checks and followed by read-back verification.
The `jian-issue-triage` comment marker prevents duplicate publication. Existing
human metadata and protected technical content are preserved.

The collector reads only, inference has no Issue write credential, and the writer
has no Gemini credential. Downloads are bound to the workflow SHA and verified
with pinned SHA256 hashes in both collection and inference. Update all workflow
hashes after formatting or changing a trusted script or its configuration.

## Limits and proof

The configured model is `gemini-3.5-flash-lite`, without tools or exposed thoughts.
Input, output, network time, retries and generation budgets remain bounded.
Only sanitized public content is used in bounded diagnostics; credentials are
redacted. Full original input is checked before any safe candidate excerpts.

`pnpm test:triage` runs the offline core, runner and actual workflow-shell tests.
It is part of `pnpm check`, including hash-drift validation. Tests cover native
organization metadata and complete publication for personal repositories without
native fields. They use synthetic credentials and do not call Google or write to
GitHub. A successful live Actions run is separate evidence from offline checks.
