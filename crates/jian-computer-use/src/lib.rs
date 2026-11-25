//! Jian Remote's Computer Use helper: a long-lived child of the worker that reads the display,
//! drives input and draws the agents' pointers. It reads one JSON request a line on stdin and
//! answers each with one JSON line on stdout, in order; diagnostics go to stderr. See
//! `protocol` for the messages.
//!
//! A library so the worker carries it: `jian-remote computer-helper` runs [`helper_main`] in a
//! child process of its own. A child, not a thread, because macOS wants `AppKit` on a process's
//! main thread, and because a helper stuck in a system call has to be killable without taking
//! the worker with it. One binary also means one identity for the OS's privacy permissions.

mod cursor;
mod keys;
mod motion;
mod platform;
mod protocol;
mod screenshot;
#[cfg(any(target_os = "macos", windows, test))]
mod text;

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::time::Duration;

use serde_json::{Value, json};

use cursor::Look;
use platform::{Need, Platform, Pointer, Presence};
use protocol::{Envelope, Failure, Point, Request, click_count, error, ok};

/// A scroll longer than this is a mistake, not a wish: the worker's contract stops here too.
const SCROLL_MAX_LINES: i64 = 100;

/// The helper between requests: what it acts with, and the pointer of each session using the
/// screen. The worker sends one request at a time, so the sessions take turns at the one mouse
/// and keyboard there is; what each keeps to itself is where its pointer stands.
pub(crate) struct Helper<P: Platform, Q: Pointer> {
    platform: P,
    /// By session, with the look each was made with; "" is a worker that names none.
    pointers: HashMap<String, (Look, Q)>,
}

impl<P: Platform, Q: Pointer> Helper<P, Q> {
    pub fn new(platform: P) -> Self {
        Self {
            platform,
            pointers: HashMap::new(),
        }
    }

    pub fn handle(&mut self, envelope: Envelope) -> Value {
        match self.act(&envelope.session, envelope.request) {
            Ok(reply) => reply,
            Err(failure) => failure.reply(),
        }
    }

    /// Every pointer there is, for a platform that has to animate them itself.
    #[cfg(windows)]
    pub fn pointers(&mut self) -> impl Iterator<Item = &mut Q> {
        self.pointers.values_mut().map(|(_, pointer)| pointer)
    }

    /// Up to the first event posted, a failure is known to have reached nothing; from there
    /// on it is a platform's plain message, which reads as uncertain.
    fn act(&mut self, session: &str, request: Request) -> Result<Value, Failure> {
        match request {
            Request::Ping => {}
            Request::EnsureSession { label, color } => {
                self.dress(session, Look::new(label.as_deref(), color.as_deref()));
                self.start(session)?;
            }
            Request::SetIdle => {
                if let Some((_, pointer)) = self.pointers.get_mut(session) {
                    pointer.show(Presence::Idle);
                }
            }
            Request::EndSession => {
                if let Some((_, mut pointer)) = self.pointers.remove(session) {
                    pointer.hide();
                }
            }
            Request::SessionStatus => return Ok(session_status(&self.platform)),
            Request::Geometry => {
                let geometry = self.platform.geometry().map_err(Failure::unsent)?;
                return Ok(ok(json!({
                    "originX": 0,
                    "originY": 0,
                    "pointWidth": geometry.point_width,
                    "pointHeight": geometry.point_height,
                    "pixelWidth": geometry.pixel_width,
                    "pixelHeight": geometry.pixel_height,
                    "scaleFactor": geometry.pixel_width / geometry.point_width,
                })));
            }
            Request::Screenshot { max_bytes } => {
                let platform = &self.platform;
                platform.preflight(Need::Screen)?;
                let capture = platform.capture().map_err(Failure::unsent)?;
                let max_bytes = max_bytes.unwrap_or(screenshot::DEFAULT_MAX_BYTES);
                let jpeg = screenshot::fit(max_bytes, |width| platform.scale(&capture, width))
                    .map_err(Failure::unsent)?;
                return Ok(ok(json!({
                    "widthPx": jpeg.width,
                    "heightPx": jpeg.height,
                    "base64": jpeg.base64(),
                })));
            }
            // The pointer alone: the user's cursor stays where it is.
            Request::Move { point_x, point_y } => self.glide(
                session,
                Point {
                    x: point_x,
                    y: point_y,
                },
            )?,
            Request::Click { button, count } => {
                let count = click_count(count)?;
                let at = self
                    .pointers
                    .get(session)
                    .and_then(|(_, pointer)| pointer.tip())
                    .ok_or_else(|| Failure::invalid("move the pointer before clicking"))?;
                self.platform.preflight(Need::Mouse(at))?;
                self.pointer(session).flash();
                self.platform.click_at(at, button, count)?;
            }
            Request::ClickAt {
                point_x,
                point_y,
                button,
                count,
            } => {
                let count = click_count(count)?;
                let at = Point {
                    x: point_x,
                    y: point_y,
                };
                self.platform.preflight(Need::Mouse(at))?;
                self.glide(session, at)?;
                self.pointer(session).flash();
                self.platform.click_at(at, button, count)?;
            }
            Request::Drag {
                from_x,
                from_y,
                to_x,
                to_y,
            } => {
                let (from, to) = (
                    Point {
                        x: from_x,
                        y: from_y,
                    },
                    Point { x: to_x, y: to_y },
                );
                self.platform.preflight(Need::Mouse(from))?;
                self.glide(session, from)?;
                self.pointer(session).flash();
                let Some((_, pointer)) = self.pointers.get_mut(session) else {
                    // `glide` made it a moment ago; only a platform that drops it can get here.
                    return Err(Failure::invalid("the session's pointer is gone"));
                };
                self.platform
                    .drag(from, &motion::drag_path(from, to), &mut |at| {
                        pointer.place(at);
                    })?;
            }
            Request::Type { text } => {
                self.platform.preflight(Need::Keyboard)?;
                self.platform.type_text(&text)?;
            }
            Request::Key { key } => {
                let chord = keys::parse_chord(&key).map_err(Failure::invalid)?;
                if let Some(reason) = keys::blocked(chord) {
                    return Err(Failure::policy(reason));
                }
                self.platform.preflight(Need::Keyboard)?;
                self.platform.key(chord)?;
            }
            Request::Scroll {
                point_x,
                point_y,
                direction,
                amount,
            } => {
                let at = Point {
                    x: point_x,
                    y: point_y,
                };
                self.platform.preflight(Need::Mouse(at))?;
                self.glide(session, at)?;
                let amount = amount.clamp(1, SCROLL_MAX_LINES) as u32;
                self.platform.scroll(at, direction, amount)?;
            }
        }
        Ok(ok(Value::Null))
    }

    fn pointer(&mut self, session: &str) -> &mut Q {
        let (_, pointer) = self.pointers.entry(session.to_owned()).or_insert_with(|| {
            let look = Look::default();
            let pointer = Q::new(&look);
            (look, pointer)
        });
        pointer
    }

    /// Gives the session's pointer its name and colour. One that is already drawn another way,
    /// because the agent was renamed, is drawn anew where it stands.
    fn dress(&mut self, session: &str, look: Look) {
        if matches!(self.pointers.get(session), Some((worn, _)) if *worn == look) {
            return;
        }
        let stood = self.pointers.remove(session).and_then(|(_, mut old)| {
            let tip = old.tip();
            old.hide();
            tip
        });
        let mut pointer = Q::new(&look);
        if let Some(tip) = stood {
            pointer.place(tip);
        }
        self.pointers.insert(session.to_owned(), (look, pointer));
    }

    /// Shows the session's pointer, starting where the user's own cursor is when it has not
    /// been anywhere yet. Nothing is posted here, so a failure reached nothing.
    fn start(&mut self, session: &str) -> Result<(), Failure> {
        if self.pointer(session).tip().is_none() {
            let cursor = self.platform.cursor().map_err(Failure::unsent)?;
            self.pointer(session).place(cursor);
        }
        self.pointer(session).show(Presence::Active);
        Ok(())
    }

    fn glide(&mut self, session: &str, to: Point) -> Result<(), Failure> {
        self.start(session)?;
        let pointer = self.pointer(session);
        let from = pointer.tip().unwrap_or(to);
        for (at, pause) in motion::glide(from, to) {
            pointer.place(at);
            pointer.wait(pause);
        }
        Ok(())
    }
}

fn session_status(platform: &impl Platform) -> Value {
    let status = platform.session_status();
    ok(
        json!({ "state": status.state(), "locked": status.locked, "displayAsleep": status.display_asleep }),
    )
}

/// Answers the requests on stdin in order until the worker closes it.
fn serve(execute: &mut dyn FnMut(Envelope) -> Value) {
    let mut stdout = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Envelope>(line) {
            Ok(request) => execute(request),
            Err(parse) => {
                eprintln!("computer-helper: {parse}");
                error(format!("invalid request: {parse}"))
            }
        };
        // The worker reads a closed pipe as the helper dying; there is nobody left to answer.
        if writeln!(stdout, "{reply}")
            .and_then(|()| stdout.flush())
            .is_err()
        {
            break;
        }
    }
    // The window server drops input still queued from a process that has exited: an Escape
    // posted just before the worker closed the pipe never reached the menu it was for.
    std::thread::sleep(Duration::from_millis(150));
}

/// The helper process: `--session-status` answers once and returns; otherwise it serves requests
/// on stdin until the worker closes it. On macOS and Windows it takes over the calling thread,
/// which must be the process's main thread, and ends the process when stdin closes.
pub fn helper_main(args: impl IntoIterator<Item = String>) {
    // The worker asks this on every poll; one answer and out, without a session or a window.
    if args.into_iter().any(|arg| arg == "--session-status") {
        println!("{}", session_status(&platform::Native));
        return;
    }
    platform::run(serve);
}
