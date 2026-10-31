---
name: release-notes
description: Use when writing or editing anything in docs/releases, or cutting a release. Notes must read as written by a person, through the humanizer skill, and keep every upgrade step exact.
---

# Release notes

People running Jian read these inside the app. Tell them what changed for them, in the words you
would use with a friend who runs it too.

## How to write one

1. Write `docs/releases/<version>.md` from what actually changed. Check the commits: invent nothing.
2. Load the `humanizer` skill and run the whole note through it, summary included. A note that has
   not been through it is not finished. Keep every fact while doing so.
3. Compare with your draft: nothing added, no fact, command or number lost.
4. Run `make changelog`. CI fails on a stale `CHANGELOG.md`.

## Shape

```markdown
---
date: 2026-10-30
summary: One line of what this release brings.
---

### A section named by what it touches

* **What changed for you:** One or two sentences.

### Upgrading

* What to do, exactly.
```

- `date` is required. `summary` is one line. The file name is the version.
- Sections: use `###` and `*` bullets. The app draws nothing past headings, bullets, bold, inline
  code, links, fenced code and pictures.

## Keep

Lead with what someone can now do, or what stopped annoying them. Leave out refactors, CI, tests,
file names and how it was built, unless they have to act on it.

## Never change

Upgrade steps, breaking changes, migrations, security fixes, commands, environment variables, paths,
version numbers and URLs stay complete and exact. Keep the heading `### Upgrading` as written: the
gateway links to that anchor in 1.0.0. Do not change a published note's `date`.

## Pictures

Save the print in `docs/releases/media/` and write `![What it shows](media/name.png)`. PNG, JPEG,
WebP and GIF work. The panel reads it from the gateway and opens it full screen on a click. The
release and changelog scripts turn the path into a full address for GitHub.

Use a fictional agent and no real data in a print.

## Releasing

Only when asked: `make release VERSION=1.2.3`. It tags and publishes.
