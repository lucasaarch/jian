//! AES-256-GCM, and the two shapes built on it: the sealed blob (a nonce and the encrypted
//! bytes) that wraps a data key, and the envelope that holds a secret.
//!
//! Every call draws a fresh random 96-bit nonce. With one data key per tenant and random nonces,
//! the chance of a repeat stays negligible below 2^32 secrets sealed under one key, far beyond what
//! a tenant stores. The authentication tag (16 bytes) is appended to the ciphertext.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use zeroize::Zeroizing;

use crate::StoreError;

/// Bytes of a data key or a master key.
pub(crate) const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// The envelope layout this build writes. A byte, so a later layout can be told apart.
const ENVELOPE_VERSION: u8 = 1;

/// The id every envelope carries for the data key that sealed it. Each tenant has one data key
/// today; the id is in the format so a tenant can later hold several without a data migration.
pub(crate) const DATA_KEY_ID: &str = "dek-1";

/// Fills `buffer` from the operating system's random source.
pub(crate) fn random_bytes(buffer: &mut [u8]) -> Result<(), StoreError> {
    getrandom::fill(buffer).map_err(StoreError::Random)
}

/// Encrypts `plaintext` with `key`, binding it to `aad`. Returns `nonce || ciphertext || tag`.
pub(crate) fn seal(key: &[u8], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, StoreError> {
    let mut nonce = [0u8; NONCE_LEN];
    random_bytes(&mut nonce)?;
    let encrypted = cipher(key)?
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| StoreError::Decrypt { what: "a value" })?;
    let mut sealed = Vec::with_capacity(NONCE_LEN + encrypted.len());
    sealed.extend_from_slice(&nonce);
    sealed.extend_from_slice(&encrypted);
    Ok(sealed)
}

/// Opens what [`seal`] made. Fails when `key` or `aad` differ from the ones used to seal, or when
/// a single byte changed.
pub(crate) fn open(
    key: &[u8],
    aad: &[u8],
    sealed: &[u8],
    what: &'static str,
) -> Result<Zeroizing<Vec<u8>>, StoreError> {
    if sealed.len() < NONCE_LEN + TAG_LEN {
        return Err(StoreError::MalformedEnvelope(
            "shorter than a nonce and a tag",
        ));
    }
    let (nonce, encrypted) = sealed.split_at(NONCE_LEN);
    open_parts(key, aad, nonce, encrypted, what)
}

/// [`open`] for a nonce and a ciphertext that are stored apart, as the old Jian did.
pub(crate) fn open_parts(
    key: &[u8],
    aad: &[u8],
    nonce: &[u8],
    ciphertext_and_tag: &[u8],
    what: &'static str,
) -> Result<Zeroizing<Vec<u8>>, StoreError> {
    let nonce: [u8; NONCE_LEN] = nonce
        .try_into()
        .map_err(|_| StoreError::MalformedEnvelope("the nonce is not 12 bytes"))?;
    cipher(key)?
        .decrypt(
            &Nonce::from(nonce),
            Payload {
                msg: ciphertext_and_tag,
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| StoreError::Decrypt { what })
}

fn cipher(key: &[u8]) -> Result<Aes256Gcm, StoreError> {
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| StoreError::InvalidMasterKey(format!("a key must be {KEY_LEN} bytes")))
}

/// What ties a secret to its place: the tenant and the owner. Copy the envelope to another row or
/// another tenant and the tag no longer matches, so it fails instead of leaking.
pub(crate) fn secret_aad(tenant: &str, owner: &str) -> Vec<u8> {
    format!("jian:secret:{tenant}:{owner}").into_bytes()
}

/// What ties a wrapped data key to its tenant.
pub(crate) fn data_key_context(tenant: &str) -> Vec<u8> {
    format!("jian:dek:{tenant}").into_bytes()
}

/// `version (1) || key id length (1) || key id || nonce (12) || ciphertext || tag (16)`.
/// Raw bytes in a `bytea`: no encoding to undo, and the key id is readable without the key.
pub(crate) fn seal_envelope(
    data_key: &[u8],
    tenant: &str,
    owner: &str,
    secret: &[u8],
) -> Result<Vec<u8>, StoreError> {
    let sealed = seal(data_key, &secret_aad(tenant, owner), secret)?;
    let id = DATA_KEY_ID.as_bytes();
    let mut envelope = Vec::with_capacity(2 + id.len() + sealed.len());
    envelope.push(ENVELOPE_VERSION);
    // The id is a constant of a few bytes, so the length always fits.
    envelope.push(id.len() as u8);
    envelope.extend_from_slice(id);
    envelope.extend_from_slice(&sealed);
    Ok(envelope)
}

/// Reads an envelope made by [`seal_envelope`] for this tenant and owner.
pub(crate) fn open_envelope(
    data_key: &[u8],
    tenant: &str,
    owner: &str,
    envelope: &[u8],
) -> Result<Zeroizing<Vec<u8>>, StoreError> {
    let [version, id_len, rest @ ..] = envelope else {
        return Err(StoreError::MalformedEnvelope("too short"));
    };
    if *version != ENVELOPE_VERSION {
        return Err(StoreError::MalformedEnvelope("an unknown version"));
    }
    let id_len = usize::from(*id_len);
    if rest.len() < id_len {
        return Err(StoreError::MalformedEnvelope("the key id is cut short"));
    }
    let (id, sealed) = rest.split_at(id_len);
    if id != DATA_KEY_ID.as_bytes() {
        return Err(StoreError::MalformedEnvelope("an unknown data key id"));
    }
    open(data_key, &secret_aad(tenant, owner), sealed, "a secret")
}
