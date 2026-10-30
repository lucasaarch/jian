//! Whether the user's desktop is the one taking input. Windows switches to another desktop
//! for the lock screen, Ctrl+Alt+Del and UAC prompts, and input sent meanwhile goes nowhere.

use windows_sys::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_READOBJECTS, GetUserObjectInformationW, OpenInputDesktop, UOI_NAME,
};

/// The user's desktop is called `Default`; Winlogon's and the secure desktop are not, and a
/// user's process cannot even open them, so failing to is read as locked too.
pub fn locked() -> bool {
    let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
    if desktop.is_null() {
        return true;
    }
    let mut name = [0u16; 64];
    let mut needed = 0;
    let read = unsafe {
        GetUserObjectInformationW(
            desktop,
            UOI_NAME,
            name.as_mut_ptr().cast(),
            size_of_val(&name) as u32,
            &mut needed,
        )
    };
    unsafe { CloseDesktop(desktop) };
    let length = name
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(name.len());
    read == 0 || !String::from_utf16_lossy(&name[..length]).eq_ignore_ascii_case("Default")
}
