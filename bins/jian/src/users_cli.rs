//! `jian users`: the install's people, from the command line. It is how the first admin is made,
//! since the gateway has no sign-up, and how someone locked out gets back in.
//!
//! The command opens the database itself, as `jian jobs` does: with the embedded Postgres, stop
//! the gateway first; with `DATABASE_URL` it runs beside it. A password is never an argument (it
//! would be in the process list and the shell history): `--password-stdin` reads one line.

use std::io::BufRead as _;

use anyhow::Context as _;
use clap::{ArgGroup, Args, Subcommand};
use jian_store::{Database, NewUser, Role, TenantCtx, TenantId, normalize_email};

/// How long an invitation made here works: the same as the gateway's default.
const INVITE_DAYS: u64 = 7;

#[derive(Subcommand)]
pub enum UsersAction {
    /// Add a user. The first one of an install must be an admin (`--admin`), and keeps the
    /// password given here; later ones must replace theirs at their first sign-in.
    Add(AddArgs),
    /// List the users, their roles and whether they are disabled.
    List,
    /// Stop a user signing in and end their sessions.
    Disable {
        /// The address of the user.
        #[arg(long)]
        email: String,
    },
    /// Give a user a new password, which they must replace at their next sign-in. Their sessions
    /// end.
    ResetPassword {
        /// The address of the user.
        #[arg(long)]
        email: String,
        /// Read the password from the first line of standard input.
        #[arg(long, required = true)]
        password_stdin: bool,
    },
}

#[derive(Args)]
#[command(group(ArgGroup::new("how").required(true).args(["password_stdin", "invite"])))]
pub struct AddArgs {
    /// The address they sign in with.
    #[arg(long)]
    email: String,
    /// What they are called. Defaults to the part of the address before the `@`.
    #[arg(long)]
    name: Option<String>,
    /// Make them an admin: they manage the install's users.
    #[arg(long)]
    admin: bool,
    /// Read their password from the first line of standard input.
    #[arg(long)]
    password_stdin: bool,
    /// Make an invitation instead: print a token, shown once, that they use to choose their own
    /// password at `POST /v1/auth/invite/accept`.
    #[arg(long)]
    invite: bool,
}

/// One line of standard input, without its line ending: `\n`, and the `\r` a Windows terminal or
/// a `type` pipe adds. Nothing else is trimmed, because spaces can be part of a password.
fn first_line(mut text: String) -> String {
    while text.ends_with(['\n', '\r']) {
        text.pop();
    }
    text
}

fn read_password() -> anyhow::Result<String> {
    let mut line = String::new();
    let read = std::io::stdin()
        .lock()
        .read_line(&mut line)
        .context("cannot read the password from standard input")?;
    anyhow::ensure!(read > 0, "no password on standard input");
    Ok(first_line(line))
}

pub async fn run(database: &Database, action: UsersAction) -> anyhow::Result<()> {
    let ctx = database
        .tenant(TenantId::self_hosted())
        .await
        .context("cannot open the tenant; has the gateway run once on this database?")?;
    match action {
        UsersAction::Add(args) => add(database, &ctx, args).await,
        UsersAction::List => list(database, &ctx).await,
        UsersAction::Disable { email } => {
            let user = database
                .user_by_email(&ctx, &email)
                .await?
                .with_context(|| format!("no user with the address {email}"))?;
            database.disable_user(&ctx, &user.id).await?;
            println!("disabled {}; their sessions ended", user.email);
            Ok(())
        }
        UsersAction::ResetPassword { email, .. } => {
            let user = database
                .user_by_email(&ctx, &email)
                .await?
                .with_context(|| format!("no user with the address {email}"))?;
            let password = read_password()?;
            database
                .reset_user_password(&ctx, &user.id, &password)
                .await
                .context("cannot set that password")?;
            println!(
                "password of {} reset; they must replace it at their next sign-in",
                user.email
            );
            Ok(())
        }
    }
}

async fn add(database: &Database, ctx: &TenantCtx, args: AddArgs) -> anyhow::Result<()> {
    let email = normalize_email(&args.email).context("that is not an email address")?;
    let name = args
        .name
        .unwrap_or_else(|| email.split('@').next().unwrap_or_default().to_owned());
    let role = if args.admin {
        Role::Admin
    } else {
        Role::Member
    };
    if args.invite {
        let ttl = std::time::Duration::from_secs(INVITE_DAYS * 24 * 3600);
        let invite = database
            .invite_user(ctx, &email, &name, role, ttl)
            .await
            .context("cannot invite that user")?;
        println!("invited {} ({})", invite.user.email, role.as_str());
        println!("invitation token (shown once): {}", invite.token.expose());
        println!("it works once, until {}", invite.expires_at);
        return Ok(());
    }
    let password = read_password()?;
    let first = database.list_users(ctx, None, 1).await?.items.is_empty();
    let user = if first {
        anyhow::ensure!(
            args.admin,
            "the first user of an install must be an admin: add --admin"
        );
        database
            .create_first_admin(ctx, &email, &name, Some(&password))
            .await
    } else {
        database
            .add_user(
                ctx,
                NewUser {
                    email: &email,
                    name: &name,
                    role,
                    password: Some(&password),
                    must_change_password: true,
                },
            )
            .await
    }
    .context("cannot add that user")?;
    println!(
        "added {} ({}){}",
        user.email,
        user.role.as_str(),
        if user.must_change_password {
            "; they must replace the password at their first sign-in"
        } else {
            ""
        }
    );
    Ok(())
}

async fn list(database: &Database, ctx: &TenantCtx) -> anyhow::Result<()> {
    let mut after = None;
    loop {
        let page = database.list_users(ctx, after, 100).await?;
        for user in &page.items {
            let state = if user.disabled {
                "disabled"
            } else if !user.has_password {
                "invited"
            } else {
                "active"
            };
            println!("{}\t{}\t{state}", user.email, user.role.as_str());
        }
        match page.next {
            Some(next) => after = Some(next),
            None => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_password_line_loses_its_line_ending_and_nothing_else() {
        assert_eq!(first_line("secret words \n".into()), "secret words ");
        // What a Windows shell sends.
        assert_eq!(first_line("secret words\r\n".into()), "secret words");
        assert_eq!(first_line("no ending".into()), "no ending");
    }

    #[test]
    fn add_needs_a_password_or_an_invitation_and_not_both() {
        use clap::Parser;

        #[derive(Parser)]
        struct Wrap {
            #[command(subcommand)]
            action: UsersAction,
        }
        let parse = |args: &[&str]| {
            Wrap::try_parse_from(["users", "add", "--email", "a@b.test"].iter().chain(args))
        };
        assert!(parse(&[]).is_err());
        assert!(parse(&["--password-stdin"]).is_ok());
        assert!(parse(&["--invite", "--admin"]).is_ok());
        assert!(parse(&["--invite", "--password-stdin"]).is_err());
    }
}
