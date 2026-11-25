//! The command line, as `clap` types: a command, then its typed flags. Parsing and `--help`
//! come from the derive, so the commands the services run (`run`, `computer-helper`) and the
//! ones people type cannot drift from what is documented.

use clap::{Args, CommandFactory as _, Parser, Subcommand};
use clap_complete::Shell;
use jian_remote::log::Level;

use crate::config;

/// Jian Remote: connects this machine to a Jian gateway.
#[derive(Parser)]
#[command(name = "jian-remote", version, about, arg_required_else_help = true)]
pub struct Cli {
    /// What to do.
    #[command(subcommand)]
    pub command: Command,
}

impl Cli {
    /// The grammar, for `completions` and for tests.
    pub fn grammar() -> clap::Command {
        Self::command()
    }
}

/// Every command. `run` and `computer-helper` are what the OS service and the worker start.
#[derive(Subcommand)]
pub enum Command {
    /// Pair, install the service and start it
    Install(InstallArgs),
    /// Change the gateway or token, then restart
    Configure(ConfigureArgs),
    /// Start the service
    Start,
    /// Stop the service
    Stop,
    /// Restart the service
    Restart,
    /// Whether it is connected, and what it has run
    Status {
        /// Print one JSON object, for scripts.
        #[arg(long)]
        json: bool,
    },
    /// The worker's log
    Logs(LogsArgs),
    /// Install a release from GitHub, checked by SHA-256
    Update {
        /// The release to install.
        #[arg(long, value_name = "X.Y.Z", default_value = "latest")]
        version: String,
    },
    /// Remove the service
    Uninstall {
        /// Also remove the config and the log.
        #[arg(long)]
        purge: bool,
    },
    /// The worker in the foreground, as the service runs it
    Run,
    /// Print the version
    Version,
    /// Print a completion script for a shell
    Completions {
        /// The shell to complete for.
        shell: Shell,
    },
    /// The Computer Use helper the worker starts as a child; not for people.
    #[command(hide = true)]
    ComputerHelper {
        /// Passed to the helper untouched, flags included.
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
}

/// How the machine token is given. At most one: `--token` is for the one-liner the panel shows,
/// the others keep the token out of shell history.
// No `Debug`: the token must not end up in a log by accident.
#[derive(Args)]
#[group(multiple = false)]
pub struct TokenArgs {
    /// The token itself
    #[arg(long, value_name = "VALUE")]
    pub token: Option<String>,
    /// Read the token from standard input
    #[arg(long)]
    pub token_stdin: bool,
    /// Ask for the token on the terminal, hidden
    #[arg(long)]
    pub token_prompt: bool,
}

/// `install`.
#[derive(Args)]
pub struct InstallArgs {
    /// The gateway this machine pairs with.
    #[arg(long, env = "JIAN_REMOTE_GATEWAY", value_name = "URL", value_parser = config::parse_gateway)]
    pub gateway: String,
    /// The machine token.
    #[command(flatten)]
    pub token: TokenArgs,
    /// Install a system service (Linux), not a user one.
    #[arg(long)]
    pub system: bool,
}

/// `configure`: whatever is left out stays as it was.
#[derive(Args)]
pub struct ConfigureArgs {
    /// The gateway this machine pairs with.
    #[arg(long, env = "JIAN_REMOTE_GATEWAY", value_name = "URL", value_parser = config::parse_gateway)]
    pub gateway: Option<String>,
    /// The machine token.
    #[command(flatten)]
    pub token: TokenArgs,
}

/// `logs`.
#[derive(Args)]
pub struct LogsArgs {
    /// How many of the last lines to show.
    #[arg(short = 'n', long, default_value_t = 100, value_parser = clap::value_parser!(u64).range(1..))]
    pub lines: u64,
    /// Show this level and above: debug, info, warn or error.
    #[arg(long, default_value = "debug", value_parser = parse_level)]
    pub level: Level,
    /// Keep printing new lines as they are written.
    #[arg(short = 'f', long)]
    pub follow: bool,
}

fn parse_level(name: &str) -> Result<Level, String> {
    Level::parse(name).ok_or_else(|| {
        let names: Vec<&str> = Level::ALL.iter().map(|level| level.name()).collect();
        format!("one of {}", names.join(", "))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Result<Cli, clap::Error> {
        Cli::try_parse_from(std::iter::once("jian-remote").chain(line.split_whitespace()))
    }

    #[test]
    fn the_command_line_is_well_formed() {
        Cli::grammar().debug_assert();
    }

    #[test]
    fn install_takes_a_gateway_and_one_token_source() {
        let Ok(Cli {
            command: Command::Install(install),
        }) = parse("install --system --gateway https://jian.example.com/ --token-stdin")
        else {
            panic!("install did not parse");
        };
        assert_eq!(install.gateway, "https://jian.example.com");
        assert!(install.system && install.token.token_stdin);
        assert!(
            parse("install --gateway https://jian.example.com --token a --token-stdin").is_err()
        );
        assert!(parse("install --gateway http://jian.example.com --token a").is_err());
        assert!(parse("install --token a").is_err());
    }

    #[test]
    fn logs_validates_its_numbers_and_levels() {
        let Ok(Cli {
            command: Command::Logs(logs),
        }) = parse("logs -n 20 --level warn -f")
        else {
            panic!("logs did not parse");
        };
        assert_eq!(
            (logs.lines, logs.level, logs.follow),
            (20, Level::Warn, true)
        );
        assert!(parse("logs -n 0").is_err());
        assert!(parse("logs --level loud").is_err());
    }

    /// What the launchd, systemd and Task Scheduler definitions run, and what the worker runs
    /// for its helper.
    #[test]
    fn what_the_service_and_the_worker_run_parses() {
        assert!(matches!(
            parse("run").map(|cli| cli.command),
            Ok(Command::Run)
        ));
        let Ok(Cli {
            command: Command::ComputerHelper { args },
        }) = parse("computer-helper --flag value")
        else {
            panic!("computer-helper did not parse");
        };
        assert_eq!(args, ["--flag", "value"]);
    }

    #[test]
    fn the_other_commands_parse() {
        assert!(matches!(
            parse("update --version 1.2.3").map(|cli| cli.command),
            Ok(Command::Update { version }) if version == "1.2.3"
        ));
        assert!(matches!(
            parse("uninstall --purge").map(|cli| cli.command),
            Ok(Command::Uninstall { purge: true })
        ));
        assert!(matches!(
            parse("status --json").map(|cli| cli.command),
            Ok(Command::Status { json: true })
        ));
        assert!(matches!(
            parse("completions zsh").map(|cli| cli.command),
            Ok(Command::Completions { shell: Shell::Zsh })
        ));
        assert!(parse("completions tcsh").is_err());
        assert!(parse("frobnicate").is_err());
    }
}
