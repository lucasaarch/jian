//! macOS: CoreGraphics reads the display and posts input; AppKit draws the pointer. AppKit
//! wants the main thread and its run loop, so the requests are read on another thread and each
//! one runs on the main thread, in order.

mod input;
mod pointer;

use std::cell::RefCell;

use dispatch2::run_on_main;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
use serde_json::Value;

pub use input::Mac;
use pointer::MacPointer;

use crate::Helper;
use crate::protocol::Request;

thread_local! {
    /// Lives on the main thread only: the pointer's window cannot leave it.
    static HELPER: RefCell<Option<Helper<Mac, MacPointer>>> = const { RefCell::new(None) };
}

/// Runs the helper: `serve` reads the requests and gets each answered, and when it returns the
/// process ends. The main thread stays in AppKit's run loop until then.
pub fn run(serve: impl FnOnce(&mut dyn FnMut(Request) -> Value) + Send + 'static) {
    let mtm = MainThreadMarker::new().expect("the helper starts on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    // No Dock icon and no menu bar: the helper is a part of the worker, not an app of its own.
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    HELPER.with(|helper| *helper.borrow_mut() = Some(Helper::new(Mac, MacPointer::new(mtm))));

    std::thread::spawn(move || {
        serve(&mut |request| {
            run_on_main(move |_| {
                HELPER.with(|helper| {
                    helper
                        .borrow_mut()
                        .as_mut()
                        .expect("set before serving")
                        .handle(request)
                })
            })
        });
        std::process::exit(0);
    });
    app.run();
}
