//! The pages the agents hold open between tool calls, one per key (a tenant and a run).
//!
//! A key's page is made on its first call and is its own context, so what one run logged in to
//! is never seen by another. A page nobody uses for [`Sessions::new`]'s `ttl` is closed (a run
//! that ended without saying so), which is also what lets the program stop when idle.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use crate::{Browser, BrowserError, Page, Session};

/// The most pages open at once, over every key. A page is memory in the program.
const MAX_OPEN: usize = 16;

/// A page that was read: where it ended up and its text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Read {
    /// The page.
    pub page: Page,
    /// What a person would read on it.
    pub text: String,
}

struct Held {
    /// `None` once closed.
    session: tokio::sync::Mutex<Option<Box<dyn Session>>>,
    used: Mutex<Instant>,
}

type Table = Arc<tokio::sync::Mutex<HashMap<String, Arc<Held>>>>;

/// The open pages of a [`Browser`].
pub struct Sessions {
    browser: Arc<dyn Browser>,
    ttl: Duration,
    table: Table,
}

impl Sessions {
    /// Pages of `browser`, each closed after `ttl` unused.
    #[must_use]
    pub fn new(browser: Arc<dyn Browser>, ttl: Duration) -> Self {
        Self {
            browser,
            ttl,
            table: Table::default(),
        }
    }

    /// Opens `url` in `key`'s page (made now if it has none) and reads it.
    ///
    /// # Errors
    /// What the browser says: see [`BrowserError`].
    pub async fn read(&self, key: &str, url: &str) -> Result<Read, BrowserError> {
        let held = self.held(key).await?;
        let mut guard = held.session.lock().await;
        let session = guard.as_mut().ok_or(BrowserError::Closed)?;
        let result = async {
            let page = session.navigate(url).await?;
            let text = session.text().await?;
            Ok(Read { page, text })
        }
        .await;
        *held.used.lock().unwrap_or_else(PoisonError::into_inner) = Instant::now();
        result
    }

    /// Closes `key`'s page. `false` when it had none.
    pub async fn close(&self, key: &str) -> bool {
        let taken = self.table.lock().await.remove(key);
        let Some(held) = taken else { return false };
        close_held(held).await;
        true
    }

    async fn held(&self, key: &str) -> Result<Arc<Held>, BrowserError> {
        let mut table = self.table.lock().await;
        if let Some(held) = table.get(key) {
            return Ok(Arc::clone(held));
        }
        if table.len() >= MAX_OPEN {
            return Err(BrowserError::Launch(
                "too many pages are open; close one first".to_owned(),
            ));
        }
        let session = self.browser.open().await?;
        let held = Arc::new(Held {
            session: tokio::sync::Mutex::new(Some(session)),
            used: Mutex::new(Instant::now()),
        });
        table.insert(key.to_owned(), Arc::clone(&held));
        tokio::spawn(reap(
            Arc::clone(&self.table),
            key.to_owned(),
            Arc::clone(&held),
            self.ttl,
        ));
        Ok(held)
    }
}

async fn close_held(held: Arc<Held>) {
    // A call still using the page finishes first, and the page is closed after it.
    let session = held.session.lock().await.take();
    if let Some(session) = session {
        session.close().await;
    }
}

/// Closes the page when it has not been used for `ttl`, or ends when someone else closed it.
async fn reap(table: Table, key: String, held: Arc<Held>, ttl: Duration) {
    loop {
        tokio::time::sleep(ttl).await;
        let mut guard = table.lock().await;
        if !guard.get(&key).is_some_and(|h| Arc::ptr_eq(h, &held)) {
            return;
        }
        let idle = held
            .used
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .elapsed();
        if idle >= ttl {
            guard.remove(&key);
            drop(guard);
            close_held(held).await;
            return;
        }
    }
}
