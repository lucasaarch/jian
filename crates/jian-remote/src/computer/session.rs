//! Computer Use on this machine: one helper process and one screen, shared by every conversation
//! that uses it. Actions run one at a time, in the order they arrive (a fair mutex); each
//! conversation has its own seat, and is refused an action aimed at a screen another one has
//! changed since its last screenshot.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use jian_protocol::machine::{
    ComputerAction, ComputerErrorCode, ComputerSeat, ComputerTask, Delivery, Scale, ScrollDirection,
};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::helper::{Helper, HelperCommand};
use super::macos;
use super::outcome::{ActionError, Done};

/// Without an action for this long, the helper is told to idle a seat's pointer.
const IDLE: Duration = Duration::from_secs(30);
/// Without an action for this long a seat is over. Only the agent says `end_session`, and a run
/// that was cancelled or failed never does: its pointer, the helper and the display assertion
/// would stay until the worker restarts. Far longer than a model thinks.
pub const SEAT_IDLE: Duration = Duration::from_mins(30);
/// How long the helper gets to answer a housekeeping request before it is killed.
const LEAVE_WAIT: Duration = Duration::from_secs(5);
/// Expired seats remembered, so each is told to look again when it comes back.
const EXPIRED_KEPT: usize = 256;
/// A gateway that names no seat shares this one: the helper's own default pointer.
const SHARED_SEAT: &str = "";

const SCREEN_CHANGED: &str = "The screen may have changed since your last screenshot: another agent used this computer, or an action was cut short. Nothing was sent. Take a screenshot and look again before acting.";

/// What changes the screen under the other conversations. Moving a pointer only moves Jian's own
/// drawing of it, never the user's cursor.
fn acts(action: ComputerAction) -> bool {
    use ComputerAction::{DoubleClick, Key, LeftClick, LeftClickDrag, RightClick, Scroll, Type};
    matches!(
        action,
        LeftClick | RightClick | DoubleClick | LeftClickDrag | Type | Key | Scroll
    )
}

/// The primary display in points, the unit input is addressed in, and the pixel size of the
/// screenshot the agent is looking at. Retina and fractional scaling make the two differ.
#[derive(Debug, Clone, Copy)]
struct Shot {
    origin_x: f64,
    origin_y: f64,
    point_width: f64,
    point_height: f64,
    width_px: u32,
    height_px: u32,
}

impl Shot {
    /// The half pixel aims at the pixel's centre, not its corner.
    fn point(&self, x: i64, y: i64) -> (f64, f64) {
        (
            self.origin_x + (x as f64 + 0.5) * (self.point_width / f64::from(self.width_px)),
            self.origin_y + (y as f64 + 0.5) * (self.point_height / f64::from(self.height_px)),
        )
    }

    fn scale(&self) -> Scale {
        Scale {
            image_to_point_x: self.point_width / f64::from(self.width_px),
            image_to_point_y: self.point_height / f64::from(self.height_px),
        }
    }
}

struct Seat {
    /// Survives a helper crash: the agent's coordinates still refer to the same screenshot.
    shot: Option<Shot>,
    /// The helper generation told of this seat; a new helper has to be told again.
    generation: Option<u64>,
    last: Instant,
    idle_sent: bool,
    /// The screen was acted on since this seat last looked: by another conversation, or by an
    /// action of its own that was cut short. Its next screenshot clears it.
    stale: bool,
}

struct Running {
    helper: Helper,
    generation: u64,
}

#[derive(Default)]
struct Inner {
    running: Option<Running>,
    generations: u64,
    seats: HashMap<String, Seat>,
    expired: VecDeque<String>,
    /// Keeps the display on while a helper runs on a Mac: the agent is looking at it.
    display_hold: Option<(u32, std::process::Child)>,
}

/// The worker's Computer Use state: the helper process, started on demand, and the seats using it.
pub struct ComputerSession {
    inner: Mutex<Inner>,
    command: Option<HelperCommand>,
    seat_idle: Duration,
}

fn named(id: &str, mut payload: Value) -> Value {
    if id != SHARED_SEAT
        && let Some(object) = payload.as_object_mut()
    {
        object.insert("session".into(), Value::String(id.into()));
    }
    payload
}

impl Inner {
    fn close(&mut self) {
        if let Some(running) = self.running.take() {
            running.helper.kill();
        }
        if let Some((_, mut hold)) = self.display_hold.take() {
            let _ = hold.kill();
        }
    }

    fn seat(&mut self, id: &str) -> &mut Seat {
        let stale = if self.seats.contains_key(id) {
            false
        } else {
            // Whoever arrives at a screen others are using has not seen what they did to it, and
            // one coming back after its seat expired no longer knows what is there either.
            let expired = self
                .expired
                .iter()
                .position(|old| old == id)
                .map(|at| self.expired.remove(at));
            expired.is_some() || !self.seats.is_empty()
        };
        self.seats.entry(id.to_owned()).or_insert(Seat {
            shot: None,
            generation: None,
            last: Instant::now(),
            idle_sent: false,
            stale,
        })
    }

    /// After `action` by seat `id`, the others no longer know what is on the screen.
    fn changed(&mut self, id: &str, action: ComputerAction) {
        if acts(action) {
            for (other, seat) in &mut self.seats {
                if other != id {
                    seat.stale = true;
                }
            }
        }
    }

    async fn leave(&mut self, id: &str) {
        let Some(seat) = self.seats.remove(id) else {
            return;
        };
        if let Some(running) = &mut self.running
            && seat.generation == Some(running.generation)
        {
            let payload = named(id, json!({ "cmd": "endSession" }));
            if tokio::time::timeout(LEAVE_WAIT, running.helper.request(&payload))
                .await
                .is_err()
            {
                // A helper that does not answer would otherwise hold the screen for the next one.
                self.close();
            }
        }
        if self.seats.is_empty() {
            self.close();
        }
    }

    async fn ensure(
        &mut self,
        command: Option<&HelperCommand>,
        id: &str,
        seat: Option<&ComputerSeat>,
    ) -> Result<(), ActionError> {
        let running = if let Some(ref mut running) = self.running {
            running
        } else {
            let Some(command) = command else {
                return Err(ActionError::refused(
                    "The Computer Use helper could not be found.",
                    ComputerErrorCode::Failed,
                ));
            };
            // A helper that never started sent nothing to the screen.
            let helper = Helper::start(command).map_err(|error| {
                ActionError::refused(
                    format!("Computer-use helper failed: {error}"),
                    ComputerErrorCode::Failed,
                )
            })?;
            self.generations += 1;
            let mut running = Running {
                helper,
                generation: self.generations,
            };
            if let Err(error) = running
                .helper
                .call(
                    &json!({ "cmd": "ping" }),
                    "Computer-use helper did not respond.",
                )
                .await
            {
                // A helper that answered wrong is not reused: the next action starts a fresh one.
                running.helper.kill();
                return Err(ActionError::refused(
                    error.message,
                    ComputerErrorCode::Failed,
                ));
            }
            self.running.insert(running)
        };
        let generation = running.generation;
        if let Some(pid) = running.helper.pid()
            && self
                .display_hold
                .as_ref()
                .is_none_or(|(held, _)| *held != pid)
        {
            if let Some((_, mut old)) = self.display_hold.take() {
                let _ = old.kill();
            }
            self.display_hold = macos::caffeinate("-dimsu", pid).map(|child| (pid, child));
        }
        if self.seats.get(id).and_then(|seat| seat.generation) != Some(generation) {
            let mut payload = json!({ "cmd": "ensureSession" });
            if let Some(seat) = seat {
                payload["label"] = Value::String(seat.name.clone());
                payload["color"] = Value::String(seat.color.clone());
            }
            running
                .helper
                .call(&named(id, payload), "Could not show the pointer.")
                .await?;
            self.seat(id).generation = Some(generation);
        }
        let seat = self.seat(id);
        seat.idle_sent = false;
        Ok(())
    }

    async fn call(
        &mut self,
        id: &str,
        payload: Value,
        failure: &str,
    ) -> Result<Value, ActionError> {
        let Some(running) = &mut self.running else {
            return Err(ActionError::unclassified(
                "Computer-use helper is not running.",
            ));
        };
        running.helper.call(&named(id, payload), failure).await
    }

    /// Read again for every screenshot, never kept: the display can change resolution or scale,
    /// or another can become primary, while the helper runs.
    async fn screenshot(&mut self, id: &str, note: &str) -> Result<Done, ActionError> {
        let geometry = self
            .call(
                id,
                json!({ "cmd": "geometry" }),
                "Could not read display geometry.",
            )
            .await?;
        let number = |key: &str| geometry.get(key).and_then(Value::as_f64);
        let shot_reply = self
            .call(id, json!({ "cmd": "screenshot" }), "Screenshot failed.")
            .await?;
        let (Some(base64), Some(width_px), Some(height_px)) = (
            shot_reply.get("base64").and_then(Value::as_str),
            shot_reply.get("widthPx").and_then(Value::as_u64),
            shot_reply.get("heightPx").and_then(Value::as_u64),
        ) else {
            return Err(ActionError::unclassified(
                "Screenshot produced no image data.",
            ));
        };
        let shot = Shot {
            origin_x: number("originX").unwrap_or(0.0),
            origin_y: number("originY").unwrap_or(0.0),
            point_width: number("pointWidth").unwrap_or(0.0),
            point_height: number("pointHeight").unwrap_or(0.0),
            width_px: u32::try_from(width_px).unwrap_or(0),
            height_px: u32::try_from(height_px).unwrap_or(0),
        };
        if !(shot.width_px > 0
            && shot.height_px > 0
            && shot.point_width > 0.0
            && shot.point_height > 0.0)
        {
            return Err(ActionError::unclassified(
                "Invalid screenshot geometry for coordinate mapping",
            ));
        }
        let seat = self.seat(id);
        seat.shot = Some(shot);
        seat.stale = false;
        Ok(Done {
            width_px: Some(shot.width_px),
            height_px: Some(shot.height_px),
            scale: Some(shot.scale()),
            stdout: base64.to_owned(),
            stderr: note.to_owned(),
        })
    }

    /// A pixel of the seat's last screenshot as a display point; there must be one, holding it.
    fn point(
        &mut self,
        id: &str,
        coordinate: Option<[i64; 2]>,
        missing: &str,
    ) -> Result<(f64, f64), ActionError> {
        let [x, y] = coordinate.ok_or_else(|| ActionError::invalid(missing))?;
        let shot = self.seat(id).shot.ok_or_else(|| {
            ActionError::invalid("Take a screenshot before using screen coordinates.")
        })?;
        if x < 0 || y < 0 || x >= i64::from(shot.width_px) || y >= i64::from(shot.height_px) {
            return Err(ActionError::invalid(format!(
                "Coordinate ({x}, {y}) is outside the last screenshot ({}×{}).",
                shot.width_px, shot.height_px
            )));
        }
        Ok(shot.point(x, y))
    }

    async fn input(&mut self, id: &str, task: &ComputerTask) -> Result<(), ActionError> {
        use ComputerAction::{
            DoubleClick, EndSession, Key, LeftClick, LeftClickDrag, MouseMove, RightClick,
            Screenshot, Scroll, Type, Wait,
        };
        let needed = "coordinate is required for this action.";
        match task.action {
            MouseMove => {
                let (x, y) = self.point(id, task.coordinate, needed)?;
                self.call(
                    id,
                    json!({ "cmd": "move", "pointX": x, "pointY": y }),
                    "Move failed.",
                )
                .await?;
            }
            LeftClick | RightClick | DoubleClick => {
                let (x, y) = self.point(id, task.coordinate, needed)?;
                let button = if task.action == RightClick {
                    "right"
                } else {
                    "left"
                };
                let count = if task.action == DoubleClick { 2 } else { 1 };
                // One request: the helper moves its pointer there, clicks, and puts the user's
                // cursor back.
                let payload = json!({ "cmd": "clickAt", "pointX": x, "pointY": y, "button": button, "count": count });
                self.call(id, payload, "Click failed.").await?;
            }
            LeftClickDrag => {
                let missing = "startCoordinate and coordinate are required for drag.";
                let from = self.point(id, task.start_coordinate, missing)?;
                let to = self.point(id, task.coordinate, missing)?;
                let payload = json!({ "cmd": "drag", "fromX": from.0, "fromY": from.1, "toX": to.0, "toY": to.1 });
                self.call(id, payload, "Drag failed.").await?;
            }
            Type => {
                let text = task.text.as_deref().filter(|text| !text.is_empty());
                let text =
                    text.ok_or_else(|| ActionError::invalid("text is required for type."))?;
                self.call(id, json!({ "cmd": "type", "text": text }), "Type failed.")
                    .await?;
            }
            Key => {
                let key = task.key.as_deref().filter(|key| !key.is_empty());
                let key = key.ok_or_else(|| ActionError::invalid("key is required for key."))?;
                self.call(id, json!({ "cmd": "key", "key": key }), "Key failed.")
                    .await?;
            }
            Scroll => {
                let (x, y) =
                    self.point(id, task.coordinate, "coordinate is required for scroll.")?;
                let direction = task.scroll_direction.ok_or_else(|| {
                    ActionError::invalid("scrollDirection is required for scroll.")
                })?;
                let direction = match direction {
                    ScrollDirection::Up => "up",
                    ScrollDirection::Down => "down",
                    ScrollDirection::Left => "left",
                    ScrollDirection::Right => "right",
                };
                let payload = json!({
                    "cmd": "scroll", "pointX": x, "pointY": y, "direction": direction,
                    "amount": task.scroll_amount.unwrap_or(3),
                });
                self.call(id, payload, "Scroll failed.").await?;
            }
            Screenshot | Wait | EndSession => unreachable!("answered before input"),
        }
        Ok(())
    }
}

impl ComputerSession {
    /// A session that starts `command` when the first action needs a helper; `None` where Computer Use is not built.
    pub fn new(command: Option<HelperCommand>) -> Self {
        Self::with_seat_idle(command, SEAT_IDLE)
    }

    /// Like [`ComputerSession::new`], with how long a seat may sit unused before its pointer is removed.
    pub fn with_seat_idle(command: Option<HelperCommand>, seat_idle: Duration) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            command,
            seat_idle,
        }
    }

    /// The command that starts the helper, when there is one.
    pub fn helper_command(&self) -> Option<&HelperCommand> {
        self.command.as_ref()
    }

    /// One action, in turn. Dropping the future part way (a time limit, a cancel) leaves the
    /// helper mid-request: whoever drops it must call [`Self::abort`].
    pub async fn act(&self, task: &ComputerTask) -> Result<Done, ActionError> {
        let id = task
            .session
            .as_ref()
            .map_or(SHARED_SEAT, |seat| seat.id.as_str())
            .to_owned();
        let mut inner = self.inner.lock().await;
        match task.action {
            ComputerAction::EndSession => {
                inner.expired.retain(|old| *old != id);
                inner.leave(&id).await;
                return Ok(Done::default());
            }
            ComputerAction::Wait => {
                let seconds = task.duration.unwrap_or(0.35).clamp(0.0, 600.0);
                tokio::time::sleep(Duration::from_secs_f64(seconds)).await;
                if let Some(seat) = inner.seats.get_mut(&id) {
                    seat.last = Instant::now();
                }
                return Ok(Done::default());
            }
            _ => {}
        }
        inner.seat(&id);
        let command = self.command.clone();
        let preparation = tokio::task::spawn_blocking(move || macos::prepare(command.as_ref()))
            .await
            .unwrap_or_default();
        let outcome = async {
            if inner.seat(&id).stale && acts(task.action) {
                return Err(ActionError::refused(
                    SCREEN_CHANGED,
                    ComputerErrorCode::ScreenChanged,
                ));
            }
            inner
                .ensure(self.command.as_ref(), &id, task.session.as_ref())
                .await?;
            if task.action == ComputerAction::Screenshot {
                return inner.screenshot(&id, preparation.note()).await;
            }
            inner.input(&id, task).await?;
            inner.changed(&id, task.action);
            Ok(Done::default())
        }
        .await;
        if let Some(seat) = inner.seats.get_mut(&id) {
            seat.last = Instant::now();
        }
        outcome.map_err(|mut error| {
            if error.delivery == Delivery::Uncertain {
                inner.changed(&id, task.action);
            }
            // Privacy permissions are read when a process starts: a helper that was refused
            // would go on being refused after the owner grants them.
            if error.code == ComputerErrorCode::PermDenied {
                inner.close();
            }
            preparation.explain(&mut error, task.action);
            error
        })
    }

    /// Stops whatever was running, after an action was given up on: the helper is killed, so a
    /// stuck one cannot press something later, and every seat has to look again, since nobody
    /// knows how far the action got.
    pub async fn abort(&self) {
        let mut inner = self.inner.lock().await;
        for seat in inner.seats.values_mut() {
            seat.stale = true;
        }
        inner.close();
    }

    /// Housekeeping, called every few seconds: idles pointers and ends seats left alone. Skipped
    /// while an action runs, so it never lands between the steps of one.
    pub async fn tick(&self) {
        let Ok(mut inner) = self.inner.try_lock() else {
            return;
        };
        let generation = inner.running.as_ref().map(|running| running.generation);
        let mut idle = Vec::new();
        let mut over = Vec::new();
        for (id, seat) in &inner.seats {
            if seat.last.elapsed() >= self.seat_idle {
                over.push(id.clone());
            } else if !seat.idle_sent
                && seat.generation.is_some()
                && seat.generation == generation
                && seat.last.elapsed() >= IDLE
            {
                idle.push(id.clone());
            }
        }
        for id in idle {
            if let Some(seat) = inner.seats.get_mut(&id) {
                seat.idle_sent = true;
            }
            if let Some(running) = &mut inner.running {
                let payload = named(&id, json!({ "cmd": "setIdle" }));
                if tokio::time::timeout(LEAVE_WAIT, running.helper.request(&payload))
                    .await
                    .is_err()
                {
                    inner.close();
                }
            }
        }
        for id in over {
            inner.expired.push_back(id.clone());
            if inner.expired.len() > EXPIRED_KEPT {
                inner.expired.pop_front();
            }
            inner.leave(&id).await;
        }
    }

    /// Ends every seat and the helper, for a worker shutting down.
    pub async fn end(&self) {
        let mut inner = self.inner.lock().await;
        let ids: Vec<String> = inner.seats.keys().cloned().collect();
        for id in ids {
            inner.leave(&id).await;
        }
        inner.close();
    }

    #[cfg(all(test, unix))]
    pub(crate) async fn helper_running(&self) -> bool {
        self.inner.lock().await.running.is_some()
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.close();
    }
}
