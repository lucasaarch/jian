//! Where a plugin's request may go: the Cloud edition reaches public addresses only, after DNS
//! and across redirects; the self-hosted edition reaches anything.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::net::IpAddr;
use std::time::Duration;

use axum::Router;
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::get;
use jian_server::outbound::{check_literal, client, is_internal};

const WAIT: Duration = Duration::from_secs(5);

async fn serve() -> u16 {
    let app = Router::new().route("/", get(|| async { "hello" })).route(
        "/hop",
        get(|| async {
            (
                StatusCode::FOUND,
                [(header::LOCATION, "http://169.254.169.254/latest")],
            )
                .into_response()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await });
    port
}

#[test]
fn every_kind_of_private_address_is_internal_and_public_ones_are_not() {
    for text in [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.9",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "::1",
        "::",
        "fe80::1",
        "fd00::1",
        // IPv4 inside IPv6: mapped, NAT64, 6to4.
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
        "64:ff9b::a9fe:a9fe",
        "2002:a9fe:a9fe::1",
    ] {
        assert!(is_internal(text.parse::<IpAddr>().unwrap()), "{text}");
    }
    for text in [
        "8.8.8.8",
        "1.1.1.1",
        "93.184.216.34",
        "2606:4700:4700::1111",
    ] {
        assert!(!is_internal(text.parse::<IpAddr>().unwrap()), "{text}");
    }
}

#[test]
fn an_address_written_as_an_ip_is_checked_and_a_name_is_left_to_the_resolver() {
    let url = |text: &str| url::Url::parse(text).unwrap();
    assert!(check_literal(&url("http://169.254.169.254/latest/meta-data")).is_err());
    assert!(check_literal(&url("http://[::1]:8080/")).is_err());
    assert!(check_literal(&url("http://127.0.0.1:3000/mcp")).is_err());
    // Decimal and hex forms are normalized by the URL parser into the same address.
    assert!(check_literal(&url("http://2130706433/")).is_err());
    assert!(check_literal(&url("http://0x7f.1/")).is_err());
    assert!(check_literal(&url("https://8.8.8.8/")).is_ok());
    assert!(check_literal(&url("https://example.com/")).is_ok());
}

#[tokio::test]
async fn cloud_refuses_a_name_that_resolves_to_loopback_and_self_hosted_reaches_it() {
    let port = serve().await;
    // `localhost` is a name: only the resolver can tell where it goes.
    let target = format!("http://localhost:{port}/");

    let cloud = client(false, WAIT);
    let refused = cloud.get(&target).send().await.unwrap_err();
    assert!(
        format!("{refused:?}").contains("private network"),
        "{refused:?}"
    );

    let own = client(true, WAIT);
    let answer = own.get(&target).send().await.unwrap();
    assert_eq!(answer.text().await.unwrap(), "hello");
}

#[tokio::test]
async fn a_redirect_is_never_followed() {
    let port = serve().await;
    // Self-hosted reaches the server, which sends the request on to the metadata address: the
    // client hands back the 302 and goes nowhere.
    let answer = client(true, WAIT)
        .get(format!("http://127.0.0.1:{port}/hop"))
        .send()
        .await
        .unwrap();
    assert_eq!(answer.status(), StatusCode::FOUND);
}
