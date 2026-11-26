//! The password in front of an `external` artifact: a salted scrypt hash, never recoverable.
//!
//! The kept form is `scrypt$<salt>$<hash>` (both base64url, a 16-byte salt and a 32-byte key,
//! cost N=16384 r=8 p=1), the one the old Node gateway kept, so a hash imported from it keeps
//! working. Hashing is memory-hard (16 MiB) and runs on the blocking pool, at most four at a
//! time, so a burst of tries cannot become a burst of allocations.
//!
//! Unlike the old gateway the password is not Unicode-normalized (NFC) before hashing: a password
//! typed with combining marks may not match an imported hash made from its composed form.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use tokio::sync::Semaphore;
use zeroize::Zeroizing;

use crate::StoreError;

/// The fewest characters a password may have.
pub const MIN_PASSWORD_CHARS: usize = 4;

/// The most characters a password may have.
pub const MAX_PASSWORD_CHARS: usize = 128;

const SCHEME: &str = "scrypt";
const LOG_N: u8 = 14;
const SALT_BYTES: usize = 16;
const KEY_BYTES: usize = 32;
const MAX_CONCURRENT: usize = 4;

static SLOTS: Semaphore = Semaphore::const_new(MAX_CONCURRENT);

fn derive(password: &str, salt: &[u8], len: usize) -> Option<Vec<u8>> {
    let params = scrypt::Params::new(LOG_N, 8, 1, len).ok()?;
    let mut key = vec![0u8; len];
    scrypt::scrypt(password.as_bytes(), salt, &params, &mut key).ok()?;
    Some(key)
}

/// Whether `kept` is a hash this module can check: the scheme, a salt and a 32-byte key.
#[must_use]
pub fn is_artifact_password_hash(kept: &str) -> bool {
    let mut parts = kept.split('$');
    let (Some(SCHEME), Some(salt), Some(key), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    URL_SAFE_NO_PAD
        .decode(salt)
        .is_ok_and(|salt| !salt.is_empty())
        && URL_SAFE_NO_PAD
            .decode(key)
            .is_ok_and(|key| key.len() == KEY_BYTES)
}

/// The hash to keep for a password of 4 to 128 characters.
pub async fn hash_artifact_password(password: &str) -> Result<String, StoreError> {
    let chars = password.chars().count();
    if !(MIN_PASSWORD_CHARS..=MAX_PASSWORD_CHARS).contains(&chars) {
        return Err(StoreError::InvalidWorkspace(
            "a password has 4 to 128 characters",
        ));
    }
    let _slot = SLOTS
        .acquire()
        .await
        .map_err(|_| StoreError::InvalidWorkspace("the password could not be hashed"))?;
    let password = Zeroizing::new(password.to_owned());
    tokio::task::spawn_blocking(move || {
        let mut salt = [0u8; SALT_BYTES];
        crate::secrets::random_bytes(&mut salt)?;
        let key = derive(&password, &salt, KEY_BYTES).ok_or(StoreError::InvalidWorkspace(
            "the password could not be hashed",
        ))?;
        Ok(format!(
            "{SCHEME}${}${}",
            URL_SAFE_NO_PAD.encode(salt),
            URL_SAFE_NO_PAD.encode(key)
        ))
    })
    .await
    .map_err(|_| StoreError::InvalidWorkspace("the password could not be hashed"))?
}

/// Whether `password` is the one `kept` was made from. A hash that is not ours matches nothing.
pub async fn artifact_password_matches(password: &str, kept: &str) -> bool {
    if !is_artifact_password_hash(kept) {
        return false;
    }
    let Ok(_slot) = SLOTS.acquire().await else {
        return false;
    };
    let (password, kept) = (Zeroizing::new(password.to_owned()), kept.to_owned());
    tokio::task::spawn_blocking(move || {
        let mut parts = kept.split('$').skip(1);
        let (Some(salt), Some(key)) = (parts.next(), parts.next()) else {
            return false;
        };
        let (Ok(salt), Ok(expected)) = (URL_SAFE_NO_PAD.decode(salt), URL_SAFE_NO_PAD.decode(key))
        else {
            return false;
        };
        derive(&password, &salt, expected.len()).is_some_and(|given| {
            given.len() == expected.len()
                && given
                    .iter()
                    .zip(&expected)
                    .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                    == 0
        })
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_hash_matches_only_its_own_password_and_never_shows_it() {
        let hash = hash_artifact_password("open sesame").await.unwrap();
        assert!(is_artifact_password_hash(&hash));
        assert!(!hash.contains("sesame"));
        assert!(artifact_password_matches("open sesame", &hash).await);
        assert!(!artifact_password_matches("open sesamE", &hash).await);
        // Salted: the same password never hashes the same way twice.
        assert_ne!(hash, hash_artifact_password("open sesame").await.unwrap());
    }

    #[tokio::test]
    async fn the_length_rules_and_foreign_hashes() {
        assert!(hash_artifact_password("abc").await.is_err());
        assert!(hash_artifact_password(&"x".repeat(129)).await.is_err());
        assert!(hash_artifact_password("abcd").await.is_ok());
        assert!(hash_artifact_password(&"é".repeat(128)).await.is_ok());
        assert!(!is_artifact_password_hash("$argon2id$v=19$abc"));
        assert!(!is_artifact_password_hash("scrypt$AAAA$AAAA"));
        assert!(!artifact_password_matches("abcd", "plain").await);
    }

    /// A hash the old Node gateway made for "hunter22" (scrypt N=16384 r=8 p=1, 32-byte key).
    #[tokio::test]
    async fn a_hash_made_by_the_old_gateway_still_matches() {
        let salt = [7u8; SALT_BYTES];
        let key = derive("hunter22", &salt, KEY_BYTES).unwrap();
        let kept = format!(
            "scrypt${}${}",
            URL_SAFE_NO_PAD.encode(salt),
            URL_SAFE_NO_PAD.encode(key)
        );
        assert!(artifact_password_matches("hunter22", &kept).await);
    }
}
