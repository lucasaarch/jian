//! Jian Remote's Computer Use helper: a long-lived child of the worker that reads the display
//! and drives input. It reads one JSON request a line on stdin and answers each with one JSON
//! line on stdout, in order; diagnostics go to stderr. See `protocol` for the messages.
//!
//! A prototype for macOS: it does not draw the Jian pointer yet, so `move`, `ensureSession`,
//! `setIdle` and `endSession` only keep its place.

mod keys;
mod platform;
mod protocol;
mod screenshot;

use std::io::{BufRead, Write};

use serde_json::{Value, json};

use platform::{Native, Platform};
use protocol::{Point, Request, click_count, error, ok};

/// The helper between requests: where the agent's pointer is, which `click` uses.
struct Helper<P: Platform> {
    platform: P,
    pointer: Option<Point>,
}

impl<P: Platform> Helper<P> {
    fn handle(&mut self, request: Request) -> Value {
        match self.act(request) {
            Ok(reply) => reply,
            Err(message) => error(message),
        }
    }

    fn act(&mut self, request: Request) -> Result<Value, String> {
        let platform = &self.platform;
        match request {
            Request::Ping | Request::EnsureSession | Request::SetIdle => {}
            Request::EndSession => self.pointer = None,
            Request::SessionStatus => return Ok(session_status(platform)),
            Request::Geometry => {
                let geometry = platform.geometry()?;
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
                let capture = platform.capture()?;
                let jpeg = screenshot::fit(
                    max_bytes.unwrap_or(screenshot::DEFAULT_MAX_BYTES),
                    |width| platform.scale(&capture, width),
                )?;
                return Ok(ok(json!({
                    "widthPx": jpeg.width,
                    "heightPx": jpeg.height,
                    "base64": jpeg.base64(),
                })));
            }
            Request::Move { point_x, point_y } => {
                self.pointer = Some(Point {
                    x: point_x,
                    y: point_y,
                })
            }
            Request::Click { button, count } => {
                let at = self.pointer.ok_or("move the pointer before clicking")?;
                platform.click_at(at, button, click_count(count)?)?;
            }
            Request::ClickAt {
                point_x,
                point_y,
                button,
                count,
            } => {
                let at = Point {
                    x: point_x,
                    y: point_y,
                };
                platform.click_at(at, button, click_count(count)?)?;
                self.pointer = Some(at);
            }
            Request::Drag {
                from_x,
                from_y,
                to_x,
                to_y,
            } => {
                let to = Point { x: to_x, y: to_y };
                platform.drag(
                    Point {
                        x: from_x,
                        y: from_y,
                    },
                    to,
                )?;
                self.pointer = Some(to);
            }
            Request::Type { text } => platform.type_text(&text)?,
            Request::Key { key } => platform.key(keys::parse_chord(&key)?)?,
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
                platform.scroll(
                    at,
                    direction,
                    u32::try_from(amount.max(1)).unwrap_or(u32::MAX),
                )?;
                self.pointer = Some(at);
            }
        }
        Ok(ok(Value::Null))
    }
}

fn session_status(platform: &impl Platform) -> Value {
    let status = platform.session_status();
    ok(
        json!({ "state": status.state(), "locked": status.locked, "displayAsleep": status.display_asleep }),
    )
}

fn main() {
    let mut stdout = std::io::stdout().lock();
    // The worker asks this on every poll; one answer and out, without a session.
    if std::env::args().any(|arg| arg == "--session-status") {
        let _ = writeln!(stdout, "{}", session_status(&Native));
        return;
    }
    let mut helper = Helper {
        platform: Native,
        pointer: None,
    };
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Request>(line) {
            Ok(request) => helper.handle(request),
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
    std::thread::sleep(std::time::Duration::from_millis(150));
}
