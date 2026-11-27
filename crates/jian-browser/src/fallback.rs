//! The second engine, tried only for a site the first one cannot run.
//!
//! A page is opened on the primary engine. When it fails in a way that says "this engine cannot
//! run the site" ([`BrowserError::runs_elsewhere`]) or loads and gives back next to no text, the
//! same address is opened on the fallback and the call is made again there. A blocked address, an
//! unreachable site and a timeout are not retried: the other engine would see the same, and a
//! second try on Chromium of a refused private address would only cost a start.

use std::sync::Arc;

use futures_util::future::BoxFuture;

use crate::{Browser, BrowserError, Page, Session};

/// Fewer characters than this from a page that loaded is taken as "the engine drew nothing": a
/// script it could not run left an empty shell. The page is tried on the fallback once.
const MIN_USEFUL_TEXT_CHARS: usize = 20;

/// An engine with a second one behind it.
pub struct WithFallback {
    primary: Arc<dyn Browser>,
    fallback: Option<Arc<dyn Browser>>,
}

impl WithFallback {
    /// `primary`, and `fallback` for what it cannot run. With no fallback it is `primary`.
    #[must_use]
    pub fn new(primary: Arc<dyn Browser>, fallback: Option<Arc<dyn Browser>>) -> Self {
        Self { primary, fallback }
    }
}

impl Browser for WithFallback {
    fn engine(&self) -> &'static str {
        self.primary.engine()
    }

    fn open(&self) -> BoxFuture<'_, Result<Box<dyn Session>, BrowserError>> {
        Box::pin(async move {
            let current = self.primary.open().await;
            match (current, &self.fallback) {
                (Ok(current), fallback) => Ok(Box::new(Fallback {
                    current,
                    second: fallback.clone(),
                    url: None,
                }) as Box<dyn Session>),
                // The primary will not even start (no program, a crash): the fallback is the
                // browser, and there is no second one behind it.
                (Err(error), Some(fallback))
                    if error.runs_elsewhere() || matches!(error, BrowserError::Launch(_)) =>
                {
                    tracing::warn!(%error, "the first browser did not open; using the second");
                    fallback.open().await
                }
                (Err(error), _) => Err(error),
            }
        })
    }
}

struct Fallback {
    current: Box<dyn Session>,
    /// The second engine while this session has not moved to it; `None` after.
    second: Option<Arc<dyn Browser>>,
    /// The last address opened, to open again on the second engine.
    url: Option<String>,
}

impl Fallback {
    /// Moves the page to the second engine. `false` when there is none, or nothing was opened.
    async fn switch(&mut self, why: &BrowserError) -> Result<bool, BrowserError> {
        let (Some(fallback), Some(url)) = (self.second.take(), self.url.clone()) else {
            return Ok(false);
        };
        tracing::info!(%why, %url, to = fallback.engine(), "the page does not run here; trying the other browser");
        let next = fallback.open().await?;
        let old = std::mem::replace(&mut self.current, next);
        old.close().await;
        self.current.navigate(&url).await?;
        Ok(true)
    }
}

impl Session for Fallback {
    fn navigate<'a>(&'a mut self, url: &'a str) -> BoxFuture<'a, Result<Page, BrowserError>> {
        Box::pin(async move {
            self.url = Some(url.to_owned());
            match self.current.navigate(url).await {
                Err(error) if error.runs_elsewhere() && self.second.is_some() => {
                    self.switch(&error).await?;
                    self.current.navigate(url).await
                }
                other => other,
            }
        })
    }

    fn text(&mut self) -> BoxFuture<'_, Result<String, BrowserError>> {
        Box::pin(async move {
            let first = self.current.text().await;
            let retry = match &first {
                Err(error) => error.runs_elsewhere().then(|| error.to_string()),
                Ok(text) if text.trim().chars().count() < MIN_USEFUL_TEXT_CHARS => {
                    Some("the page came back almost empty".to_owned())
                }
                Ok(_) => None,
            };
            let Some(why) = retry else { return first };
            if !self.switch(&BrowserError::Unsupported(why)).await? {
                return first;
            }
            let second = self.current.text().await?;
            // An empty page on both engines is an empty page: the longer text is the answer.
            Ok(match first {
                Ok(first) if first.len() > second.len() => first,
                _ => second,
            })
        })
    }

    fn screenshot(&mut self) -> BoxFuture<'_, Result<Vec<u8>, BrowserError>> {
        Box::pin(async move {
            let first = self.current.screenshot().await;
            if let Err(error) = &first
                && error.runs_elsewhere()
                && self.switch(error).await?
            {
                return self.current.screenshot().await;
            }
            first
        })
    }

    fn pdf(&mut self) -> BoxFuture<'_, Result<Vec<u8>, BrowserError>> {
        Box::pin(async move {
            let first = self.current.pdf().await;
            if let Err(error) = &first
                && error.runs_elsewhere()
                && self.switch(error).await?
            {
                return self.current.pdf().await;
            }
            first
        })
    }

    fn close(self: Box<Self>) -> BoxFuture<'static, ()> {
        self.current.close()
    }
}
