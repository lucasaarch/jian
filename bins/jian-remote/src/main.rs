//! `jian-remote`: pairs this machine with a Jian gateway, keeps the worker running as a service,
//! and is the worker itself (`run`) and its Computer Use helper (`computer-helper`).

// This is a command-line program: what it prints is its output, for the person at the terminal.
#![allow(clippy::print_stdout, clippy::print_stderr)]

mod args;
mod commands;
mod config;
mod lock;
mod logs;
mod output;
mod paths;
mod run;
mod service;
mod status;

use args::Args;

const HELP: &str = "Jian Remote: connects this machine to a Jian gateway.

Usage: jian-remote <command> [options]

  install --gateway URL (--token-prompt | --token-stdin | --token T) [--system]
                      Pair, install the service and start it
  configure [--gateway URL] [--token-…]
                      Change the gateway or token, then restart
  start | stop | restart
                      Control the service
  status [--json]     Whether it is connected, and what it has run
  logs [-n N] [--level debug|info|warn|error] [-f]
                      The worker's log
  update [--version X.Y.Z]
                      Install a release from GitHub, checked by SHA-256
  uninstall [--purge] Remove the service (and with --purge the config and log)
  run                 The worker in the foreground, as the service runs it
  version             Print the version";

fn main() {
    let args = Args::parse(std::env::args().skip(1).collect());
    // Before any runtime: on macOS and Windows the helper needs the process's main thread.
    if args.command.as_deref() == Some("computer-helper") {
        jian_computer_use::helper_main(args.rest());
        return;
    }
    let code = match dispatch(&args) {
        Ok(code) => code,
        Err(error) => {
            let on = output::colour(true);
            eprintln!("{} {error}", output::paint("Error:", output::RED, on));
            1
        }
    };
    std::process::exit(code);
}

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())
}

fn dispatch(args: &Args) -> Result<i32, String> {
    match args.command.as_deref() {
        Some("version") => println!("{}", env!("CARGO_PKG_VERSION")),
        Some("install") => commands::install(args)?,
        Some("configure") => commands::configure(args)?,
        Some("start" | "restart") => commands::start()?,
        Some("stop") => commands::stop()?,
        Some("uninstall") => commands::uninstall(args)?,
        Some("run") => run::run()?,
        Some("status") => return runtime()?.block_on(status::status(args)),
        Some("logs") => logs::logs(args)?,
        Some("update") => runtime()?.block_on(commands::update(args))?,
        None | Some("help") => println!("{HELP}"),
        Some(other) => return Err(format!("Unknown command {other:?}.\n\n{HELP}")),
    }
    Ok(0)
}
