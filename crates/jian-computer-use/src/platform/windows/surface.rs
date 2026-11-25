//! A 32-bit pixel buffer GDI can draw into and read from: a top-down DIB section selected into
//! a memory DC of its own. The capture draws the screen into one; the pointer is blended onto
//! the screen from another.

use std::ptr::null_mut;

use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS,
    DeleteDC, DeleteObject, GdiFlush, HBITMAP, HDC, HGDIOBJ, SelectObject,
};

pub struct Surface {
    dc: HDC,
    bitmap: HBITMAP,
    /// What the DC held before the bitmap, put back before either is deleted.
    previous: HGDIOBJ,
    bits: *mut u8,
    width: i32,
    height: i32,
}

impl Surface {
    pub fn new(width: i32, height: i32) -> Result<Self, String> {
        if width <= 0 || height <= 0 {
            return Err(format!("cannot draw a {width} x {height} surface"));
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative: rows run top to bottom, as Frame and the pointer's canvas have them.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..Default::default()
            },
            ..Default::default()
        };
        // SAFETY: a null device context means one compatible with the screen; a null result is checked next.
        let dc = unsafe { CreateCompatibleDC(null_mut()) };
        if dc.is_null() {
            return Err("could not create a drawing context".into());
        }
        let mut bits = null_mut();
        // SAFETY: `dc` is live, and `info` and `bits` are locals that outlive the call; a null result is checked next.
        let bitmap = unsafe {
            CreateDIBSection(
                dc,
                &raw const info,
                DIB_RGB_COLORS,
                &raw mut bits,
                null_mut(),
                0,
            )
        };
        if bitmap.is_null() || bits.is_null() {
            // SAFETY: `dc` was created above and is deleted once on this failure path.
            unsafe { DeleteDC(dc) };
            return Err(format!("could not allocate a {width} x {height} bitmap"));
        }
        // SAFETY: `dc` and `bitmap` are live and not selected anywhere else.
        let previous = unsafe { SelectObject(dc, bitmap) };
        Ok(Self {
            dc,
            bitmap,
            previous,
            bits: bits.cast(),
            width,
            height,
        })
    }

    pub fn dc(&self) -> HDC {
        self.dc
    }

    pub fn width(&self) -> i32 {
        self.width
    }

    pub fn height(&self) -> i32 {
        self.height
    }

    /// The pixels as BGRA rows. GDI batches its drawing, so it is flushed first.
    pub fn pixels(&self) -> &[u8] {
        // SAFETY: `bits` points at `len()` bytes of the section that lives as long as `self`; `GdiFlush` makes
        // the pending drawing land first.
        unsafe {
            GdiFlush();
            std::slice::from_raw_parts(self.bits, self.len())
        }
    }

    pub fn pixels_mut(&mut self) -> &mut [u8] {
        // SAFETY: `bits` points at `len()` bytes of the section that lives as long as `self`, and `&mut self` is
        // the only way to it.
        unsafe {
            GdiFlush();
            std::slice::from_raw_parts_mut(self.bits, self.len())
        }
    }

    fn len(&self) -> usize {
        self.width as usize * self.height as usize * 4
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        // SAFETY: these handles were created by `Surface::new`, and `drop` releases each one once.
        unsafe {
            SelectObject(self.dc, self.previous);
            DeleteObject(self.bitmap);
            DeleteDC(self.dc);
        }
    }
}
