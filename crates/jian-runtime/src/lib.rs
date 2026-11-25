//! The agent loop: turns, tool calls and context compaction.
//!
//! It drives a conversation by asking `jian-llm` for the next step and `jian-exec` to carry out
//! what the model asks for, and it saves the outcome through `jian-store`. It holds the order of
//! events in a turn and nothing else: it neither talks to a provider's API, nor spawns a process,
//! nor serves HTTP. `jian-server` starts it.
