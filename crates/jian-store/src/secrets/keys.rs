//! The master key (KEK) behind a trait, and the self-hosted keyring that implements it.
//!
//! The master key only ever wraps data keys. What it wraps with is the deployment's business: a
//! self-hosted install holds the key itself ([`LocalKeyring`]); the Cloud will ask a KMS to wrap
//! and unwrap, and implement [`MasterKeys`] for that without touching the vault.

use std::collections::HashMap;
use std::fmt;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use futures_util::future::{self, BoxFuture};
use zeroize::Zeroizing;

use super::cipher::{self, KEY_LEN};
use crate::StoreError;

/// The id the desktop app's single key has, and the one a generated key file gets.
pub const LOCAL_KEY_ID: &str = "local";

/// A tenant's data key (DEK): 32 random bytes that encrypt that tenant's secrets. It exists in
/// the clear only in memory, wiped when it drops, and is never logged or stored.
pub struct Dek(Zeroizing<[u8; KEY_LEN]>);

impl Dek {
    /// A new random key. The store makes one per tenant; a [`MasterKeys`] test may make its own.
    pub fn generate() -> Result<Self, StoreError> {
        let mut bytes = Zeroizing::new([0u8; KEY_LEN]);
        cipher::random_bytes(bytes.as_mut())?;
        Ok(Self(bytes))
    }

    /// The key bytes, for [`MasterKeys::wrap`] implementations and tests. Never log them.
    pub fn expose(&self) -> &[u8] {
        self.0.as_ref()
    }

    fn from_slice(bytes: &[u8]) -> Result<Self, StoreError> {
        let array: [u8; KEY_LEN] = bytes
            .try_into()
            .map_err(|_| StoreError::MalformedEnvelope("a data key is not 32 bytes"))?;
        Ok(Self(Zeroizing::new(array)))
    }
}

impl fmt::Debug for Dek {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Dek(<redacted>)")
    }
}

/// A data key encrypted by a master key, as stored: safe to write to the database.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WrappedDek {
    /// Which master key wrapped it.
    pub key_id: String,
    /// Opaque to everyone but the [`MasterKeys`] that made it.
    pub bytes: Vec<u8>,
}

/// Wraps and unwraps data keys with the master key. Async because the Cloud's implementation is
/// a network call to a KMS.
///
/// `context` is the tenant the key belongs to (`jian:dek:<tenant>`). An implementation must bind
/// it into the wrap (AAD, or a KMS encryption context), so a wrapped key copied to another tenant's
/// row does not unwrap.
pub trait MasterKeys: Send + Sync {
    /// The key new data keys are wrapped with, and the one rotation moves every key to.
    fn active_key_id(&self) -> &str;

    /// Encrypts `dek` with the active master key.
    fn wrap<'a>(
        &'a self,
        dek: &'a Dek,
        context: &'a [u8],
    ) -> BoxFuture<'a, Result<WrappedDek, StoreError>>;

    /// Decrypts a data key wrapped by the master key `key_id`, which need not be the active one.
    fn unwrap<'a>(
        &'a self,
        key_id: &'a str,
        wrapped: &'a [u8],
        context: &'a [u8],
    ) -> BoxFuture<'a, Result<Dek, StoreError>>;
}

/// Master keys held in this process: the self-hosted and desktop implementation of
/// [`MasterKeys`].
///
/// It holds every key it was given (rotation needs the old one to unwrap and the new one to
/// wrap) and names one active. Keys are 32 bytes, wiped on drop.
pub struct LocalKeyring {
    keys: HashMap<String, Zeroizing<[u8; KEY_LEN]>>,
    active: String,
}

impl fmt::Debug for LocalKeyring {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Ids only: the keys are not for a log.
        let mut ids: Vec<_> = self.keys.keys().collect();
        ids.sort();
        formatter
            .debug_struct("LocalKeyring")
            .field("ids", &ids)
            .field("active", &self.active)
            .finish()
    }
}

impl LocalKeyring {
    /// The old server's format: `keys` is the JSON of `JIAN_MASTER_KEYS`
    /// (`{"<keyId>": "<base64 of 32 bytes>"}`) and `active` is `JIAN_ACTIVE_KEY_ID`. With one key
    /// in the list the active id may be left out.
    pub fn from_json(keys: &str, active: Option<&str>) -> Result<Self, StoreError> {
        let list: HashMap<String, String> = serde_json::from_str(keys).map_err(|_| {
            StoreError::InvalidMasterKey(
                "the key list is not a JSON object of key ids and base64 keys".to_owned(),
            )
        })?;
        let mut ring = HashMap::new();
        for (id, encoded) in list {
            let key = decode_key(&id, &encoded)?;
            ring.insert(id, key);
        }
        let active = match (active.filter(|id| !id.trim().is_empty()), ring.len()) {
            (Some(id), _) => id.to_owned(),
            (None, 1) => ring.keys().next().cloned().unwrap_or_default(),
            (None, _) => {
                return Err(StoreError::InvalidMasterKey(
                    "several master keys are given but no active key id".to_owned(),
                ));
            }
        };
        Self::new(ring, active)
    }

    /// The desktop app's format: one key, the base64 of 32 bytes (`JIAN_MASTER_KEY`), with the id
    /// [`LOCAL_KEY_ID`].
    pub fn from_single(encoded: &str) -> Result<Self, StoreError> {
        let key = decode_key(LOCAL_KEY_ID, encoded)?;
        Self::new(
            HashMap::from([(LOCAL_KEY_ID.to_owned(), key)]),
            LOCAL_KEY_ID.to_owned(),
        )
    }

    /// The key kept in a file, base64 of 32 bytes, id [`LOCAL_KEY_ID`]. When there is no file, a
    /// key is generated and written there, readable by its owner only on Unix, and reused by every
    /// later start. The returned flag says whether this call made it.
    ///
    /// Losing the file loses the secrets: they cannot be decrypted without it.
    pub fn load_or_create(path: &Path) -> Result<(Self, bool), StoreError> {
        let io = |source| StoreError::Io {
            path: path.to_path_buf(),
            source,
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(io)?;
        }
        let created = match create_private(path) {
            Ok(mut file) => {
                let mut bytes = Zeroizing::new([0u8; KEY_LEN]);
                cipher::random_bytes(bytes.as_mut())?;
                let encoded = Zeroizing::new(format!("{}\n", STANDARD.encode(bytes.as_ref())));
                std::io::Write::write_all(&mut file, encoded.as_bytes()).map_err(io)?;
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(error) => return Err(io(error)),
        };
        let text = Zeroizing::new(std::fs::read_to_string(path).map_err(io)?);
        let ring = Self::from_single(text.trim()).map_err(|error| match error {
            StoreError::InvalidMasterKey(reason) => StoreError::InvalidMasterKey(format!(
                "{}: {reason}; delete the file only if nothing is encrypted with it",
                path.display()
            )),
            other => other,
        })?;
        Ok((ring, created))
    }

    fn new(
        keys: HashMap<String, Zeroizing<[u8; KEY_LEN]>>,
        active: String,
    ) -> Result<Self, StoreError> {
        if !keys.contains_key(&active) {
            return Err(StoreError::InvalidMasterKey(format!(
                "the active key id {active:?} is not among the master keys"
            )));
        }
        Ok(Self { keys, active })
    }

    /// The ids of the keys held, sorted. For logs: ids are not secret.
    pub fn key_ids(&self) -> Vec<&str> {
        let mut ids: Vec<_> = self.keys.keys().map(String::as_str).collect();
        ids.sort_unstable();
        ids
    }

    fn key(&self, id: &str) -> Result<&[u8], StoreError> {
        self.keys
            .get(id)
            .map(|key| key.as_slice())
            .ok_or_else(|| StoreError::UnknownMasterKey(id.to_owned()))
    }

    /// Decrypts a secret of one agent written by the Node Jian, for the import: JSON
    /// `{"version":1,"keyId","iv","ciphertext","tag"}`, each field base64, AES-256-GCM, bound to
    /// `jian:secret:<profile_id>:<owner>`. The key is the one the old install named, which must be
    /// in this keyring. The result is meant to be written back with the vault, which encrypts it
    /// under the new tenant's data key.
    pub fn decrypt_legacy(
        &self,
        profile_id: &str,
        owner: &str,
        envelope: &str,
    ) -> Result<super::Secret, StoreError> {
        self.decrypt_legacy_bound(&cipher::secret_aad(profile_id, owner), envelope)
    }

    /// [`decrypt_legacy`](LocalKeyring::decrypt_legacy) for a secret the whole old install shared
    /// (a provider's key, an MCP token), which the Node Jian bound to
    /// `jian:gateway-secret:<owner>` and not to an agent.
    pub fn decrypt_legacy_gateway(
        &self,
        owner: &str,
        envelope: &str,
    ) -> Result<super::Secret, StoreError> {
        self.decrypt_legacy_bound(format!("jian:gateway-secret:{owner}").as_bytes(), envelope)
    }

    /// A keyring of the old install's keys, only to read what they sealed: the first id in sort
    /// order is named active because the type needs one, and nothing is ever wrapped with it.
    /// Same JSON as [`from_json`](LocalKeyring::from_json); an empty list is refused.
    pub fn for_reading_legacy(keys: &str) -> Result<Self, StoreError> {
        let list: HashMap<String, String> = serde_json::from_str(keys).map_err(|_| {
            StoreError::InvalidMasterKey(
                "the key list is not a JSON object of key ids and base64 keys".to_owned(),
            )
        })?;
        let first =
            list.keys().min().cloned().ok_or_else(|| {
                StoreError::InvalidMasterKey("the key list has no key".to_owned())
            })?;
        Self::from_json(keys, Some(&first))
    }

    fn decrypt_legacy_bound(
        &self,
        aad: &[u8],
        envelope: &str,
    ) -> Result<super::Secret, StoreError> {
        let bad = |reason| StoreError::MalformedEnvelope(reason);
        let json: serde_json::Value =
            serde_json::from_str(envelope).map_err(|_| bad("not JSON"))?;
        let field = |name: &'static str| -> Result<Vec<u8>, StoreError> {
            json.get(name)
                .and_then(serde_json::Value::as_str)
                .and_then(|text| STANDARD.decode(text).ok())
                .ok_or(bad("a field is missing or not base64"))
        };
        if json.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
            return Err(bad("an unknown version"));
        }
        let key_id = json
            .get("keyId")
            .and_then(serde_json::Value::as_str)
            .ok_or(bad("no key id"))?;
        let mut encrypted = field("ciphertext")?;
        encrypted.extend_from_slice(&field("tag")?);
        let plain = cipher::open_parts(
            self.key(key_id)?,
            aad,
            &field("iv")?,
            &encrypted,
            "a legacy secret",
        )?;
        let text = String::from_utf8(plain.to_vec()).map_err(|_| bad("the secret is not text"))?;
        Ok(super::Secret::new(text))
    }
}

impl MasterKeys for LocalKeyring {
    fn active_key_id(&self) -> &str {
        &self.active
    }

    fn wrap<'a>(
        &'a self,
        dek: &'a Dek,
        context: &'a [u8],
    ) -> BoxFuture<'a, Result<WrappedDek, StoreError>> {
        let wrapped = self.key(&self.active).and_then(|key| {
            Ok(WrappedDek {
                key_id: self.active.clone(),
                bytes: cipher::seal(key, context, dek.expose())?,
            })
        });
        Box::pin(future::ready(wrapped))
    }

    fn unwrap<'a>(
        &'a self,
        key_id: &'a str,
        wrapped: &'a [u8],
        context: &'a [u8],
    ) -> BoxFuture<'a, Result<Dek, StoreError>> {
        let dek = self.key(key_id).and_then(|key| {
            let plain = cipher::open(key, context, wrapped, "a data key")?;
            Dek::from_slice(&plain)
        });
        Box::pin(future::ready(dek))
    }
}

fn decode_key(id: &str, encoded: &str) -> Result<Zeroizing<[u8; KEY_LEN]>, StoreError> {
    let bytes = Zeroizing::new(STANDARD.decode(encoded.trim()).map_err(|_| {
        StoreError::InvalidMasterKey(format!("master key {id:?} is not valid base64"))
    })?);
    let array: [u8; KEY_LEN] = bytes.as_slice().try_into().map_err(|_| {
        StoreError::InvalidMasterKey(format!(
            "master key {id:?} is {} bytes, not {KEY_LEN}",
            bytes.len()
        ))
    })?;
    Ok(Zeroizing::new(array))
}

/// Creates the file for a new key, failing if it exists. On Unix it is made with mode 0600 from
/// the start, so there is no moment when the key is readable by others.
fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(path)
}
