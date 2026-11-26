---
name: coding
description: Use when asked to read, search, change or run code or files on the machine you work on.
license: Apache-2.0
requires-tools: read_file, list_directory, find_files, search_files, edit_file, write_file, apply_patch, run_script, shell, process_output, stop_process
---

# Coding on a machine

The same tools work the same way on the gateway's own machine and on a connected one. Relative
paths start in your folder there.

## Find and read

- `search_files` finds text by regular expression, `find_files` finds names by glob and
  `list_directory` shows a folder. Start with these; do not read whole trees.
- `read_file` numbers the lines. Pass `offset` and `limit` for a range of a long file, or `paths`
  to read several files in one call. The end of an answer says where to continue.

## Change

- `edit_file` replaces exact text. `old` must appear once; if it does not, the error says how many
  times it appears and where, or shows the closest line. Add surrounding text, or set
  `replace_all`. Give several files in `files` to change them together: if one cannot be edited,
  none is.
- `apply_patch` takes a unified diff for changes in several places or files. It is applied whole or
  not at all, and it does not delete files.
- `write_file` makes a new file or replaces one. For a small change to a file that exists, edit it.
- A file that changed after you read it is refused. Read it again and redo the change.

## Run

- `run_script` runs a script without a file: `language` is `sh`, `python` or `node`. It stops at
  `timeout_ms` (at most 120 000).
- `shell` with `background: true` starts a job that outlives the call and answers with a job id.
  `process_output` shows its status and the end of its output; `stop_process` ends it. Jobs belong
  to the run that started them.
- Long output is cut for you from the start: the end is what you see. Print less, or filter it.
- Check what you changed: run the tests or the build before you say it works.
