//! The password rules and the hash, with no database: what is accepted, that a hash is argon2id
//! and salted, and that nothing but the right password verifies.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::str::FromStr as _;

use jian_auth::{
    AuthError, AuthPolicy, CredentialKind, MAX_PASSWORD_BYTES, PasswordHasher, PasswordParams,
    check_password,
};

fn hasher() -> PasswordHasher {
    PasswordHasher::new(PasswordParams::insecure_for_tests())
}

#[test]
fn a_password_has_twelve_characters_and_at_most_256_bytes() {
    assert!(check_password(&"a".repeat(12)).is_ok());
    assert!(check_password(&"a".repeat(11)).is_err());
    assert!(check_password("").is_err());
    assert!(check_password(&"a".repeat(MAX_PASSWORD_BYTES)).is_ok());
    assert!(check_password(&"a".repeat(MAX_PASSWORD_BYTES + 1)).is_err());
    // Characters, not bytes, for the minimum: twelve 2-byte characters are enough...
    assert!(check_password(&"é".repeat(12)).is_ok());
    // ...and bytes, not characters, for the maximum: 129 of them are 258 bytes.
    assert!(check_password(&"é".repeat(129)).is_err());
    assert!(matches!(
        check_password("short"),
        Err(AuthError::InvalidPassword { min_chars: 12, .. })
    ));
}

#[tokio::test]
async fn a_hash_is_a_salted_argon2id_phc_string_that_only_its_password_verifies() {
    let hasher = hasher();
    let hash = hasher.hash("correct horse battery staple").await.unwrap();
    assert!(hash.starts_with("$argon2id$v=19$"), "{hash}");
    assert!(!hash.contains("correct horse"));
    assert!(hasher.verify("correct horse battery staple", &hash).await);
    assert!(!hasher.verify("correct horse battery stapl", &hash).await);
    assert!(!hasher.verify("", &hash).await);
    // The same password hashes differently each time: the salt is random.
    let other = hasher.hash("correct horse battery staple").await.unwrap();
    assert_ne!(hash, other);
    assert!(hasher.verify("correct horse battery staple", &other).await);
    // What is not a hash matches nothing, and does not panic.
    for junk in [
        "",
        "plain",
        "$argon2id$",
        "$argon2id$v=19$m=8,t=1,p=1$!!$!!",
    ] {
        assert!(!hasher.verify("correct horse battery staple", junk).await);
    }
}

#[tokio::test]
async fn a_hash_keeps_the_cost_it_was_made_with() {
    let cheap = hasher().hash("correct horse battery staple").await.unwrap();
    assert!(cheap.contains("m=8,t=1,p=1"), "{cheap}");
    // A hasher at another cost still checks it: the cost is read from the hash.
    let dearer = PasswordHasher::new(PasswordParams {
        memory_kib: 64,
        iterations: 2,
        parallelism: 1,
    });
    assert!(dearer.verify("correct horse battery staple", &cheap).await);
    let mine = dearer.hash("correct horse battery staple").await.unwrap();
    assert!(mine.contains("m=64,t=2,p=1"), "{mine}");
}

#[test]
fn the_policy_reads_a_list_and_refuses_what_it_does_not_know() {
    let both = AuthPolicy::from_str("password, github").unwrap();
    assert!(both.allows(CredentialKind::Password));
    assert!(both.allows(CredentialKind::Github));
    assert!(!both.allows(CredentialKind::Passkey));
    assert_eq!(both.to_string().parse::<AuthPolicy>().unwrap(), both);
    assert!(AuthPolicy::from_str("password,telepathy").is_err());
    assert!(AuthPolicy::from_str("").is_err());
    assert!(AuthPolicy::default().allows(CredentialKind::Password));
    assert!(!AuthPolicy::cloud().allows(CredentialKind::Password));
    assert!(matches!(
        AuthPolicy::cloud().require(CredentialKind::Password),
        Err(AuthError::MethodDisabled(CredentialKind::Password))
    ));
}
