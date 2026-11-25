//! Makes cargo rebuild the crate when a migration file is added: `sqlx::migrate!` embeds the
//! files that exist when it expands, and cargo would not notice a new one.

// A build script talks to cargo through stdout.
#![allow(clippy::print_stdout)]

fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
