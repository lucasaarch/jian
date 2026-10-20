# Jian GitHub automation workflows

These workflows adapt the complete Issue Triage, Assign PR and PR Size Label automation from the read-only `cubeshipd/cubeship` reference. Issue Triage is implemented by `workflows/issue-triage.yml` and the pinned-hash, tested scripts in `scripts/issue-core.mjs`, `issue-run.mjs`, and `issue-config.json`.

## Required repository setting

Set the repository Actions secret `GEMINI_API_KEY` in **Settings → Secrets and variables → Actions**. The key is used only by the conditional `Generate Gemini proposal` step, after collection and inference gates pass. It is not passed to collection/publication, logs, artifacts or untrusted Issue content as a credential. The workflow cannot create repository secrets; a repository administrator must add this secret before live triage can generate proposals. Until then, inference fails safely without applying AI-derived updates.

Enable Actions and allow the workflow's `GITHUB_TOKEN` permissions. The workflow requests only its job-scoped permissions: collector read access; Gemini inference no repository permissions; publisher `issues: write` plus read access needed for trusted provenance. Assign PR and PR Size Label use their own narrowly-scoped write permissions and never check out or execute pull-request code.

## Issue Triage

Only a newly opened Issue in the public `lucasaarch/jian` repository on its default branch is eligible. A maintainer may run `workflow_dispatch` with `dry_run=true` to validate an open Issue; dry run performs no Gemini request or GitHub writes. Reruns, private repositories, bot authors, closed Issues, PRs and untrusted contexts fail closed. Repository-wide concurrency and bounded history/quota admission serialize publication. The workflow collects verified public Issue data, generates a constrained Gemini proposal in an isolated permissionless job, then refetches and validates source before any additive effect.

The model can suggest up to three allowlisted labels (`bug`, `enhancement`, `documentation`, `question`, `accessibility`, `dependencies`, and relevant `area: ...` labels), an Issue type, a priority and possible same-repository duplicates. Jian is a personal repository; GitHub's native Issue Types and custom Issue Fields APIs are unavailable here. Therefore type and priority are represented as labels (`type: task|bug|feature` and `priority: urgent|high|medium|low`), rather than copying Cubeship's organization-specific field IDs. A human's existing type/priority labels are preserved; legacy priority labels block inferred priority. Missing selected labels are created only by the publisher, and labels are added without replacing existing ones. Translation and a bot comment occur only when translation or verified duplicate suggestions add information. Issues are never closed, assigned, or deleted by triage.

Issue prose is untrusted data, never instructions. The workflow bounds and sanitizes input, detects common credentials/private markers, preserves complete technical/code/log blocks through opaque tokens, restricts duplicates to verified candidates, validates a closed JSON schema, caps output and provider requests, never follows model-provided URLs, and does not upload raw source/prompts/responses. The publisher rechecks content and candidate identity, preserves human metadata, verifies each write and avoids blind mutation retries. Labels, translations and comments are not atomic; an uncertain write is reported rather than retried blindly.

## Assign PR and PR Size Label

`assign-pr.yml` assigns `lucasaarch` on PR open/reopen. `pr-size-label.yml` runs for PRs targeting `main`, computes changed lines, creates the required size label if absent, applies exactly one `size: XS/S/M/L/XL` label and removes stale size labels. Both use `pull_request_target` without checkout, execute no PR-supplied code, and pass event values through environment variables rather than interpolating them into shell source.

## Validation

Run the offline regression suite with:

```sh
node --test .github/scripts/*.test.mjs
```

The tests cover core proposal validation/effects and workflow gates, source pin verification, transport boundaries and synthetic GitHub/Gemini responses. The repository's usual `pnpm run check` validates the Jian application separately. Offline tests cannot confirm that the Actions secret or live GitHub/Gemini service access is configured; first activation should be observed in Actions.
