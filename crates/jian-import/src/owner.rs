//! The owner: the person who ran the old install becomes the new tenant's first admin.
//!
//! The old Jian has no users: one owner token opened everything, so nothing in its database
//! names the owner. The address comes from whoever runs the import. The account is made with no
//! password, and the person gets in the way any admin does (`jian users reset-password`, which
//! sets a provisional password they must replace at their first sign-in); an import never makes
//! up a password.

use jian_store::{Database, ImportResult, NewMember, Role, StoreError, TenantCtx};

use crate::outcome::{Tally, skipped};

pub(crate) async fn import(
    db: &Database,
    ctx: &TenantCtx,
    email: Option<&str>,
) -> Result<ImportResult, StoreError> {
    let Some(email) = email.map(str::trim).filter(|email| !email.is_empty()) else {
        return Ok(skipped(
            "the old Jian keeps no e-mail for its owner; give one with --import-owner-email \
             (JIAN_IMPORT_OWNER_EMAIL) to make them the first admin",
        ));
    };
    let mut tally = Tally::default();
    let first = db
        .add_first_admin(
            ctx,
            NewMember {
                email,
                name: None,
                role: Role::Admin,
                invited_by: None,
                password_hash: None,
                must_change: false,
            },
        )
        .await;
    match first {
        Ok(_) => {
            tally.imported();
            Ok(tally.finish(None))
        }
        // Someone is already a member: a first admin cannot be made twice, which is what makes
        // the run safe to repeat. Whether it was this very address is told, not guessed.
        Err(StoreError::TenantHasMembers) => {
            if db.member_by_email(ctx, email).await?.is_some() {
                tally.already_there();
                Ok(tally.finish(None))
            } else {
                Ok(tally.finish(Some(
                    "the workspace already has members, so the owner was not added; add them \
                     with `jian users add`",
                )))
            }
        }
        Err(error @ StoreError::InvalidEmail) => {
            tally.failed(format!("the owner's address: {error}"));
            Ok(tally.finish(None))
        }
        Err(error) => Err(error),
    }
}
