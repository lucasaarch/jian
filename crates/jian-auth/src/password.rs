//! Passwords: argon2id hashes in PHC strings, and the rules a password must meet.
//!
//! The hash is the only form of a password the database holds. Hashing is memory-hard on purpose
//! (about 19 MiB and some tens of milliseconds at the defaults), so it runs on the blocking pool,
//! never on an async worker, and at most four at a time: without that cap a burst of logins is a
//! burst of 19 MiB allocations.

use std::sync::Arc;

use argon2::password_hash::{PasswordHash, PasswordHasher as _, PasswordVerifier as _, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use tokio::sync::Semaphore;
use zeroize::Zeroizing;

use crate::AuthError;

/// The shortest password taken, in characters.
pub const MIN_PASSWORD_CHARS: usize = 12;

/// The longest password taken, in bytes. Hashing time does not grow with the input beyond the
/// first block, but the request does: this keeps a login from being a way to push megabytes
/// through the hasher.
pub const MAX_PASSWORD_BYTES: usize = 256;

/// How many hashes run at once. Each holds [`PasswordParams::memory_kib`] for its whole run.
const MAX_CONCURRENT_HASHES: usize = 4;

/// Bytes of salt. 128 bits, as the PHC format's reference does.
const SALT_BYTES: usize = 16;

/// What a login that finds nothing to check hashes, so that it costs what a wrong password
/// costs. The text is not a password of anyone.
const DUMMY_PASSWORD: &str = "no such account: this only costs time";

/// The argon2id cost. [`Default`] is the OWASP minimum for argon2id: 19 MiB, 2 passes, 1 lane.
/// A hash already stored keeps the cost it was made with (it is in the PHC string), so raising
/// this affects new passwords only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PasswordParams {
    /// Memory in KiB.
    pub memory_kib: u32,
    /// Passes over the memory.
    pub iterations: u32,
    /// Lanes.
    pub parallelism: u32,
}

impl Default for PasswordParams {
    fn default() -> Self {
        Self {
            memory_kib: 19 * 1024,
            iterations: 2,
            parallelism: 1,
        }
    }
}

impl PasswordParams {
    /// The cheapest cost argon2 accepts. **For tests only**: hashes made with it are trivial to
    /// guess, and a test with hundreds of logins would otherwise spend its time hashing. A
    /// binary never calls this.
    pub const fn insecure_for_tests() -> Self {
        Self {
            memory_kib: 8,
            iterations: 1,
            parallelism: 1,
        }
    }

    fn argon2(self) -> Result<Argon2<'static>, AuthError> {
        let params = Params::new(self.memory_kib, self.iterations, self.parallelism, None)
            .map_err(|_| AuthError::PasswordHashing)?;
        Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
    }
}

/// Whether a password may be set: 12 characters at least, 256 bytes at most.
pub fn check_password(password: &str) -> Result<(), AuthError> {
    if password.chars().count() >= MIN_PASSWORD_CHARS && password.len() <= MAX_PASSWORD_BYTES {
        Ok(())
    } else {
        Err(AuthError::InvalidPassword {
            min_chars: MIN_PASSWORD_CHARS,
            max_bytes: MAX_PASSWORD_BYTES,
        })
    }
}

fn hash_blocking(params: PasswordParams, password: &str) -> Result<String, AuthError> {
    let mut salt = [0u8; SALT_BYTES];
    getrandom::fill(&mut salt).map_err(|_| AuthError::PasswordHashing)?;
    let salt = SaltString::encode_b64(&salt).map_err(|_| AuthError::PasswordHashing)?;
    params
        .argon2()?
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| AuthError::PasswordHashing)
}

fn verify_blocking(password: &str, hash: &str) -> bool {
    // The cost to check is the one written in the hash, not the current setting.
    PasswordHash::new(hash).is_ok_and(|hash| {
        Argon2::default()
            .verify_password(password.as_bytes(), &hash)
            .is_ok()
    })
}

/// Makes and checks password hashes at one cost, with a cap on how many run at once.
#[derive(Clone, Debug)]
pub struct PasswordHasher {
    params: PasswordParams,
    slots: Arc<Semaphore>,
}

impl PasswordHasher {
    /// A hasher that makes new hashes at this cost.
    pub fn new(params: PasswordParams) -> Self {
        Self {
            params,
            slots: Arc::new(Semaphore::new(MAX_CONCURRENT_HASHES)),
        }
    }

    /// The hash of a password that [`check_password`] accepted.
    pub async fn hash(&self, password: &str) -> Result<String, AuthError> {
        let _slot = self
            .slots
            .acquire()
            .await
            .map_err(|_| AuthError::PasswordHashing)?;
        let (params, password) = (self.params, Zeroizing::new(password.to_owned()));
        tokio::task::spawn_blocking(move || hash_blocking(params, &password))
            .await
            .map_err(|_| AuthError::PasswordHashing)?
    }

    /// Whether `password` matches `hash`. A hash that is not a PHC string does not match.
    pub async fn verify(&self, password: &str, hash: &str) -> bool {
        let Ok(_slot) = self.slots.acquire().await else {
            return false;
        };
        let (password, hash) = (Zeroizing::new(password.to_owned()), hash.to_owned());
        tokio::task::spawn_blocking(move || verify_blocking(&password, &hash))
            .await
            .unwrap_or(false)
    }

    /// Spends what a wrong password costs, for a sign-in that has nobody to check against.
    pub async fn spend(&self) {
        let _ = self.hash(DUMMY_PASSWORD).await;
    }
}
