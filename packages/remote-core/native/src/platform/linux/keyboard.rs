//! Keys as X11 names them. XTest presses keycodes, and which keysym a keycode makes depends on
//! the user's layout, so each keysym is looked up in the current keyboard mapping. A character
//! the layout cannot type is bound for a moment to a keycode nothing uses — as xdotool does —
//! and the keycode is given back once the text is typed.

use std::thread::sleep;
use std::time::Duration;

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt, KEY_PRESS_EVENT, KEY_RELEASE_EVENT, Keycode, Keysym};
use x11rb::protocol::xtest;

use super::display::{Display, x_error};
use crate::keys::{Chord, Key, Named};

const NO_SYMBOL: Keysym = 0;
const SHIFT_L: Keysym = 0xFFE1;
const CONTROL_L: Keysym = 0xFFE3;
const ALT_L: Keysym = 0xFFE9;
const SUPER_L: Keysym = 0xFFEB;
const RETURN: Keysym = 0xFF0D;
const TAB: Keysym = 0xFF09;
/// Clients that fetch the keymap again after a change (GTK's XKB path) do it asynchronously:
/// a borrowed keycode keeps its keysym this long after its last press before it is reused or
/// given back, or the press would read as whatever the keycode means by then.
const SETTLE: Duration = Duration::from_millis(80);

/// The keysym a chord's key is, from X11's keysymdef.h.
pub fn key_keysym(key: Key) -> Keysym {
    match key {
        Key::Named(named) => match named {
            Named::Return => RETURN,
            Named::Tab => TAB,
            Named::Escape => 0xFF1B,
            Named::Delete => 0xFFFF,
            Named::Backspace => 0xFF08,
            Named::Space => 0x0020,
            Named::Left => 0xFF51,
            Named::Up => 0xFF52,
            Named::Right => 0xFF53,
            Named::Down => 0xFF54,
            Named::PageUp => 0xFF55,
            Named::PageDown => 0xFF56,
            Named::Home => 0xFF50,
            Named::End => 0xFF57,
        },
        // F1 is 0xFFBE and the rest follow it.
        Key::Function(n) => 0xFFBE + Keysym::from(n.clamp(1, 12) - 1),
        // ASCII letters and digits are their own keysyms.
        Key::Char(c) => c as Keysym,
    }
}

/// The modifiers held around a chord's key, in the order they go down.
pub fn modifier_keysyms(chord: Chord) -> Vec<Keysym> {
    let held = chord.modifiers;
    [
        (held.control, CONTROL_L),
        (held.option, ALT_L),
        (held.command, SUPER_L),
        (held.shift, SHIFT_L),
    ]
    .into_iter()
    .filter_map(|(on, keysym)| on.then_some(keysym))
    .collect()
}

/// The keysym that types `c`. Latin-1 keysyms are the code points themselves; everything else
/// has a Unicode keysym, 0x01000000 above its code point, which X clients read as that character.
pub fn char_keysym(c: char) -> Result<Keysym, String> {
    match c {
        '\n' | '\r' => Ok(RETURN),
        '\t' => Ok(TAB),
        ' '..='~' | '\u{A0}'..='\u{FF}' => Ok(c as Keysym),
        c if c.is_control() => Err(format!(
            "cannot type the control character U+{:04X}",
            c as u32
        )),
        c => Ok(0x0100_0000 + c as Keysym),
    }
}

/// The server's keyboard mapping: `per` keysyms for each keycode from `min`. The first two are
/// the key alone and with Shift; the rest belong to other groups and levels, which are left alone.
#[derive(Debug, Clone)]
pub struct Keymap {
    pub min: Keycode,
    pub per: usize,
    pub keysyms: Vec<Keysym>,
}

impl Keymap {
    /// The keycode that makes `keysym`, and whether Shift must be held for it.
    pub fn find(&self, keysym: Keysym) -> Option<(Keycode, bool)> {
        let per = self.per.max(1);
        for level in [0, 1].into_iter().take(per) {
            let found = self
                .keysyms
                .chunks(per)
                .position(|syms| syms[level] == keysym);
            if let Some(index) = found {
                return Some((self.keycode(index), level == 1));
            }
        }
        None
    }

    /// Keycodes the layout leaves empty, which may be borrowed.
    pub fn spare(&self) -> Vec<Keycode> {
        self.keysyms
            .chunks(self.per.max(1))
            .enumerate()
            .filter(|(_, syms)| syms.iter().all(|sym| *sym == NO_SYMBOL))
            .map(|(index, _)| self.keycode(index))
            .collect()
    }

    pub fn set(&mut self, keycode: Keycode, keysym: Keysym) {
        let start = usize::from(keycode - self.min) * self.per;
        self.keysyms[start..start + self.per].fill(keysym);
    }

    fn keycode(&self, index: usize) -> Keycode {
        self.min + index as Keycode
    }
}

/// Presses keys through XTest for one request, then gives back any keycode it borrowed.
pub struct Keyboard<'a> {
    display: &'a Display,
    keymap: Keymap,
    spare: Vec<Keycode>,
    /// Borrowed keycodes, oldest first; reused in this order when none are left.
    borrowed: Vec<Keycode>,
}

impl<'a> Keyboard<'a> {
    pub fn new(display: &'a Display) -> Result<Self, String> {
        let setup = display.conn.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let reply = display
            .conn
            .get_keyboard_mapping(min, max - min + 1)
            .map_err(x_error)?
            .reply()
            .map_err(x_error)?;
        let keymap = Keymap {
            min,
            per: usize::from(reply.keysyms_per_keycode),
            keysyms: reply.keysyms,
        };
        let mut spare = keymap.spare();
        // Taken from the top, where layouts leave the most room, as xdotool does.
        spare.reverse();
        Ok(Self {
            display,
            keymap,
            spare,
            borrowed: Vec::new(),
        })
    }

    /// Presses and releases `keysym`, holding Shift when the layout puts it there.
    pub fn tap(&mut self, keysym: Keysym) -> Result<(), String> {
        let keycodes = match (self.keymap.find(keysym), self.keymap.find(SHIFT_L)) {
            (Some((keycode, false)), _) => vec![keycode],
            (Some((keycode, true)), Some((shift, false))) => vec![shift, keycode],
            // Not on the layout, or only behind a Shift it lacks: a key of its own.
            _ => vec![self.borrow(keysym)?],
        };
        self.press(&keycodes)
    }

    /// Holds each keysym down in order, then lets them go in reverse. A key the layout lacks is
    /// borrowed; a modifier it lacks would be a key without its modifier, which no layout has.
    pub fn chord(&mut self, keysyms: &[Keysym]) -> Result<(), String> {
        let keycodes = keysyms
            .iter()
            .map(|keysym| match self.keymap.find(*keysym) {
                Some((keycode, _)) => Ok(keycode),
                None => self.borrow(*keysym),
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.press(&keycodes)
    }

    /// Gives back what was borrowed, once clients have read the keys typed with it.
    pub fn finish(mut self) -> Result<(), String> {
        if self.borrowed.is_empty() {
            return Ok(());
        }
        self.display.flush()?;
        sleep(SETTLE);
        for keycode in std::mem::take(&mut self.borrowed) {
            self.bind(keycode, NO_SYMBOL)?;
        }
        self.display.flush()
    }

    fn press(&self, keycodes: &[Keycode]) -> Result<(), String> {
        for keycode in keycodes {
            self.fake(KEY_PRESS_EVENT, *keycode)?;
        }
        for keycode in keycodes.iter().rev() {
            self.fake(KEY_RELEASE_EVENT, *keycode)?;
        }
        self.display.flush()
    }

    /// Binds `keysym` to a free keycode for the rest of this request.
    fn borrow(&mut self, keysym: Keysym) -> Result<Keycode, String> {
        let keycode = match self.spare.pop() {
            Some(keycode) => keycode,
            None => {
                if self.borrowed.is_empty() {
                    return Err("the keyboard layout has no free keycode to type with".into());
                }
                // Out of room: the oldest borrowed keycode, once its last press has been read.
                let keycode = self.borrowed.remove(0);
                self.display.flush()?;
                sleep(SETTLE);
                keycode
            }
        };
        self.bind(keycode, keysym)?;
        self.borrowed.push(keycode);
        Ok(keycode)
    }

    fn bind(&mut self, keycode: Keycode, keysym: Keysym) -> Result<(), String> {
        self.keymap.set(keycode, keysym);
        // Every level the same keysym, so Shift or Caps Lock held by the user changes nothing.
        let keysyms = vec![keysym; self.keymap.per];
        self.display
            .conn
            .change_keyboard_mapping(1, keycode, self.keymap.per as u8, &keysyms)
            .map_err(x_error)?;
        Ok(())
    }

    fn fake(&self, kind: u8, keycode: Keycode) -> Result<(), String> {
        let root = self.display.root;
        xtest::fake_input(&self.display.conn, kind, keycode, 0, root, 0, 0, 0).map_err(x_error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::parse_chord;

    #[test]
    fn chords_press_the_keysyms_x11_names() {
        let chord = parse_chord("ctrl+shift+t").unwrap();
        assert_eq!(key_keysym(chord.key), 't' as Keysym);
        assert_eq!(modifier_keysyms(chord), [CONTROL_L, SHIFT_L]);
        let chord = parse_chord("cmd+alt+f12").unwrap();
        assert_eq!(key_keysym(chord.key), 0xFFC9);
        assert_eq!(modifier_keysyms(chord), [ALT_L, SUPER_L]);
        assert_eq!(key_keysym(parse_chord("pagedown").unwrap().key), 0xFF56);
        assert_eq!(key_keysym(parse_chord("backspace").unwrap().key), 0xFF08);
        assert_eq!(key_keysym(parse_chord("delete").unwrap().key), 0xFFFF);
    }

    #[test]
    fn text_maps_to_latin1_or_unicode_keysyms() {
        assert_eq!(char_keysym('a'), Ok(0x61));
        assert_eq!(char_keysym('ç'), Ok(0xE7));
        assert_eq!(char_keysym('ã'), Ok(0xE3));
        assert_eq!(char_keysym('✓'), Ok(0x0100_2713));
        assert_eq!(char_keysym('😀'), Ok(0x0101_F600));
        assert_eq!(char_keysym('\n'), Ok(RETURN));
        assert!(char_keysym('\u{7}').is_err());
    }

    fn us_keymap() -> Keymap {
        // Keycodes 8..=12: a/A, 1/!, an empty key, Shift_L, another empty key.
        Keymap {
            min: 8,
            per: 2,
            keysyms: vec![0x61, 0x41, 0x31, 0x21, 0, 0, SHIFT_L, 0, 0, 0],
        }
    }

    #[test]
    fn finds_the_key_and_whether_it_needs_shift() {
        let keymap = us_keymap();
        assert_eq!(keymap.find(0x61), Some((8, false)));
        assert_eq!(keymap.find(0x41), Some((8, true)));
        assert_eq!(keymap.find(0x21), Some((9, true)));
        assert_eq!(keymap.find(SHIFT_L), Some((11, false)));
        assert_eq!(keymap.find(0xE7), None);
    }

    #[test]
    fn borrows_only_keys_the_layout_leaves_empty() {
        let mut keymap = us_keymap();
        assert_eq!(keymap.spare(), [10, 12]);
        keymap.set(12, 0xE7);
        assert_eq!(keymap.find(0xE7), Some((12, false)));
        assert_eq!(keymap.spare(), [10]);
    }
}
