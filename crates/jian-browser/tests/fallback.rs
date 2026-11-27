//! The second engine is tried for a site the first cannot run, and for nothing else. Two fake
//! engines, so it needs no program. The pages kept for a run are tried here too.

// Helpers outside a `#[test]` state their expectations with unwrap too.
#![allow(clippy::unwrap_used)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use jian_browser::{Browser, BrowserError, Page, Session, Sessions, WithFallback};

#[derive(Clone, Copy)]
enum Fails {
    Never,
    Unsupported,
    Network,
    Blocked,
}

struct Fake {
    name: &'static str,
    fails: Fails,
    text: &'static str,
    log: Arc<Mutex<Vec<String>>>,
}

struct FakeSession {
    name: &'static str,
    fails: Fails,
    text: &'static str,
    log: Arc<Mutex<Vec<String>>>,
}

impl Browser for Fake {
    fn engine(&self) -> &'static str {
        self.name
    }

    fn open(&self) -> BoxFuture<'_, Result<Box<dyn Session>, BrowserError>> {
        Box::pin(async move {
            self.log
                .lock()
                .unwrap()
                .push(format!("{} opened", self.name));
            Ok(Box::new(FakeSession {
                name: self.name,
                fails: self.fails,
                text: self.text,
                log: Arc::clone(&self.log),
            }) as Box<dyn Session>)
        })
    }
}

impl Session for FakeSession {
    fn navigate<'a>(&'a mut self, url: &'a str) -> BoxFuture<'a, Result<Page, BrowserError>> {
        Box::pin(async move {
            self.log
                .lock()
                .unwrap()
                .push(format!("{} navigated {url}", self.name));
            match self.fails {
                Fails::Never => Ok(Page {
                    url: url.to_owned(),
                    title: self.name.to_owned(),
                }),
                Fails::Unsupported => Err(BrowserError::Unsupported("no such API".into())),
                Fails::Network => Err(BrowserError::Network("timed out".into())),
                Fails::Blocked => Err(BrowserError::Blocked("private".into())),
            }
        })
    }

    fn text(&mut self) -> BoxFuture<'_, Result<String, BrowserError>> {
        Box::pin(async move { Ok(self.text.to_owned()) })
    }

    fn screenshot(&mut self) -> BoxFuture<'_, Result<Vec<u8>, BrowserError>> {
        Box::pin(async move { Ok(self.name.as_bytes().to_vec()) })
    }

    fn pdf(&mut self) -> BoxFuture<'_, Result<Vec<u8>, BrowserError>> {
        Box::pin(async move { Ok(self.name.as_bytes().to_vec()) })
    }

    fn close(self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            self.log
                .lock()
                .unwrap()
                .push(format!("{} closed", self.name));
        })
    }
}

const LONG: &str = "a page with plenty of readable words in it";

fn pair(
    first: Fails,
    first_text: &'static str,
    with_fallback: bool,
) -> (WithFallback, Arc<Mutex<Vec<String>>>) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let primary = Fake {
        name: "obscura",
        fails: first,
        text: first_text,
        log: Arc::clone(&log),
    };
    let second = Fake {
        name: "chromium",
        fails: Fails::Never,
        text: LONG,
        log: Arc::clone(&log),
    };
    let fallback = with_fallback.then(|| Arc::new(second) as Arc<dyn Browser>);
    (WithFallback::new(Arc::new(primary), fallback), log)
}

fn opened(log: &Mutex<Vec<String>>, engine: &str) -> bool {
    log.lock()
        .unwrap()
        .iter()
        .any(|l| l == &format!("{engine} opened"))
}

#[tokio::test]
async fn a_site_the_first_engine_cannot_run_goes_to_the_second() {
    let (browser, log) = pair(Fails::Unsupported, LONG, true);
    let mut session = browser.open().await.unwrap();
    let page = session.navigate("https://site.example/").await.unwrap();
    assert_eq!(page.title, "chromium");
    // What is asked next is asked of the engine that runs the page, and the first is closed.
    assert_eq!(session.screenshot().await.unwrap(), b"chromium");
    assert!(log.lock().unwrap().contains(&"obscura closed".to_owned()));
}

#[tokio::test]
async fn an_unreachable_site_and_a_refused_address_are_not_retried() {
    for fails in [Fails::Network, Fails::Blocked] {
        let (browser, log) = pair(fails, LONG, true);
        let mut session = browser.open().await.unwrap();
        let error = session.navigate("https://site.example/").await.unwrap_err();
        assert!(!error.runs_elsewhere(), "{error}");
        assert!(
            !opened(&log, "chromium"),
            "the second engine was started for {error}"
        );
    }
}

#[tokio::test]
async fn a_page_that_loads_empty_is_read_again_on_the_second_engine() {
    let (browser, _) = pair(Fails::Never, "   ", true);
    let mut session = browser.open().await.unwrap();
    session.navigate("https://spa.example/").await.unwrap();
    assert_eq!(session.text().await.unwrap(), LONG);
}

#[tokio::test]
async fn without_a_second_engine_the_error_is_the_first_ones() {
    let (browser, _) = pair(Fails::Unsupported, LONG, false);
    let mut session = browser.open().await.unwrap();
    let error = session.navigate("https://site.example/").await.unwrap_err();
    assert!(matches!(error, BrowserError::Unsupported(_)));
}

fn count(log: &Mutex<Vec<String>>, entry: &str) -> usize {
    log.lock().unwrap().iter().filter(|l| *l == entry).count()
}

#[tokio::test]
async fn each_key_has_its_own_page_and_a_closed_one_is_made_again() {
    let (browser, log) = pair(Fails::Never, LONG, false);
    let pages = Sessions::new(Arc::new(browser), Duration::from_secs(60));
    let url = "https://site.example/";
    pages.read("tenant-a/run-1", url).await.unwrap();
    pages.read("tenant-a/run-1", url).await.unwrap();
    assert_eq!(count(&log, "obscura opened"), 1, "one key, one page");
    pages.read("tenant-b/run-1", url).await.unwrap();
    assert_eq!(count(&log, "obscura opened"), 2, "a page is never shared");
    assert!(pages.close("tenant-a/run-1").await);
    assert!(!pages.close("tenant-a/run-1").await);
    assert_eq!(count(&log, "obscura closed"), 1);
    pages.read("tenant-a/run-1", url).await.unwrap();
    assert_eq!(count(&log, "obscura opened"), 3);
}

#[tokio::test]
async fn a_page_nobody_uses_is_closed() {
    let (browser, log) = pair(Fails::Never, LONG, false);
    let pages = Sessions::new(Arc::new(browser), Duration::from_millis(100));
    pages.read("k", "https://site.example/").await.unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(count(&log, "obscura closed"), 1);
}
