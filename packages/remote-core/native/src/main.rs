//! Jian Remote's Computer Use helper: a long-lived child of the worker that reads the display,
//! drives input and draws the agent's pointer. It reads one JSON request a line on stdin and
//! answers each with one JSON line on stdout, in order; diagnostics go to stderr. See
//! `protocol` for the messages.

mod keys;
mod motion;
mod platform;
mod protocol;
mod screenshot;

use std::io::{BufRead, Write};
use std::time::Duration;

use serde_json::{Value, json};

use platform::{Platform, Pointer, Presence};
use protocol::{Point, Request, click_count, error, ok};

/// The helper between requests: what it acts with, and the pointer the user watches.
pub struct Helper<P: Platform, Q: Pointer> {
    platform: P,
    pointer: Q,
}

impl<P: Platform, Q: Pointer> Helper<P, Q> {
    pub fn new(platform: P, pointer: Q) -> Self {
        Self { platform, pointer }
    }

    pub fn handle(&mut self, request: Request) -> Value {
        match self.act(request) {
            Ok(reply) => reply,
            Err(message) => error(message),
        }
    }

    fn act(&mut self, request: Request) -> Result<Value, String> {
        match request {
            Request::Ping => {}
            Request::EnsureSession => self.start()?,
            Request::SetIdle => self.pointer.show(Presence::Idle),
            Request::EndSession => self.pointer.hide(),
            Request::SessionStatus => return Ok(session_status(&self.platform)),
            Request::Geometry => {
                let geometry = self.platform.geometry()?;
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
                let capture = platform.capture()?;
                let max_bytes = max_bytes.unwrap_or(screenshot::DEFAULT_MAX_BYTES);
                let jpeg = screenshot::fit(max_bytes, |width| platform.scale(&capture, width))?;
                return Ok(ok(json!({
                    "widthPx": jpeg.width,
                    "heightPx": jpeg.height,
                    "base64": jpeg.base64(),
                })));
            }
            // The pointer alone: the user's cursor stays where it is.
            Request::Move { point_x, point_y } => self.glide(Point {
                x: point_x,
                y: point_y,
            })?,
            Request::Click { button, count } => {
                let count = click_count(count)?;
                let at = self
                    .pointer
                    .tip()
                    .ok_or("move the pointer before clicking")?;
                self.pointer.flash();
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
                self.glide(at)?;
                self.pointer.flash();
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
                self.glide(from)?;
                self.pointer.flash();
                let pointer = &mut self.pointer;
                self.platform
                    .drag(from, &motion::drag_path(from, to), &mut |at| {
                        pointer.place(at)
                    })?;
            }
            Request::Type { text } => self.platform.type_text(&text)?,
            Request::Key { key } => self.platform.key(keys::parse_chord(&key)?)?,
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
                self.glide(at)?;
                let amount = u32::try_from(amount.max(1)).unwrap_or(u32::MAX);
                self.platform.scroll(at, direction, amount)?;
            }
        }
        Ok(ok(Value::Null))
    }

    /// Shows the pointer, starting where the user's own cursor is when there is no session yet.
    fn start(&mut self) -> Result<(), String> {
        if self.pointer.tip().is_none() {
            self.pointer.place(self.platform.cursor()?);
        }
        self.pointer.show(Presence::Active);
        Ok(())
    }

    fn glide(&mut self, to: Point) -> Result<(), String> {
        self.start()?;
        let from = self.pointer.tip().unwrap_or(to);
        for (at, pause) in motion::glide(from, to) {
            self.pointer.place(at);
            self.pointer.wait(pause);
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
fn serve(execute: &mut dyn FnMut(Request) -> Value) {
    let mut stdout = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Request>(line) {
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

fn main() {
    // The worker asks this on every poll; one answer and out, without a session or a window.
    if std::env::args().any(|arg| arg == "--session-status") {
        println!("{}", session_status(&platform::Native));
        return;
    }
    platform::run(serve);
}
