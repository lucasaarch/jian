//! Fetching a `SKILL.md` from a fake GitHub on a local port.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::Router;
use axum::http::StatusCode;
use axum::routing::get;
use jian_skills::{GithubSource, MAX_SKILL_FILE_BYTES, SkillError};
use jian_store::SkillSource;

const SKILL: &str = "---\nname: brief-writer\ndescription: d\n---\nbody\n";

/// A server that answers the way raw.githubusercontent.com does, and where it is.
async fn fake() -> String {
    let app = Router::new()
        .route(
            "/acme/skills/HEAD/brief-writer/SKILL.md",
            get(|| async { SKILL }),
        )
        .route(
            "/acme/skills/v2/brief-writer/SKILL.md",
            get(|| async { "second" }),
        )
        .route(
            "/acme/skills/HEAD/limited/SKILL.md",
            get(|| async { StatusCode::TOO_MANY_REQUESTS }),
        )
        .route(
            "/acme/skills/HEAD/broken/SKILL.md",
            get(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
        )
        .route(
            "/acme/skills/HEAD/big/SKILL.md",
            get(|| async { "x".repeat(MAX_SKILL_FILE_BYTES + 1) }),
        )
        .route(
            "/acme/skills/HEAD/binary/SKILL.md",
            get(|| async { vec![0xff_u8, 0xfe, 0x00] }),
        )
        .route(
            "/acme/skills/HEAD/moved/SKILL.md",
            get(|| async { (StatusCode::FOUND, [("location", "http://127.0.0.1:1/x")]) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

#[tokio::test]
async fn a_skill_is_fetched_with_where_it_came_from() {
    let github = GithubSource::new(&format!("{}/", fake().await)).unwrap();
    let (source, markdown) = github
        .fetch("acme/skills", "brief-writer", None)
        .await
        .unwrap();
    assert_eq!(markdown, SKILL);
    assert_eq!(
        source,
        SkillSource::Github {
            repo: "acme/skills".to_owned(),
            path: "brief-writer".to_owned(),
            git_ref: "HEAD".to_owned(),
        }
    );
    // A named ref, and the same path again, give what is there now.
    let (source, markdown) = github
        .fetch("acme/skills", "/brief-writer/", Some("v2"))
        .await
        .unwrap();
    assert_eq!(markdown, "second");
    assert!(matches!(source, SkillSource::Github { git_ref, .. } if git_ref == "v2"));
}

#[tokio::test]
async fn a_missing_file_is_not_found() {
    let github = GithubSource::new(&fake().await).unwrap();
    assert_eq!(
        github
            .fetch("acme/skills", "nothing", None)
            .await
            .unwrap_err(),
        SkillError::NotFound
    );
}

#[tokio::test]
async fn too_many_requests_is_said_as_such() {
    let github = GithubSource::new(&fake().await).unwrap();
    assert_eq!(
        github
            .fetch("acme/skills", "limited", None)
            .await
            .unwrap_err(),
        SkillError::RateLimited
    );
}

#[tokio::test]
async fn a_file_over_the_cap_is_refused() {
    let github = GithubSource::new(&fake().await).unwrap();
    assert_eq!(
        github.fetch("acme/skills", "big", None).await.unwrap_err(),
        SkillError::TooLarge(MAX_SKILL_FILE_BYTES)
    );
}

#[tokio::test]
async fn other_failures_are_not_taken_for_a_skill() {
    let github = GithubSource::new(&fake().await).unwrap();
    for path in ["broken", "moved"] {
        assert!(
            matches!(
                github.fetch("acme/skills", path, None).await,
                Err(SkillError::Unreachable(_))
            ),
            "{path}"
        );
    }
    assert_eq!(
        github
            .fetch("acme/skills", "binary", None)
            .await
            .unwrap_err(),
        SkillError::NotText
    );
    // Nothing is asked of a port nobody listens on.
    let nobody = GithubSource::new("http://127.0.0.1:1").unwrap();
    assert!(matches!(
        nobody.fetch("acme/skills", "x", None).await,
        Err(SkillError::Unreachable(_))
    ));
}

#[tokio::test]
async fn an_address_that_leaves_the_repository_is_refused() {
    let github = GithubSource::new("http://127.0.0.1:1").unwrap();
    for (repo, path, git_ref) in [
        ("acme", "x", "HEAD"),
        ("acme/skills/extra", "x", "HEAD"),
        ("../skills", "x", "HEAD"),
        ("acme/skills", "../other", "HEAD"),
        ("acme/skills", "a//b", "HEAD"),
        ("acme/skills", "x", "a/../b"),
        ("acme/skills", "x", "-flag"),
        ("acme/skills", "x?y=1", "HEAD"),
        ("acme/skills", "x", "a b"),
    ] {
        assert!(
            matches!(
                github.fetch(repo, path, Some(git_ref)).await,
                Err(SkillError::BadSource(_))
            ),
            "{repo} {path} {git_ref}"
        );
    }
}
