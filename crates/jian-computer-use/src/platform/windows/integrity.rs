//! Which windows the helper may drive. Windows drops input sent to a window whose process runs
//! at a higher integrity level than the sender's (UIPI): an app started as administrator, seen
//! from a worker that was not. SendInput reports success all the same, so the only way to tell
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
    unsafe { GetForegroundWindow() }
}

/// The window a click at `pixel` goes to. The pointer's own windows let the mouse through, so
/// they are never the answer.
pub fn window_at(pixel: Pixel) -> HWND {
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
    unsafe { GetWindowThreadProcessId(window, &mut process_id) };
    if process_id == 0 {
        return false;
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if process.is_null() {
        return false;
    }
    let theirs = level(process);
    unsafe { CloseHandle(process) };
    let ours = level(unsafe { GetCurrentProcess() });
    matches!((theirs, ours), (Some(theirs), Some(ours)) if theirs > ours)
}

/// A process's integrity level: 0x2000 for a normal app, 0x3000 for one run as administrator.
fn level(process: HANDLE) -> Option<u32> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    // A TOKEN_MANDATORY_LABEL and, after it, the SID it points at; u64s keep both aligned.
    let mut buffer = [0u64; 16];
    let mut written = 0;
    let read = unsafe {
        GetTokenInformation(
            token,
            TokenIntegrityLevel,
            buffer.as_mut_ptr().cast(),
            size_of_val(&buffer) as u32,
            &mut written,
        )
    };
    unsafe { CloseHandle(token) };
    if read == 0 {
        return None;
    }
    // The level is the SID's last sub-authority.
    unsafe {
        let sid = (*buffer.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()).Label.Sid;
        let count = *GetSidSubAuthorityCount(sid);
        (count > 0).then(|| *GetSidSubAuthority(sid, u32::from(count) - 1))
    }
}
