//! Key chords as the agent writes them — `cmd+shift+t`, `Return`, `f5` — read once for every
//! OS. Each platform only maps the result to its own key codes.

// A set of independent keys held together, not a state machine: four flags are the clearest shape.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Modifiers {
    pub command: bool,
    pub control: bool,
    pub option: bool,
    pub shift: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Named {
    Return,
    Tab,
    Escape,
    /// Forward delete; `backspace` is the key that deletes backwards.
    Delete,
    Backspace,
    Space,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Named(Named),
    /// An ASCII letter or digit, lowercase.
    Char(char),
    /// F1 to F12.
    Function(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chord {
    pub modifiers: Modifiers,
    pub key: Key,
}

pub fn parse_chord(spec: &str) -> Result<Chord, String> {
    let mut modifiers = Modifiers::default();
    let mut key = None;
    for part in spec.split('+').map(|part| part.trim().to_lowercase()) {
        match part.as_str() {
            "cmd" | "command" | "meta" | "super" => modifiers.command = true,
            "ctrl" | "control" => modifiers.control = true,
            "alt" | "option" | "opt" => modifiers.option = true,
            "shift" => modifiers.shift = true,
            _ if key.is_some() => return Err(format!("ambiguous key chord: {spec}")),
            token => {
                key = Some(parse_key(token).ok_or_else(|| format!("unrecognized key: {spec}"))?);
            }
        }
    }
    let key = key.ok_or_else(|| format!("key chord has no key: {spec}"))?;
    Ok(Chord { modifiers, key })
}

/// Why Jian never presses `chord`, when it is one of the few that take the session away from
/// the user rather than act inside it. Which keys those are depends on the system: Cmd+L opens
/// a browser's address bar on a Mac, and the same keys lock a Windows or Linux desktop.
pub fn blocked(chord: Chord) -> Option<&'static str> {
    blocked_on(chord, cfg!(target_os = "macos"))
}

fn blocked_on(chord: Chord, mac: bool) -> Option<&'static str> {
    let Modifiers {
        command,
        control,
        option,
        shift,
    } = chord.modifiers;
    let taken = match (mac, chord.key) {
        // Lock the screen, and sign out with or without asking.
        (true, Key::Char('q')) => command && (control || shift),
        (false, Key::Char('l')) => command && !control && !option && !shift,
        // The system's own screen on Windows; the end of the X server where it is enabled.
        (false, Key::Named(Named::Delete | Named::Backspace)) => control && option,
        _ => false,
    };
    taken.then_some(
        "Jian does not press this key combination: it locks the screen or ends the session.",
    )
}

fn parse_key(token: &str) -> Option<Key> {
    let named = match token {
        "return" | "enter" => Named::Return,
        "tab" => Named::Tab,
        "escape" | "esc" => Named::Escape,
        "delete" => Named::Delete,
        "backspace" => Named::Backspace,
        "space" => Named::Space,
        "up" => Named::Up,
        "down" => Named::Down,
        "left" => Named::Left,
        "right" => Named::Right,
        "home" => Named::Home,
        "end" => Named::End,
        "pageup" => Named::PageUp,
        "pagedown" => Named::PageDown,
        _ => {
            let mut chars = token.chars();
            return match (chars.next(), chars.next()) {
                (Some(c), None) if c.is_ascii_alphanumeric() => Some(Key::Char(c)),
                (Some('f'), Some(_)) => match token[1..].parse::<u8>() {
                    Ok(n @ 1..=12) => Some(Key::Function(n)),
                    _ => None,
                },
                _ => None,
            };
        }
    };
    Some(Key::Named(named))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_chords_with_any_spelling_of_the_modifiers() {
        let chord = parse_chord("Command + Shift + T").unwrap();
        assert_eq!(chord.key, Key::Char('t'));
        assert!(chord.modifiers.command && chord.modifiers.shift);
        assert!(!chord.modifiers.control && !chord.modifiers.option);
        assert_eq!(parse_chord("enter").unwrap().key, Key::Named(Named::Return));
        assert_eq!(parse_chord("ctrl+f12").unwrap().key, Key::Function(12));
    }

    #[test]
    fn never_presses_what_takes_the_session_from_the_user() {
        let blocked = |spec: &str, mac: bool| blocked_on(parse_chord(spec).unwrap(), mac).is_some();
        for spec in ["cmd+ctrl+q", "cmd+shift+q", "cmd+option+shift+q"] {
            assert!(blocked(spec, true), "{spec}");
            assert!(!blocked(spec, false), "{spec}");
        }
        for spec in ["super+l", "ctrl+alt+delete", "ctrl+alt+backspace"] {
            assert!(blocked(spec, false), "{spec}");
            assert!(!blocked(spec, true), "{spec}");
        }
        // The everyday neighbours of those stay.
        for spec in [
            "cmd+q",
            "cmd+l",
            "ctrl+l",
            "ctrl+shift+l",
            "delete",
            "ctrl+backspace",
        ] {
            assert!(!blocked(spec, true), "{spec}");
        }
        for spec in [
            "ctrl+l",
            "ctrl+shift+l",
            "delete",
            "ctrl+backspace",
            "alt+f4",
        ] {
            assert!(!blocked(spec, false), "{spec}");
        }
    }

    #[test]
    fn refuses_chords_it_cannot_press() {
        assert!(parse_chord("cmd+shift").is_err());
        assert!(parse_chord("a+b").is_err());
        assert!(parse_chord("f13").is_err());
        assert!(parse_chord("ç").is_err());
    }
}
