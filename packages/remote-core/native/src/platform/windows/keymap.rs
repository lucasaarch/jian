//! Keys as Windows virtual-key codes (winuser.h `VK_*`). Letters and digits use their
//! layout-independent codes — `A` is 0x41 on AZERTY too — which is what shortcuts match; text
//! is not pressed key by key but typed as the characters themselves.

use crate::keys::{Key, Modifiers, Named};

/// A virtual key, and whether Windows counts it among the extended keys: the arrows and the
/// navigation block sit beside the numeric keypad, and without the flag an app reading scan
/// codes sees the keypad's 4, 7 or 9 instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VirtualKey {
    pub code: u16,
    pub extended: bool,
}

const fn plain(code: u16) -> VirtualKey {
    VirtualKey {
        code,
        extended: false,
    }
}

const fn extended(code: u16) -> VirtualKey {
    VirtualKey {
        code,
        extended: true,
    }
}

pub const RETURN: VirtualKey = plain(0x0D);
pub const TAB: VirtualKey = plain(0x09);

pub fn virtual_key(key: Key) -> VirtualKey {
    match key {
        Key::Named(named) => match named {
            Named::Return => RETURN,
            Named::Tab => TAB,
            Named::Escape => plain(0x1B),
            Named::Backspace => plain(0x08),
            Named::Space => plain(0x20),
            Named::Delete => extended(0x2E),
            Named::PageUp => extended(0x21),
            Named::PageDown => extended(0x22),
            Named::End => extended(0x23),
            Named::Home => extended(0x24),
            Named::Left => extended(0x25),
            Named::Up => extended(0x26),
            Named::Right => extended(0x27),
            Named::Down => extended(0x28),
        },
        // VK_F1 to VK_F12 are contiguous.
        Key::Function(n) => plain(0x70 + u16::from(n.clamp(1, 12) - 1)),
        // `keys::parse_chord` admits only ASCII letters and digits, whose codes are their
        // uppercase ASCII values.
        Key::Char(c) => plain(c.to_ascii_uppercase() as u16),
    }
}

/// The modifiers a chord holds, in the order they go down; they come up in reverse. `cmd`
/// is the Windows key, as the PowerShell helper had it.
pub fn modifier_keys(modifiers: Modifiers) -> Vec<VirtualKey> {
    [
        (modifiers.control, plain(0x11)),
        (modifiers.option, plain(0x12)),
        (modifiers.shift, plain(0x10)),
        (modifiers.command, extended(0x5B)),
    ]
    .into_iter()
    .filter_map(|(held, key)| held.then_some(key))
    .collect()
}

/// One keystroke of typed text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stroke {
    /// Line breaks and tabs are the keys themselves: an editor reads a typed U+000A as nothing.
    Key(VirtualKey),
    /// A UTF-16 code unit, sent as itself whatever the keyboard layout; a character outside
    /// the BMP is its two surrogates, one after the other.
    Unit(u16),
}

pub fn strokes(text: &str) -> Vec<Stroke> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut strokes = Vec::with_capacity(units.len());
    let mut index = 0;
    while index < units.len() {
        strokes.push(match units[index] {
            // CRLF is one Return, not two.
            0x0D if units.get(index + 1) == Some(&0x0A) => {
                index += 1;
                Stroke::Key(RETURN)
            }
            0x0A | 0x0D => Stroke::Key(RETURN),
            0x09 => Stroke::Key(TAB),
            unit => Stroke::Unit(unit),
        });
        index += 1;
    }
    strokes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::parse_chord;

    fn key(spec: &str) -> VirtualKey {
        virtual_key(parse_chord(spec).unwrap().key)
    }

    #[test]
    fn shortcuts_press_the_layout_independent_codes() {
        assert_eq!(key("ctrl+c"), plain(b'C'.into()));
        assert_eq!(key("Z"), plain(b'Z'.into()));
        assert_eq!(key("7"), plain(b'7'.into()));
        assert_eq!(key("f1").code, 0x70);
        assert_eq!(key("f12").code, 0x7B);
        assert_eq!(key("enter"), RETURN);
        assert_eq!(key("esc").code, 0x1B);
    }

    #[test]
    fn navigation_keys_are_extended_and_the_main_block_is_not() {
        for spec in [
            "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
        ] {
            assert!(key(spec).extended, "{spec}");
        }
        assert_eq!(key("delete"), extended(0x2E));
        for spec in ["return", "tab", "space", "backspace", "a", "f5"] {
            assert!(!key(spec).extended, "{spec}");
        }
    }

    #[test]
    fn modifiers_go_down_in_a_fixed_order_with_cmd_as_the_windows_key() {
        let held = modifier_keys(parse_chord("cmd+shift+ctrl+alt+t").unwrap().modifiers);
        let codes: Vec<u16> = held.iter().map(|key| key.code).collect();
        assert_eq!(codes, [0x11, 0x12, 0x10, 0x5B]);
        assert!(held[3].extended);
        assert!(modifier_keys(parse_chord("t").unwrap().modifiers).is_empty());
    }

    #[test]
    fn typed_text_keeps_its_characters_and_turns_line_breaks_into_keys() {
        assert_eq!(
            strokes("a\r\nb\nc\rd\te"),
            [
                Stroke::Unit(u16::from(b'a')),
                Stroke::Key(RETURN),
                Stroke::Unit(u16::from(b'b')),
                Stroke::Key(RETURN),
                Stroke::Unit(u16::from(b'c')),
                Stroke::Key(RETURN),
                Stroke::Unit(u16::from(b'd')),
                Stroke::Key(TAB),
                Stroke::Unit(u16::from(b'e')),
            ]
        );
        // Accents are one unit; an emoji outside the BMP is its surrogate pair.
        assert_eq!(strokes("é"), [Stroke::Unit(0xE9)]);
        assert_eq!(
            strokes("\u{1F600}"),
            [Stroke::Unit(0xD83D), Stroke::Unit(0xDE00)]
        );
    }
}
