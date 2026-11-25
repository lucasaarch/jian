//! What the worker's parts hand the connection loop to send. One channel outlives every
//! connection, so a task or a forward never needs to know whether the gateway is there: while it
//! is not, the loop drains the channel and drops what cannot wait (output, forward bytes) while
//! results stay in the outbox until acknowledged.

use jian_protocol::machine::WorkerMessage;
use tokio::sync::mpsc;

/// Messages waiting for the loop. Output that finds it full is dropped (best effort by
/// protocol); forward bytes wait, which holds back the local socket instead of buffering it.
pub const QUEUE: usize = 256;

#[derive(Debug)]
pub enum Outgoing {
    /// Boxed: a message is far larger than the other variants, and most of what crosses the
    /// queue is forward bytes.
    Message(Box<WorkerMessage>),
    Binary(Vec<u8>),
    /// A task finished and its result is in the outbox, to send now if connected.
    ResultReady(String),
}

pub type Sender = mpsc::Sender<Outgoing>;
pub type Receiver = mpsc::Receiver<Outgoing>;

pub fn channel() -> (Sender, Receiver) {
    mpsc::channel(QUEUE)
}
