//! The window thread's message queue: what wakes the thread, and what reaches the pointer's
//! window.

use std::ptr::{null, null_mut};
use std::time::Duration;

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::Threading::INFINITE;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, MSG, MWMO_INPUTAVAILABLE, MsgWaitForMultipleObjectsEx, PM_NOREMOVE,
    PM_REMOVE, PeekMessageW, PostThreadMessageW, QS_ALLINPUT, TranslateMessage, WM_APP,
};

/// Posted to the window thread when a request is waiting for it.
pub const WAKE: u32 = WM_APP;

/// Gives the calling thread its message queue, which Windows creates only when a thread first
/// asks for a message: a wake posted to a thread without one is lost.
pub fn create_queue() {
    let mut message = MSG::default();
    unsafe { PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE) };
}

/// Wakes `thread`; false when it is gone.
pub fn wake(thread: u32) -> bool {
    unsafe { PostThreadMessageW(thread, WAKE, 0, 0) != 0 }
}

/// Sleeps until a message arrives or `timeout` passes; with no timeout, until a message
/// arrives. `queued` also returns at once for messages already waiting but not yet looked at,
/// which the thread's own loop wants; a pause inside a request must not spin on those it
/// leaves in the queue for that loop.
pub fn sleep_until_message(timeout: Option<Duration>, queued: bool) {
    let milliseconds = timeout.map_or(INFINITE, |timeout| {
        u32::try_from(timeout.as_millis()).unwrap_or(INFINITE - 1)
    });
    let flags = if queued { MWMO_INPUTAVAILABLE } else { 0 };
    unsafe { MsgWaitForMultipleObjectsEx(0, null(), milliseconds, QS_ALLINPUT, flags) };
}

/// Takes the next message for `window` — or for the whole thread, with a null window, which
/// includes the messages posted to the thread itself.
pub fn next(window: HWND) -> Option<MSG> {
    let mut message = MSG::default();
    (unsafe { PeekMessageW(&mut message, window, 0, 0, PM_REMOVE) } != 0).then_some(message)
}

pub fn dispatch(message: &MSG) {
    unsafe {
        TranslateMessage(message);
        DispatchMessageW(message);
    }
}

/// Windows ghosts a window whose thread has not looked at its queue for five seconds; typing
/// a long text keeps the thread busy longer. Looking is enough: nothing is taken.
pub fn stay_responsive() {
    create_queue();
}
