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

use anyhow::Context as _;
use clap::Parser as _;
use clap_complete::generate;

use args::{Cli, Command};

fn main() {
    let cli = Cli::parse();
    // Before any runtime: on macOS and Windows the helper needs the process's main thread.
    if let Command::ComputerHelper { args } = cli.command {
        jian_computer_use::helper_main(args);
        return;
    }
    let code = match dispatch(cli.command) {
        Ok(code) => code,
        Err(error) => {
            let on = output::colour(true);
            eprintln!("{} {error:#}", output::paint("Error:", output::RED, on));
            1
        }
    };
    std::process::exit(code);
}

fn runtime() -> anyhow::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("Could not start the async runtime")
}

/// Runs one command; the number is the process's exit code.
fn dispatch(command: Command) -> anyhow::Result<i32> {
    match command {
        Command::Version => println!("{}", env!("CARGO_PKG_VERSION")),
        Command::Install(install) => commands::install(install)?,
        Command::Configure(configure) => commands::configure(configure)?,
        Command::Start | Command::Restart => commands::start()?,
        Command::Stop => commands::stop()?,
        Command::Uninstall { purge } => commands::uninstall(purge)?,
        Command::Run => run::run()?,
        Command::Status { json } => return runtime()?.block_on(status::status(json)),
        Command::Logs(logs) => {
            let count = usize::try_from(logs.lines).unwrap_or(usize::MAX);
            logs::logs(count, logs.level, logs.follow)?;
        }
        Command::Update { version } => runtime()?.block_on(commands::update(&version))?,
        Command::Completions { shell } => {
            generate(
                shell,
                &mut Cli::grammar(),
                "jian-remote",
                &mut std::io::stdout(),
            );
        }
        // Handled in `main`, before any runtime exists.
        Command::ComputerHelper { .. } => {}
    }
    Ok(0)
}
