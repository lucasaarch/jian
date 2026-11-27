//! The two engines, run for real against a server on loopback. They need the programs: the path
//! comes from `JIAN_TEST_OBSCURA` / `JIAN_TEST_CHROMIUM`, or the name is looked up on `PATH`.
//! A test for an engine that is not installed says so on stderr and passes without running; run
//! with `--no-capture` to see which.

// Helpers outside a `#[test]` state their expectations with unwrap too.
#![allow(clippy::unwrap_used)]

mod site;

use std::path::{Path, PathBuf};
use std::time::Duration;

use jian_browser::{
    Browser, BrowserError, CdpBrowser, Engine, EngineConfig, Format, NetworkPolicy, discover,
    render,
};
use jian_core::ArtifactKind;
use site::Site;

#[allow(
    clippy::print_stderr,
    reason = "a skipped test must say what it did not run"
)]
fn engines() -> Vec<(Engine, PathBuf)> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut found = Vec::new();
    for (engine, var, names) in [
        (Engine::Obscura, "JIAN_TEST_OBSCURA", &["obscura"][..]),
        (
            Engine::Chromium,
            "JIAN_TEST_CHROMIUM",
            &[
                "chromium",
                "chromium-browser",
                "google-chrome",
                "google-chrome-stable",
                "chrome",
            ][..],
        ),
    ] {
        let binary = std::env::var_os(var)
            .map(PathBuf::from)
            .or_else(|| discover(names, &path));
        match binary {
            Some(binary) => found.push((engine, binary)),
            None => eprintln!("SKIPPED: {} is not installed (set {var})", engine.name()),
        }
    }
    found
}

fn browser(engine: Engine, binary: &Path, policy: NetworkPolicy) -> CdpBrowser {
    CdpBrowser::new(EngineConfig::new(engine, binary.to_path_buf(), policy))
}

#[tokio::test(flavor = "multi_thread")]
async fn an_artifact_is_drawn_as_a_pdf_and_a_png_even_with_no_network() {
    for (engine, binary) in engines() {
        // The strictest policy: the document is a `data:` address and needs no host.
        let browser = browser(engine, &binary, NetworkPolicy::PublicOnly);
        let deck = r#"{"slides":["<h1>First slide</h1>","<h1>Second slide</h1>"]}"#;
        let pdf = render(&browser, ArtifactKind::Deck, "Deck", deck, Format::Pdf)
            .await
            .unwrap();
        assert!(pdf.starts_with(b"%PDF"), "{}", engine.name());
        let png = render(&browser, ArtifactKind::Deck, "Deck", deck, Format::Png)
            .await
            .unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "{}", engine.name());
        let doc = render(
            &browser,
            ArtifactKind::Markdown,
            "Doc",
            "# Title\n\n- one\n- two",
            Format::Pdf,
        )
        .await
        .unwrap();
        assert!(doc.starts_with(b"%PDF"), "{}", engine.name());
        browser.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_local_page_is_read_as_text() {
    let site = Site::start().await;
    for (engine, binary) in engines() {
        let browser = browser(engine, &binary, NetworkPolicy::AnyNetwork);
        let mut session = browser.open().await.unwrap();
        let page = session.navigate(&site.url("/")).await.unwrap();
        assert_eq!(page.title, "Home", "{}", engine.name());
        let text = session.text().await.unwrap();
        assert!(
            text.contains("Hello readable world"),
            "{}: {text}",
            engine.name()
        );
        session.close().await;
        browser.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_screenshot_fits_the_limit_and_a_pdf_is_not_empty() {
    let site = Site::start().await;
    for (engine, binary) in engines() {
        let browser = browser(engine, &binary, NetworkPolicy::AnyNetwork);
        let mut session = browser.open().await.unwrap();
        session.navigate(&site.url("/big")).await.unwrap();
        let png = session.screenshot().await.unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "{}", engine.name());
        let (w, h) = (
            u32::from_be_bytes(png[16..20].try_into().unwrap()),
            u32::from_be_bytes(png[20..24].try_into().unwrap()),
        );
        assert!(w <= 1600 && h <= 1600, "{}: {w}x{h}", engine.name());
        // Obscura will not print a 4000x5000 page (it has a pixel budget, and says so as
        // `Unsupported`, which sends the page to the second engine): the PDF is of a page of
        // the usual size.
        session.navigate(&site.url("/")).await.unwrap();
        let pdf = session.pdf().await.unwrap();
        assert!(
            pdf.starts_with(b"%PDF") && pdf.len() > 500,
            "{}",
            engine.name()
        );
        session.close().await;
        browser.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn two_pages_do_not_see_each_others_cookies_or_storage() {
    let site = Site::start().await;
    for (engine, binary) in engines() {
        let browser = browser(engine, &binary, NetworkPolicy::AnyNetwork);
        let mut a = browser.open().await.unwrap();
        let mut b = browser.open().await.unwrap();
        a.navigate(&site.url("/set")).await.unwrap();
        a.navigate(&site.url("/read")).await.unwrap();
        let mine = a.text().await.unwrap();
        // The test means something only if the first page really holds a cookie.
        assert!(mine.contains("js=1"), "{}: {mine}", engine.name());
        b.navigate(&site.url("/read")).await.unwrap();
        let theirs = b.text().await.unwrap();
        assert!(
            !theirs.contains("js=1")
                && !theirs.contains("tenant=A")
                && !theirs.contains("storage=A"),
            "{}: {theirs}",
            engine.name()
        );
        a.close().await;
        b.close().await;
        browser.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_private_address_is_refused_only_where_the_network_is_public_only() {
    let site = Site::start().await;
    for (engine, binary) in engines() {
        let browser = browser(engine, &binary, NetworkPolicy::PublicOnly);
        let mut session = browser.open().await.unwrap();
        let error = session.navigate(&site.url("/")).await.unwrap_err();
        assert!(
            matches!(error, BrowserError::Blocked(_)),
            "{}: {error}",
            engine.name()
        );
        session.close().await;
        browser.shutdown().await;
        assert!(site.hits().is_empty(), "{} reached the site", engine.name());
    }
}

/// A page the browser may open (a `data:` document) that asks for a private address by an image,
/// a script's request and a script's navigation.
fn reaching_page(target: &Site) -> String {
    let html = format!(
        "<html><body><img src='{pixel}'><script>fetch('{pixel}').catch(function(){{}});\
         setTimeout(function(){{location.href='{secret}'}},300)</script>hi</body></html>",
        pixel = target.url("/pixel"),
        secret = target.url("/secret"),
    );
    format!(
        "data:text/html;charset=utf-8,{}",
        html.replace('#', "%23").replace(' ', "%20")
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn a_page_cannot_reach_a_private_address_by_a_subresource_or_a_redirect() {
    for (engine, binary) in engines() {
        // The control: with the network open, the same page does reach the server.
        let open = Site::start().await;
        let browser_open = browser(engine, &binary, NetworkPolicy::AnyNetwork);
        let mut session = browser_open.open().await.unwrap();
        session.navigate(&reaching_page(&open)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        session.close().await;
        browser_open.shutdown().await;
        assert!(
            !open.hits().is_empty(),
            "{}: the control page reached nothing",
            engine.name()
        );

        let closed = Site::start().await;
        let browser_closed = browser(engine, &binary, NetworkPolicy::PublicOnly);
        let mut session = browser_closed.open().await.unwrap();
        session.navigate(&reaching_page(&closed)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        session.close().await;
        browser_closed.shutdown().await;
        assert!(
            closed.hits().is_empty(),
            "{} reached {:?}",
            engine.name(),
            closed.hits()
        );
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn the_program_stops_when_idle_and_leaves_no_process() {
    let site = Site::start().await;
    for (engine, binary) in engines() {
        let mut cfg = EngineConfig::new(engine, binary, NetworkPolicy::AnyNetwork);
        cfg.idle = Duration::from_millis(800);
        let browser = CdpBrowser::new(cfg);
        let mut session = browser.open().await.unwrap();
        session.navigate(&site.url("/")).await.unwrap();
        let pid = browser.pid().unwrap();
        // Busy: not stopped, however long the page is held.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert!(
            browser.running(),
            "{} stopped under an open page",
            engine.name()
        );
        session.close().await;
        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert!(
            !browser.running(),
            "{} did not stop when idle",
            engine.name()
        );
        // `ps` prints nothing for a process that is gone, and `Z` for one nobody waited for.
        let ps = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&ps.stdout).trim().is_empty(),
            "{}: process {pid} is still there",
            engine.name()
        );
        // And the next page starts it again.
        let mut again = browser.open().await.unwrap();
        again.navigate(&site.url("/")).await.unwrap();
        again.close().await;
        browser.shutdown().await;
    }
}
