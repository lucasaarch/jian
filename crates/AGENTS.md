# Rust core

The Rust side of Jian: `crates/` holds libraries, `bins/` the programs that wire them. One
Cargo workspace at the repository root. `apps/` and `packages/` are the Node product and are not
touched from here; `packages/remote-core/native` is a workspace member only to share the lockfile.

The rules are in code, so the tools say when one is broken: lints in `[workspace.lints]`,
formatting in `rustfmt.toml`, tests-may-unwrap in `clippy.toml`, licenses and advisories in
`deny.toml`. `make rust-check` runs them all.

## Boundaries

- A crate talks to another only through its public types and traits. `jian-core` does no IO: no
  files, network, clock, environment or process. It takes what it needs through traits.
- Binaries wire; libraries do not. A `bins/` crate reads the environment and arguments, builds
  each library's typed config struct and passes it in. A library never reads configuration from
  the environment. The one exception is `jian-remote` handing the machine's own environment
  (`PATH`, `DISPLAY`, git variables) on to the commands and tools it runs for the user.
- An id that crosses a crate is a newtype (`TaskId`, `ForwardId`), never a bare `String`. A state
  is an enum, not a bool.

## Errors

- Libraries: one `thiserror` enum per crate, variants carry context. No `Result<_, String>` in a
  public API. A message for a person or the gateway comes from the error's `Display`.
- `anyhow` only in `bins/`, with `.context(..)` at each step.
- No `unwrap`, `expect` or `panic!` outside tests (denied by clippy). Tests may.
  A constant pattern that cannot fail may carry `#[allow(clippy::expect_used, reason = "..")]`.

## Code

- `unsafe_code` is forbidden. `jian-computer-use` alone talks to the OS through FFI and allows
  it; every `unsafe` block there has a `// SAFETY:` comment, enforced by
  `undocumented_unsafe_blocks`. Prefer a safe wrapper (`rustix`) over a new `unsafe`.
- Logs: `tracing`, never `println!` or `eprintln!` in a library. A binary may print: that is the
  user's interface. Never log a secret or a token.
- Modules stay near 400 lines. `foo.rs` beside `foo/`, never `mod.rs`. Names say the domain: no
  `utils` or `helpers`.
- Dependencies: the version is written once, in `[workspace.dependencies]`; a crate says
  `name.workspace = true`. Every crate sets `[lints] workspace = true`.

## Docs and comments

- Every crate opens with `//!`: its role, what it does not do, who it talks to. Every `pub` item
  has `///` (`missing_docs` is denied). `cargo doc` runs with `-D warnings`.
- Comments say why: the rule, the invariant, the unit, the trap. Not what the line does.

## Tests

- Integration tests live in `tests/` and use the public API. No test that mirrors the
  implementation or counts internal calls. Behaviour changes need a test; a refactor keeps the
  ones there.
- Code for macOS and Windows is checked from Linux with
  `cargo check -p jian-computer-use --target aarch64-apple-darwin` (and
  `x86_64-pc-windows-msvc`). Keep changes there small.
