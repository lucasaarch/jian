//! An agent's pointer on macOS: the shared dart and, beside it, the agent's name in a pill, in a
//! borderless window above every app that never takes a click or focus. The dart is the image
//! `cursor` draws; the pill and its text are layers, so the name is set in the system font.
//! Core Animation draws the click ripple, so nothing here keeps a timer; it only needs the main
//! run loop the helper runs on.

use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{AnyThread, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSBackingStoreType, NSColor, NSFont, NSFontWeightMedium, NSImage, NSScreen,
    NSStatusWindowLevel, NSView, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_core_foundation::{CFType, CGPoint, CGRect, CGSize};
use objc2_foundation::{NSData, NSDate, NSNumber, NSPoint, NSRunLoop, NSString};
use objc2_quartz_core::{CABasicAnimation, CALayer, CAMediaTiming, CATextLayer, kCATruncationEnd};

use crate::cursor::{
    Art, LABEL_FONT_POINTS, LABELLED_HEIGHT, Look, PILL_HEIGHT, PILL_MARGIN, PILL_MAX_WIDTH,
    PILL_OFFSET, PILL_PADDING, PILL_SHADOW_BLUR, PILL_SHADOW_OFFSET, PILL_SHADOW_OPACITY,
    RIPPLE_RADIUS, RIPPLE_START, RIPPLE_STROKE,
};
use crate::platform::{Pointer, Presence};
use crate::protocol::Point;

/// The dart is drawn once at three pixels a point, sharp on any display there is.
const DART_SCALE: f64 = 3.0;
const RIPPLE: Duration = Duration::from_millis(300);
const ACTIVE_ALPHA: f64 = 0.94;
const IDLE_ALPHA: f64 = 0.18;

struct Overlay {
    window: Retained<NSWindow>,
    sprite: Retained<CALayer>,
    ripple: Retained<CALayer>,
    /// The window's height, and where the tip is in it from its top-left corner, in points.
    height: f64,
    tip: f64,
}

pub struct MacPointer {
    mtm: MainThreadMarker,
    look: Look,
    overlay: Option<Overlay>,
    tip: Option<Point>,
}

impl MacPointer {
    fn overlay(&mut self) -> &Overlay {
        let (mtm, look) = (self.mtm, &self.look);
        self.overlay.get_or_insert_with(|| Overlay::new(mtm, look))
    }

    fn position(&mut self) {
        let Some(tip) = self.tip else { return };
        // AppKit counts from the bottom-left of the primary screen, the protocol from its top-left.
        let screen_height = NSScreen::screens(self.mtm)
            .firstObject()
            .map_or(0.0, |screen| screen.frame().size.height);
        let overlay = self.overlay();
        let origin = NSPoint::new(
            tip.x - overlay.tip,
            screen_height - tip.y - (overlay.height - overlay.tip),
        );
        overlay.window.setFrameOrigin(origin);
    }
}

impl Pointer for MacPointer {
    #[allow(
        clippy::expect_used,
        reason = "the helper answers every request on the main thread; anything else is a bug that must stop the helper"
    )]
    fn new(look: &Look) -> Self {
        Self {
            // The helper answers every request on the main thread, where AppKit lives.
            mtm: MainThreadMarker::new().expect("pointers are made on the main thread"),
            look: look.clone(),
            overlay: None,
            tip: None,
        }
    }

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
        let start = RIPPLE_START / RIPPLE_RADIUS;
        overlay
            .ripple
            .addAnimation_forKey(&animation("transform.scale", start, 1.0, seconds), None);
        overlay
            .ripple
            .addAnimation_forKey(&animation("opacity", 0.6, 0.0, seconds), None);
        // The dart dims and recovers with the ripple, as a press would.
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

/// A session that ends, or an agent that was renamed, takes its window off the screen.
impl Drop for MacPointer {
    fn drop(&mut self) {
        if let Some(overlay) = &self.overlay {
            overlay.window.orderOut(None);
        }
    }
}

impl Overlay {
    #[allow(
        clippy::expect_used,
        reason = "a view made with `wantsLayer` always has a layer"
    )]
    fn new(mtm: MainThreadMarker, look: &Look) -> Self {
        let art = Art::draw(look.color, None, DART_SCALE);
        let dart = CGSize::new(
            art.width as f64 / DART_SCALE,
            art.height as f64 / DART_SCALE,
        );
        let tip = f64::from(art.tip()) / DART_SCALE;
        let color = NSColor::colorWithSRGBRed_green_blue_alpha(
            f64::from(look.color[0]) / 255.0,
            f64::from(look.color[1]) / 255.0,
            f64::from(look.color[2]) / 255.0,
            1.0,
        );
        let pixels_per_point = NSScreen::mainScreen(mtm).map_or(2.0, |s| s.backingScaleFactor());

        // The name first: how wide it sets decides how wide the pill and the window are.
        let label = (!look.label.is_empty()).then(|| {
            let text = CATextLayer::new();
            // SAFETY: `NSFontWeightMedium` is an immutable constant that AppKit defines for the life of the process.
            let font =
                NSFont::systemFontOfSize_weight(LABEL_FONT_POINTS, unsafe { NSFontWeightMedium });
            // SAFETY: `text` and `font` are live objects of the classes these setters belong to, and an `NSFont`
            // is toll-free bridged to the `CTFont` that `setFont` takes.
            unsafe {
                text.setString(Some(as_object(&*NSString::from_str(&look.label))));
                // An NSFont is a CTFont, which is what the layer reads.
                text.setFont(Some(&*Retained::as_ptr(&font).cast::<CFType>()));
            }
            text.setFontSize(LABEL_FONT_POINTS);
            text.setForegroundColor(Some(&NSColor::whiteColor().CGColor()));
            text.setContentsScale(pixels_per_point);
            // A name wider than the pill ends in an ellipsis.
            // SAFETY: `kCATruncationEnd` is an immutable constant that Core Animation defines for the life of the process.
            text.setTruncationMode(unsafe { kCATruncationEnd });
            let wanted = text.preferredFrameSize();
            let size = CGSize::new(
                wanted
                    .width
                    .ceil()
                    .clamp(1.0, PILL_MAX_WIDTH - PILL_PADDING * 2.0),
                wanted.height.ceil().clamp(1.0, PILL_HEIGHT),
            );
            (text, size)
        });
        let pill_width = label
            .as_ref()
            .map(|(_, size)| size.width + PILL_PADDING * 2.0);
        let size = match pill_width {
            Some(pill) => CGSize::new(
                (tip + PILL_OFFSET.0 + pill + PILL_MARGIN).max(dart.width),
                LABELLED_HEIGHT.max(dart.height),
            ),
            None => dart,
        };
        let frame = CGRect::new(CGPoint::new(0.0, 0.0), size);

        // Borderless windows never become key or main, so the pointer cannot take focus.
        // SAFETY: `mtm` proves this is the main thread, which `NSWindow` requires, and `frame` is a plain value.
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
        // SAFETY: this `Retained` owns the window, so AppKit must not release it a second time when it closes.
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

        // Core Animation counts y from the bottom, the measures here from the top: `down` is
        // how far below the window's top edge a layer's lower edge is.
        let from_top = |down: f64| size.height - down;

        // Under everything, a ring in the agent's colour that grows from the tip.
        let ripple = CALayer::new();
        let diameter = RIPPLE_RADIUS * 2.0;
        ripple.setBounds(CGRect::new(
            CGPoint::new(0.0, 0.0),
            CGSize::new(diameter, diameter),
        ));
        ripple.setPosition(CGPoint::new(tip, from_top(tip)));
        ripple.setCornerRadius(RIPPLE_RADIUS);
        ripple.setBorderWidth(RIPPLE_STROKE);
        ripple.setBorderColor(Some(&color.CGColor()));
        ripple.setOpacity(0.0);
        root.addSublayer(&ripple);

        if let (Some((text, text_size)), Some(pill_width)) = (label, pill_width) {
            let pill = CALayer::new();
            pill.setFrame(CGRect::new(
                CGPoint::new(
                    tip + PILL_OFFSET.0,
                    from_top(tip + PILL_OFFSET.1 + PILL_HEIGHT),
                ),
                CGSize::new(pill_width, PILL_HEIGHT),
            ));
            pill.setCornerRadius(PILL_HEIGHT / 2.0);
            pill.setBackgroundColor(Some(&NSColor::blackColor().CGColor()));
            pill.setShadowOpacity(PILL_SHADOW_OPACITY as f32);
            pill.setShadowRadius(PILL_SHADOW_BLUR);
            pill.setShadowOffset(CGSize::new(0.0, -PILL_SHADOW_OFFSET));
            text.setFrame(CGRect::new(
                CGPoint::new(PILL_PADDING, (PILL_HEIGHT - text_size.height) / 2.0),
                text_size,
            ));
            pill.addSublayer(&text);
            root.addSublayer(&pill);
        }

        // The dart last, over the pill's corner, as the other platforms draw it.
        let sprite = CALayer::new();
        sprite.setFrame(CGRect::new(CGPoint::new(0.0, from_top(dart.height)), dart));
        match art.png() {
            Ok(png) => match NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(&png)) {
                // SAFETY: `sprite` is a live layer and `image` a live object; `contents` takes any object.
                Some(image) => unsafe { sprite.setContents(Some(as_object(&*image))) },
                None => eprintln!("computer-helper: the pointer's image did not decode"),
            },
            Err(error) => eprintln!("computer-helper: pointer: {error}"),
        }
        root.addSublayer(&sprite);

        window.setAlphaValue(0.0);
        Self {
            window,
            sprite,
            ripple,
            height: size.height,
            tip,
        }
    }
}

fn animation(key_path: &str, from: f64, to: f64, seconds: f64) -> Retained<CABasicAnimation> {
    let animation = CABasicAnimation::animationWithKeyPath(Some(&NSString::from_str(key_path)));
    // SAFETY: `animation` is a live object and `NSNumber` is a valid value for these properties.
    unsafe {
        animation.setFromValue(Some(as_object(&*NSNumber::new_f64(from))));
        animation.setToValue(Some(as_object(&*NSNumber::new_f64(to))));
    }
    animation.setDuration(seconds);
    animation
}

fn as_object<T: objc2::Message>(value: &T) -> &AnyObject {
    // Every Objective-C object is an AnyObject; the cast only forgets its class.
    // SAFETY: every Objective-C object starts with the layout of `AnyObject`, so the reference stays valid.
    unsafe { &*std::ptr::from_ref::<T>(value).cast::<AnyObject>() }
}
