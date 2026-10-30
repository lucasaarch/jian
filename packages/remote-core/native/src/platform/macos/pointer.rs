//! The Jian pointer on macOS: the shared sprite in a borderless window above every app, which
//! never takes a click or focus. Core Animation draws the click ripple, so nothing here keeps
//! a timer; it only needs the main run loop the helper runs on.

use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{AnyThread, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSBackingStoreType, NSColor, NSImage, NSScreen, NSStatusWindowLevel, NSView, NSWindow,
    NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSData, NSDate, NSNumber, NSPoint, NSRunLoop, NSString};
use objc2_quartz_core::{CABasicAnimation, CALayer, CAMediaTiming};

use crate::platform::{Pointer, Presence};
use crate::protocol::Point;

/// The sprite's canvas in points: a 40 pt blade with 10 pt of glow on each side.
const SIZE: f64 = 60.0;
/// Where the tip is in the canvas, from its top-left corner.
const HOTSPOT: CGPoint = CGPoint { x: 12.0, y: 12.0 };
/// The ripple grows from 3 pt to this radius around the tip.
const RIPPLE_RADIUS: f64 = 36.0;
const RIPPLE: Duration = Duration::from_millis(160);
const ACTIVE_ALPHA: f64 = 0.94;
const IDLE_ALPHA: f64 = 0.18;

/// The @3x master the Linux and Windows helpers embed too.
static SPRITE_PNG: &[u8] = include_bytes!("../../../jian-pointer.png");

struct Overlay {
    window: Retained<NSWindow>,
    sprite: Retained<CALayer>,
    ripple: Retained<CALayer>,
}

pub struct MacPointer {
    mtm: MainThreadMarker,
    overlay: Option<Overlay>,
    tip: Option<Point>,
}

impl MacPointer {
    pub fn new(mtm: MainThreadMarker) -> Self {
        Self {
            mtm,
            overlay: None,
            tip: None,
        }
    }

    fn overlay(&mut self) -> &Overlay {
        let mtm = self.mtm;
        self.overlay.get_or_insert_with(|| Overlay::new(mtm))
    }

    fn position(&mut self) {
        let Some(tip) = self.tip else { return };
        // AppKit counts from the bottom-left of the primary screen, the protocol from its top-left.
        let screen_height = NSScreen::screens(self.mtm)
            .firstObject()
            .map_or(0.0, |screen| screen.frame().size.height);
        let origin = NSPoint::new(
            tip.x - HOTSPOT.x,
            screen_height - tip.y - (SIZE - HOTSPOT.y),
        );
        self.overlay().window.setFrameOrigin(origin);
    }
}

impl Pointer for MacPointer {
    fn show(&mut self, presence: Presence) {
        let window = &self.overlay().window;
        window.setAlphaValue(if presence == Presence::Active {
            ACTIVE_ALPHA
        } else {
            IDLE_ALPHA
        });
        window.orderFrontRegardless();
        self.position();
    }

    fn hide(&mut self) {
        if let Some(overlay) = &self.overlay {
            overlay.window.orderOut(None);
        }
        self.tip = None;
    }

    fn place(&mut self, at: Point) {
        self.tip = Some(at);
        self.position();
    }

    fn flash(&mut self) {
        let overlay = self.overlay();
        let seconds = RIPPLE.as_secs_f64();
        let start = 3.0 / RIPPLE_RADIUS;
        overlay
            .ripple
            .addAnimation_forKey(&animation("transform.scale", start, 1.0, seconds), None);
        overlay
            .ripple
            .addAnimation_forKey(&animation("opacity", 0.45, 0.0, seconds), None);
        // The blade dims and recovers with the ripple, as a press would.
        overlay
            .sprite
            .addAnimation_forKey(&animation("opacity", 0.72, 1.0, seconds), None);
    }

    fn wait(&mut self, pause: Duration) {
        if pause.is_zero() {
            return;
        }
        // Running the loop, not sleeping, lets the window server and Core Animation draw.
        let until = NSDate::dateWithTimeIntervalSinceNow(pause.as_secs_f64());
        NSRunLoop::currentRunLoop().runUntilDate(&until);
    }

    fn tip(&self) -> Option<Point> {
        self.tip
    }
}

impl Overlay {
    fn new(mtm: MainThreadMarker) -> Self {
        let frame = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(SIZE, SIZE));
        // Borderless windows never become key or main, so the pointer cannot take focus.
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                frame,
                NSWindowStyleMask::Borderless,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        // Owned by Rust: AppKit must not release it again on close.
        unsafe { window.setReleasedWhenClosed(false) };
        window.setOpaque(false);
        window.setBackgroundColor(Some(&NSColor::clearColor()));
        window.setHasShadow(false);
        window.setLevel(NSStatusWindowLevel);
        window.setIgnoresMouseEvents(true);
        window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary,
        );

        let view = NSView::initWithFrame(NSView::alloc(mtm), frame);
        view.setWantsLayer(true);
        let root = view.layer().expect("a layer-backed view has a layer");
        window.setContentView(Some(&view));

        // Under the blade, as the Swift helper drew it; Core Animation counts y from the bottom.
        let ripple = CALayer::new();
        let diameter = RIPPLE_RADIUS * 2.0;
        ripple.setBounds(CGRect::new(
            CGPoint::new(0.0, 0.0),
            CGSize::new(diameter, diameter),
        ));
        ripple.setPosition(CGPoint::new(HOTSPOT.x, SIZE - HOTSPOT.y));
        ripple.setCornerRadius(RIPPLE_RADIUS);
        ripple.setBorderWidth(1.5);
        let glow = NSColor::colorWithSRGBRed_green_blue_alpha(
            f64::from(0x28) / 255.0,
            f64::from(0x80) / 255.0,
            f64::from(0xF8) / 255.0,
            1.0,
        );
        ripple.setBorderColor(Some(&glow.CGColor()));
        ripple.setOpacity(0.0);
        root.addSublayer(&ripple);

        let sprite = CALayer::new();
        sprite.setFrame(frame);
        let png = NSData::with_bytes(SPRITE_PNG);
        if let Some(image) = NSImage::initWithData(NSImage::alloc(), &png) {
            unsafe { sprite.setContents(Some(as_object(&*image))) };
        } else {
            eprintln!("computer-helper: the embedded pointer sprite did not decode");
        }
        root.addSublayer(&sprite);

        window.setAlphaValue(0.0);
        Self {
            window,
            sprite,
            ripple,
        }
    }
}

fn animation(key_path: &str, from: f64, to: f64, seconds: f64) -> Retained<CABasicAnimation> {
    let animation = CABasicAnimation::animationWithKeyPath(Some(&NSString::from_str(key_path)));
    unsafe {
        animation.setFromValue(Some(as_object(&*NSNumber::new_f64(from))));
        animation.setToValue(Some(as_object(&*NSNumber::new_f64(to))));
    }
    animation.setDuration(seconds);
    animation
}

fn as_object<T: objc2::Message>(value: &T) -> &AnyObject {
    // Every Objective-C object is an AnyObject; the cast only forgets its class.
    unsafe { &*(value as *const T).cast::<AnyObject>() }
}
