//! The window the pointer is drawn in: layered, so each pixel has its own alpha and the glow
//! fades into whatever is beneath; transparent to the mouse, so clicks reach that instead;
//! topmost, never activated and off the taskbar and Alt+Tab, so the user's focus stays put.

use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{AC_SRC_ALPHA, AC_SRC_OVER, BLENDFUNCTION};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, HTTRANSPARENT, HWND_TOPMOST, MA_NOACTIVATE,
    RegisterClassExW, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER,
    SWP_NOSIZE, SetWindowPos, ShowWindow, ULW_ALPHA, UpdateLayeredWindow, WM_MOUSEACTIVATE,
    WM_NCHITTEST, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_EX_TRANSPARENT, WS_POPUP,
};

use super::surface::Surface;

/// The window class, as a NUL-terminated UTF-16 string.
const CLASS: [u16; 18] = utf16("JianRemotePointer");

pub struct Overlay {
    window: HWND,
    /// The last frame, kept at the canvas's size; replaced when the display's scale changes.
    surface: Option<Surface>,
}

impl Overlay {
    /// Must run on the thread that pumps the window's messages; the window belongs to it.
    pub fn new() -> Result<Self, String> {
        let instance = unsafe { GetModuleHandleW(null()) };
        let class = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            lpszClassName: CLASS.as_ptr(),
            ..Default::default()
        };
        // Zero also when the class exists already, which CreateWindowExW then uses.
        unsafe { RegisterClassExW(&class) };
        let window = unsafe {
            CreateWindowExW(
                WS_EX_LAYERED
                    | WS_EX_TRANSPARENT
                    | WS_EX_TOPMOST
                    | WS_EX_TOOLWINDOW
                    | WS_EX_NOACTIVATE,
                CLASS.as_ptr(),
                CLASS.as_ptr(),
                WS_POPUP,
                0,
                0,
                0,
                0,
                null_mut(),
                null_mut(),
                instance,
                null(),
            )
        };
        if window.is_null() {
            return Err("could not create the pointer window".into());
        }
        Ok(Self {
            window,
            surface: None,
        })
    }

    /// Puts `pixels` — `side` x `side` premultiplied BGRA rows — on screen with its top-left at
    /// `origin`, in physical pixels, at `opacity` over all.
    pub fn present(
        &mut self,
        pixels: &[u8],
        side: i32,
        origin: (i32, i32),
        opacity: f64,
    ) -> Result<(), String> {
        if self.surface.as_ref().is_none_or(|s| s.width() != side) {
            self.surface = Some(Surface::new(side, side)?);
        }
        let surface = self.surface.as_mut().expect("set above");
        surface.pixels_mut().copy_from_slice(pixels);
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: (opacity.clamp(0.0, 1.0) * 255.0).round() as u8,
            // Per-pixel alpha, which ULW_ALPHA wants premultiplied.
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let updated = unsafe {
            UpdateLayeredWindow(
                self.window,
                null_mut(),
                &POINT {
                    x: origin.0,
                    y: origin.1,
                },
                &SIZE { cx: side, cy: side },
                surface.dc(),
                &POINT { x: 0, y: 0 },
                0,
                &blend,
                ULW_ALPHA,
            )
        };
        if updated == 0 {
            return Err("could not draw the pointer".into());
        }
        Ok(())
    }

    pub fn show(&self) {
        unsafe {
            ShowWindow(self.window, SW_SHOWNOACTIVATE);
            // Again on every show: another topmost window may have come above it since.
            SetWindowPos(
                self.window,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            );
        }
    }

    pub fn hide(&self) {
        unsafe { ShowWindow(self.window, SW_HIDE) };
    }

    pub fn window(&self) -> HWND {
        self.window
    }
}

impl Drop for Overlay {
    fn drop(&mut self) {
        self.surface = None;
        unsafe { DestroyWindow(self.window) };
    }
}

/// WS_EX_TRANSPARENT already lets the mouse through; these hold if a message reaches it
/// anyway, so it never activates and never claims a click.
unsafe extern "system" fn window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_MOUSEACTIVATE => MA_NOACTIVATE as LRESULT,
        WM_NCHITTEST => HTTRANSPARENT as LRESULT,
        _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}

/// ASCII as UTF-16, with room for the NUL that ends it.
const fn utf16<const N: usize>(text: &str) -> [u16; N] {
    let bytes = text.as_bytes();
    assert!(bytes.len() < N);
    let mut out = [0; N];
    let mut i = 0;
    while i < bytes.len() {
        out[i] = bytes[i] as u16;
        i += 1;
    }
    out
}
