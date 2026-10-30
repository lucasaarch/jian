//! The one connection to the X server, opened on first use and shared by input, capture and the
//! pointer, including the pointer's ripple thread: x11rb's pure-Rust connection is `Sync`.

use std::sync::OnceLock;

use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::Event;
use x11rb::protocol::xproto::{Screen, Window};
use x11rb::protocol::{shape, xfixes, xtest};
use x11rb::rust_connection::RustConnection;

pub struct Display {
    pub conn: RustConnection,
    pub screen: usize,
    pub root: Window,
    /// Input needs it; without it every action fails with a clear message instead.
    pub xtest: bool,
    /// Click-through for the pointer; without it there is no pointer, input still works.
    pub shape: bool,
    /// Hides the user's cursor while an action borrows it.
    pub xfixes: bool,
}

/// Opened once: a helper that could not reach the display says why on every request.
static DISPLAY: OnceLock<Result<Display, String>> = OnceLock::new();

pub fn display() -> Result<&'static Display, String> {
    DISPLAY.get_or_init(connect).as_ref().map_err(Clone::clone)
}

/// Throws away what the server sent unasked. Nothing here selects events, but MappingNotify
/// reaches every client after `type` borrows a keycode, and errors of unchecked requests land
/// here too: logged, so a failed draw is visible without failing the action.
pub fn drain() {
    let Some(Ok(display)) = DISPLAY.get() else {
        return;
    };
    while let Ok(Some(event)) = display.conn.poll_for_event() {
        if let Event::Error(error) = event {
            eprintln!("computer-helper: X error {error:?}");
        }
    }
}

impl Display {
    pub fn screen(&self) -> &Screen {
        &self.conn.setup().roots[self.screen]
    }

    pub fn flush(&self) -> Result<(), String> {
        self.conn.flush().map_err(x_error)
    }
}

fn connect() -> Result<Display, String> {
    let name = std::env::var("DISPLAY").unwrap_or_default();
    if name.is_empty() {
        return Err("DISPLAY is not set. Computer use needs an X11 graphical session.".into());
    }
    let (conn, screen) = RustConnection::connect(None)
        .map_err(|error| format!("Could not open the X display {name}: {error}"))?;
    let root = conn.setup().roots[screen].root;
    let has = |name: &'static str| matches!(conn.extension_information(name), Ok(Some(_)));
    let (xtest, shape) = (
        has(xtest::X11_EXTENSION_NAME),
        has(shape::X11_EXTENSION_NAME),
    );
    // XFixes refuses every request from a client that has not said which version it speaks.
    let xfixes = has(xfixes::X11_EXTENSION_NAME)
        && xfixes::query_version(&conn, 4, 0)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .is_some_and(|reply| reply.major_version >= 4);
    Ok(Display {
        conn,
        screen,
        root,
        xtest,
        shape,
        xfixes,
    })
}

pub fn x_error(error: impl std::fmt::Display) -> String {
    format!("X server: {error}")
}
