//! The agent's browser: open a page in an isolated context, read it, draw it.
//!
//! The browser is a program beside the gateway that speaks the Chrome `DevTools` Protocol: Obscura
//! (a small Rust and V8 engine, the default) and Chromium (the fallback for a site that does not
//! run in Obscura). The gateway does not link V8: it starts the program when a run first needs a
//! page, talks to it over a WebSocket and stops it when it has been idle.
//!
//! What is here: the [`Browser`] and [`Session`] traits; [`CdpBrowser`], which implements both
//! engines over one small CDP client (`cdp`), because they differ only in how they are started
//! and how a private network is refused; [`WithFallback`], which retries on the second engine
//! when the first one cannot run a site; and [`discover`], which finds a binary.
//!
//! What is not here: where the binary comes from or what a person may ask for (the binary that
//! wires the gateway reads the configuration and builds the [`EngineConfig`]), and the agent's
//! tools (`jian-runtime`). Nothing here reads the environment.
//!
//! One program serves the whole gateway. Every [`Browser::open`] makes its own browser context,
//! with its own cookies and storage, and a context is never handed to a second caller, so two
//! tenants never share a page.

mod cdp;
mod discover;
mod engine;
mod error;
mod fallback;
mod gate;
mod process;
mod render;
mod session;
mod sessions;

use futures_util::future::BoxFuture;

pub use discover::discover;
pub use engine::{CdpBrowser, Engine, EngineConfig};
pub use error::BrowserError;
pub use fallback::WithFallback;
pub use gate::NetworkPolicy;
pub use render::{Format, render};
pub use sessions::{Read, Sessions};

/// How long a page may take to load, in milliseconds. A site that has not fired its `load` event
/// by then is reported as a network failure, not as one that cannot run here: waiting longer
/// would not change on the second engine.
pub const NAVIGATION_TIMEOUT_MS: u64 = 30_000;

/// How long a single `DevTools` command may take, in milliseconds. Above the navigation timeout,
/// so a slow load is cut by that one and not by this.
pub const COMMAND_TIMEOUT_MS: u64 = 45_000;

/// How long the program may take to start and answer, in milliseconds.
pub const LAUNCH_TIMEOUT_MS: u64 = 15_000;

/// How long the program stays up with no page open before it is stopped, in seconds. A fresh
/// start costs a second or two, and a Chromium that idles costs a few hundred megabytes.
pub const IDLE_SECONDS: u64 = 120;

/// The most characters of text a page gives back. The agent reads far less; this stops a huge
/// page from filling the gateway's memory.
pub const MAX_TEXT_CHARS: usize = 200_000;

/// The widest and tallest a screenshot is, in pixels. Larger images are refused by the models
/// that read them.
pub const MAX_SCREENSHOT_SIDE: u32 = 1600;

/// The window every page is drawn in, in CSS pixels: under [`MAX_SCREENSHOT_SIDE`].
pub const VIEWPORT: (u32, u32) = (1280, 800);

/// The largest PDF accepted, in bytes.
pub const MAX_PDF_BYTES: usize = 50 * 1024 * 1024;

/// A page after it loaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page {
    /// Where it ended, after redirects.
    pub url: String,
    /// Its title, empty when it has none.
    pub title: String,
}

/// An engine that can open isolated pages.
pub trait Browser: Send + Sync {
    /// The engine's name, for logs and for what the agent is told.
    fn engine(&self) -> &'static str;

    /// A new page in a new browser context: its cookies, storage and cache are its own and are
    /// gone when it closes. Starts the program if it is not running.
    fn open(&self) -> BoxFuture<'_, Result<Box<dyn Session>, BrowserError>>;
}

/// One page in its own context.
pub trait Session: Send {
    /// Loads `url` (http, https or a `data:` document) and waits for it to finish loading.
    fn navigate<'a>(&'a mut self, url: &'a str) -> BoxFuture<'a, Result<Page, BrowserError>>;

    /// The text a person would read on the page, at most [`MAX_TEXT_CHARS`] characters.
    fn text(&mut self) -> BoxFuture<'_, Result<String, BrowserError>>;

    /// The window as a PNG, no side over [`MAX_SCREENSHOT_SIDE`].
    fn screenshot(&mut self) -> BoxFuture<'_, Result<Vec<u8>, BrowserError>>;

    /// The page as a PDF.
    fn pdf(&mut self) -> BoxFuture<'_, Result<Vec<u8>, BrowserError>>;

    /// Closes the page and throws its context away.
    fn close(self: Box<Self>) -> BoxFuture<'static, ()>;
}
