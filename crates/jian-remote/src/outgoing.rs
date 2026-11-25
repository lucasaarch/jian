//! What the worker's parts hand the connection loop to send. One channel outlives every
//! connection, so a task or a forward never needs to know whether the gateway is there: while it
//! is not, the loop drains the channel and drops what cannot wait (output, forward bytes) while
//! results stay in the outbox until acknowledged.

use jian_protocol::machine::{TaskId, WorkerMessage};
use tokio::sync::mpsc;

/// Messages waiting for the loop. Output that finds it full is dropped (best effort by
/// protocol); forward bytes wait, which holds back the local socket instead of buffering it.
pub const QUEUE: usize = 256;

/// A frame bound for the gateway, before it is written to the socket.
#[derive(Debug)]
pub enum Outgoing {
    /// Boxed: a message is far larger than the other variants, and most of what crosses the
    /// queue is forward bytes.
    Message(Box<WorkerMessage>),
    /// The bytes of a forwarded connection.
    Binary(Vec<u8>),
    /// A task finished and its result is in the outbox, to send now if connected.
    ResultReady(TaskId),
}

/// The queue the worker's parts write to.
pub type Sender = mpsc::Sender<Outgoing>;
/// The end the connection loop drains.
pub type Receiver = mpsc::Receiver<Outgoing>;

/// A new bounded queue.
pub fn channel() -> (Sender, Receiver) {
    mpsc::channel(QUEUE)
}
