//! Which windows the helper may drive. Windows drops input sent to a window whose process runs
//! at a higher integrity level than the sender's (UIPI): an app started as administrator, seen
//! from a worker that was not. `SendInput` reports success all the same, so the only way to tell
//! the agent that nothing happened is to compare the two levels before sending.

use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND, POINT};
use windows_sys::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TOKEN_MANDATORY_LABEL,
    TOKEN_QUERY, TokenIntegrityLevel,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, WindowFromPoint,
};

use super::coords::Pixel;

/// The window typed keys go to.
pub fn keyboard_target() -> HWND {
    // SAFETY: `GetForegroundWindow` takes nothing; a null result is a window that is gone, which callers handle.
    unsafe { GetForegroundWindow() }
}

/// The window a click at `pixel` goes to. The pointer's own windows let the mouse through, so
/// they are never the answer.
pub fn window_at(pixel: Pixel) -> HWND {
    // SAFETY: `WindowFromPoint` takes a point by value; a null result is handled by the caller.
    unsafe {
        WindowFromPoint(POINT {
            x: pixel.x,
            y: pixel.y,
        })
    }
}

/// Whether `window` belongs to a process above the helper's own integrity level. False when
/// either level cannot be read: a refusal has to be certain, since it stops the agent.
pub fn out_of_reach(window: HWND) -> bool {
    if window.is_null() {
        return false;
    }
    let mut process_id = 0;
    // SAFETY: `window` is a handle that may be stale, which the call reports as zero; `process_id` is a local.
    unsafe { GetWindowThreadProcessId(window, &raw mut process_id) };
    if process_id == 0 {
        return false;
    }
    // SAFETY: `OpenProcess` takes plain values; a null handle is checked next.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if process.is_null() {
        return false;
    }
    let theirs = level(process);
    // SAFETY: `process` was opened above and is closed once.
    unsafe { CloseHandle(process) };
    // SAFETY: `GetCurrentProcess` returns a pseudo-handle that needs no closing.
    let ours = level(unsafe { GetCurrentProcess() });
    matches!((theirs, ours), (Some(theirs), Some(ours)) if theirs > ours)
}

/// A process's integrity level: 0x2000 for a normal app, 0x3000 for one run as administrator.
fn level(process: HANDLE) -> Option<u32> {
    let mut token = null_mut();
    // SAFETY: `process` is a handle the caller holds and `token` is a local the call fills in.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &raw mut token) } == 0 {
        return None;
    }
    // A TOKEN_MANDATORY_LABEL and, after it, the SID it points at; u64s keep both aligned.
    let mut buffer = [0u64; 16];
    let mut written = 0;
    // SAFETY: `token` is open, and `buffer` is a live, aligned local of the length passed.
    let read = unsafe {
        GetTokenInformation(
            token,
            TokenIntegrityLevel,
            buffer.as_mut_ptr().cast(),
            size_of_val(&buffer) as u32,
            &raw mut written,
        )
    };
    // SAFETY: `token` was opened above and is closed once.
    unsafe { CloseHandle(token) };
    if read == 0 {
        return None;
    }
    // The level is the SID's last sub-authority.
    // SAFETY: `read` was not zero, so `buffer` holds a `TOKEN_MANDATORY_LABEL` whose SID points inside it;
    // the sub-authority index is checked against the count the system returns.
    unsafe {
        let sid = (*buffer.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()).Label.Sid;
        let count = *GetSidSubAuthorityCount(sid);
        (count > 0).then(|| *GetSidSubAuthority(sid, u32::from(count) - 1))
    }
}
