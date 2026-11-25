//! Model providers and their streaming.
//!
//! It turns one provider-neutral request into each provider's API and the provider's stream back
//! into `jian-core` events. It keeps no conversation state, runs no tools and stores nothing; the
//! turn that uses it is `jian-runtime`'s.
