//! Windows: GDI reads the display, SendInput acts on it, and a layered window draws the pointer.
//!
//! Threads: a window belongs to the thread that created it, and only that thread's message
//! loop moves it, draws it and keeps Windows from ghosting it. So the main thread owns the
//! pointer's window and runs every request, and another thread reads stdin. That thread hands
//! each request over a channel and wakes the main thread with a thread message; the main thread
//! runs it and sends the answer back, in order, one at a time. Between requests the main thread
//! sleeps in its message loop, waking every frame while a click ripple plays out.

mod canvas;
mod capture;
mod coords;
mod display;
mod input;
mod keymap;
mod messages;
mod overlay;
mod pointer;
mod session;
mod surface;

use std::ptr::null_mut;
use std::sync::mpsc;

use serde_json::Value;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::WindowsAndMessaging::WM_QUIT;

pub use input::Windows;
use pointer::WinPointer;

use crate::Helper;
use crate::protocol::{Request, error};

/// Runs the helper: `serve` reads the requests and gets each answered, and when it returns the
/// process ends. The main thread stays in its message loop until then.
pub fn run(serve: impl FnOnce(&mut dyn FnMut(Request) -> Value) + Send + 'static) {
    display::become_dpi_aware();
    messages::create_queue();
    let thread = unsafe { GetCurrentThreadId() };
    let (requests, inbox) = mpsc::channel::<Request>();
    let (outbox, answers) = mpsc::channel::<Value>();

    std::thread::spawn(move || {
        serve(&mut |request| {
            if requests.send(request).is_err() || !messages::wake(thread) {
                return error("the helper's window thread has stopped");
            }
            answers
                .recv()
                .unwrap_or_else(|_| error("the helper's window thread has stopped"))
        });
        std::process::exit(0);
    });

    let pointer = WinPointer::new();
    let animation = pointer.animation();
    let mut helper = Helper::new(Windows, pointer);
    loop {
        messages::sleep_until_message(animation.next_frame(), true);
        animation.tick();
        while let Some(message) = messages::next(null_mut()) {
            match message.message {
                WM_QUIT => return,
                // Posted to the thread, not to a window: DispatchMessage would drop it.
                messages::WAKE if message.hwnd.is_null() => {
                    for request in inbox.try_iter() {
                        if outbox.send(helper.handle(request)).is_err() {
                            return;
                        }
                    }
                }
                _ => messages::dispatch(&message),
            }
        }
    }
}
