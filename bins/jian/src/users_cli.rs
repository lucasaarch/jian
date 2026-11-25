//! `jian users`: the install's people, from the command line. It is how the first admin is made,
//! since the gateway has no sign-up, and how someone locked out gets back in.
//!
//! The command opens the database itself, as `jian jobs` does: with the embedded Postgres, stop
//! the gateway first; with `DATABASE_URL` it runs beside it. A password is never an argument (it
//! would be in the process list and the shell history): `--password-stdin` reads one line.
//!
//! It acts on the install's one workspace. A person is an account that belongs to it as a member;
//! adding an address that already has an account (made elsewhere, in the Cloud's import) only
//! makes it a member, and its own password is not touched.

use std::io::BufRead as _;

use anyhow::Context as _;
use clap::{ArgGroup, Args, Subcommand};
use jian_auth::{AddMember, Auth, AuthError, Role};
use jian_store::{Database, StoreError, TenantCtx, TenantId};

#[derive(Subcommand)]
pub enum UsersAction {
    /// Add a person. The first one of an install must be an admin (`--admin`), and keeps the
    /// password given here; later ones must replace theirs at their first sign-in.
    Add(AddArgs),
    /// List the members, their roles and whether they are disabled.
    List,
    /// Stop a member using the install and end their sessions here.
    Disable {
        /// The address of the member.
        #[arg(long)]
        email: String,
    },
    /// Give a member a new password, which they must replace at their next sign-in. Their
    /// sessions end. Refused for an account that belongs to another workspace too.
    ResetPassword {
        /// The address of the member.
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
    /// What a new account is called. Defaults to the part of the address before the `@`.
    #[arg(long)]
    name: Option<String>,
    /// Make them an admin: they manage the install's members.
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

pub async fn run(database: &Database, auth: &Auth, action: UsersAction) -> anyhow::Result<()> {
    let ctx = database
        .tenant(TenantId::self_hosted())
        .await
        .context("cannot open the tenant; has the gateway run once on this database?")?;
    match action {
        UsersAction::Add(args) => add(database, auth, &ctx, args).await,
        UsersAction::List => list(database, &ctx).await,
        UsersAction::Disable { email } => {
            let member = database
                .member_by_email(&ctx, &email)
                .await?
                .with_context(|| format!("no member with the address {email}"))?;
            database.disable_member(&ctx, &member.account_id).await?;
            println!("disabled {}; their sessions here ended", member.email);
            Ok(())
        }
        UsersAction::ResetPassword { email, .. } => {
            let member = database
                .member_by_email(&ctx, &email)
                .await?
                .with_context(|| format!("no member with the address {email}"))?;
            let password = read_password()?;
            auth.reset_password(database, &ctx, &member.account_id, &password)
                .await
                .map_err(describe)?;
            println!(
                "password of {} reset; they must replace it at their next sign-in",
                member.email
            );
            Ok(())
        }
    }
}

/// A refusal in words for the person at the terminal.
fn describe(error: AuthError) -> anyhow::Error {
    match error {
        AuthError::Store(StoreError::AccountInOtherTenants) => anyhow::anyhow!(
            "that person belongs to another workspace too: their password is theirs to change"
        ),
        AuthError::Store(StoreError::MemberExists) => {
            anyhow::anyhow!("that person is already a member")
        }
        other => anyhow::Error::new(other),
    }
}

async fn add(
    database: &Database,
    auth: &Auth,
    ctx: &TenantCtx,
    args: AddArgs,
) -> anyhow::Result<()> {
    let role = if args.admin {
        Role::Admin
    } else {
        Role::Member
    };
    let first = database.list_members(ctx, None, 1).await?.items.is_empty();
    anyhow::ensure!(
        !first || args.admin,
        "the first member of an install must be an admin: add --admin"
    );
    if args.invite {
        let issued = auth
            .invite(database, ctx, &args.email, role, None)
            .await
            .map_err(describe)?;
        println!("invited {} ({})", issued.invite.email, role.as_str());
        println!("invitation token (shown once): {}", issued.token.expose());
        println!("it works once, until {}", issued.invite.expires_at);
        return Ok(());
    }
    let password = read_password()?;
    let member = if first {
        auth.add_first_admin(database, ctx, &args.email, args.name.as_deref(), &password)
            .await
            .map_err(describe)?
    } else {
        auth.add_member(
            database,
            ctx,
            AddMember {
                email: &args.email,
                name: args.name.as_deref(),
                role,
                password: &password,
                invited_by: None,
            },
        )
        .await
        .map_err(describe)?
        .member
    };
    println!(
        "added {} ({}){}",
        member.email,
        member.role.as_str(),
        if member.must_change_password {
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
        let page = database.list_members(ctx, after, 100).await?;
        for member in &page.items {
            let state = if member.disabled {
                "disabled"
            } else if !member.has_password {
                "no password"
            } else {
                "active"
            };
            println!("{}\t{}\t{state}", member.email, member.role.as_str());
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
