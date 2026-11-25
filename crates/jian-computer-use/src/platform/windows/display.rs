//! What Windows says about the displays, read fresh on every use: the user may change the
//! scale or plug a monitor in while a session runs.

use windows_sys::Win32::Foundation::POINT;
use windows_sys::Win32::Graphics::Gdi::{MONITOR_DEFAULTTOPRIMARY, MonitorFromPoint};
use windows_sys::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForMonitor, MDT_EFFECTIVE_DPI,
    SetProcessDpiAwarenessContext,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SM_CXSCREEN, SM_CXVIRTUALSCREEN, SM_CYSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SetProcessDPIAware,
};

use super::coords::{Desktop, Pixel, Scale};

/// Physical pixels from here on, on every monitor. It must come before the first window: a
/// process's awareness is fixed once it has one. Per-monitor v2 needs Windows 10 1703; before
/// it, system awareness is the same on a single monitor.
pub fn become_dpi_aware() {
    unsafe {
        if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) == 0 {
            SetProcessDPIAware();
        }
    }
}

/// The primary display: its size in physical pixels, and its scale.
#[derive(Debug, Clone, Copy)]
pub struct Primary {
    pub width: i32,
    pub height: i32,
    pub scale: Scale,
}

impl Primary {
    pub fn read() -> Result<Self, String> {
        let (width, height) =
            unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
        if width <= 0 || height <= 0 {
            return Err("no display available".into());
        }
        Ok(Self {
            width,
            height,
            scale: primary_scale(),
        })
    }
}

/// The primary display always holds the desktop's origin. Its effective DPI over 96 is the
/// scale the user picked in Settings; 1.0 when Windows will not say.
pub fn primary_scale() -> Scale {
    let mut dpi = (0, 0);
    let monitor = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
    let read = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi.0, &mut dpi.1) };
    if read < 0 || dpi.0 == 0 {
        Scale(1.0)
    } else {
        Scale(f64::from(dpi.0) / 96.0)
    }
}

pub fn desktop() -> Desktop {
    unsafe {
        Desktop {
            left: GetSystemMetrics(SM_XVIRTUALSCREEN),
            top: GetSystemMetrics(SM_YVIRTUALSCREEN),
            width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

/// Where the user's own cursor is.
pub fn cursor() -> Result<Pixel, String> {
    let mut at = POINT { x: 0, y: 0 };
    // Fails while another desktop has the input: the lock screen or a UAC prompt.
    if unsafe { GetCursorPos(&mut at) } == 0 {
        return Err("could not read the cursor; is the screen locked?".into());
    }
    Ok(Pixel { x: at.x, y: at.y })
}
