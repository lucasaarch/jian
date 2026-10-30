//! Linux (X11, or XWayland): one pure-Rust connection to the X server reads the display, posts
//! input through XTest and draws the pointer. Nothing in X11 is tied to a thread, so requests
//! are answered on the thread that reads them.
//!
//! Under XWayland only XWayland apps can be seen and driven. A native Wayland backend would sit
//! beside this one, chosen from XDG_SESSION_TYPE behind the same traits: portals (ScreenCast,
//! RemoteDesktop with libei) on GNOME and KDE, wlroots protocols elsewhere, and layer-shell for
//! the pointer, which GNOME does not offer. apps/remote-control/README.md has the details; it is
//! open for someone who can test on a Wayland desktop.

mod display;
mod input;
mod keyboard;
mod pixels;
mod pointer;
mod sprite;

use serde_json::Value;

pub use input::Linux;
use pointer::LinuxPointer;

use crate::Helper;
use crate::protocol::Request;

/// Runs the helper: `serve` reads the requests and gets each answered, and when it returns the
/// process ends, and the X server takes the pointer's window with it.
pub fn run(serve: impl FnOnce(&mut dyn FnMut(Request) -> Value) + Send + 'static) {
    let mut helper = Helper::new(Linux, LinuxPointer::default());
    serve(&mut |request| {
        let reply = helper.handle(request);
        display::drain();
        reply
    });
}
