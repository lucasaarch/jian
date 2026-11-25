//! The session against a fake helper in `sh`: the screen is 100×50 points, shot at 200×100
//! pixels, so every coordinate maps to half its value.

use std::time::Duration;

use jian_protocol::machine::{
    ComputerAction, ComputerErrorCode, ComputerSeat, ComputerTask, Delivery,
};
use tokio_util::sync::CancellationToken;

use super::*;

const SCREEN: &str = r#"while IFS= read -r line; do
  case "$line" in
    *'"cmd":"geometry"'*) echo '{"ok":true,"originX":0,"originY":0,"pointWidth":100,"pointHeight":50}' ;;
    *'"cmd":"screenshot"'*) echo '{"ok":true,"base64":"AAAA","widthPx":200,"heightPx":100}' ;;
    *'"cmd":"key"'*) echo '{"ok":false,"error":"Refused chord.","code":"policy_denied","delivery":"not_delivered"}' ;;
    *) echo '{"ok":true}' ;;
  esac
done"#;

/// Starts, and then never answers a screenshot.
const STUCK: &str = r#"while IFS= read -r line; do
  case "$line" in
    *'"cmd":"geometry"'*) sleep 5 ;;
    *) echo '{"ok":true}' ;;
  esac
done"#;

fn session(script: &str) -> ComputerSession {
    ComputerSession::new(Some(HelperCommand {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
    }))
}

fn task(action: ComputerAction, seat: &str, coordinate: Option<[i64; 2]>) -> ComputerTask {
    ComputerTask {
        action,
        coordinate,
        start_coordinate: None,
        text: None,
        key: Some("cmd+q".into()),
        scroll_direction: None,
        scroll_amount: None,
        duration: None,
        session: Some(ComputerSeat {
            id: seat.into(),
            name: seat.into(),
            color: "#336699".into(),
        }),
    }
}

#[tokio::test]
async fn coordinates_are_pixels_of_the_last_screenshot() {
    let session = session(SCREEN);
    let early = session
        .act(&task(ComputerAction::LeftClick, "a", Some([1, 1])))
        .await
        .unwrap_err();
    assert_eq!(early.code, ComputerErrorCode::InvalidArgs);

    let shot = session
        .act(&task(ComputerAction::Screenshot, "a", None))
        .await
        .unwrap();
    assert_eq!((shot.width_px, shot.height_px), (Some(200), Some(100)));
    assert_eq!(shot.scale.unwrap().image_to_point_x, 0.5);
    assert_eq!(shot.stdout, "AAAA");

    session
        .act(&task(ComputerAction::LeftClick, "a", Some([199, 99])))
        .await
        .unwrap();
    let outside = session
        .act(&task(ComputerAction::LeftClick, "a", Some([200, 10])))
        .await
        .unwrap_err();
    assert_eq!(
        (outside.code, outside.delivery),
        (ComputerErrorCode::InvalidArgs, Delivery::NotDelivered)
    );

    let refused = session
        .act(&task(ComputerAction::Key, "a", None))
        .await
        .unwrap_err();
    assert_eq!(
        (refused.code, refused.message.as_str()),
        (ComputerErrorCode::PolicyDenied, "Refused chord.")
    );
    session.end().await;
    assert!(!session.helper_running().await);
}

#[tokio::test]
async fn a_seat_is_refused_a_screen_another_one_changed() {
    let session = session(SCREEN);
    session
        .act(&task(ComputerAction::Screenshot, "a", None))
        .await
        .unwrap();
    session
        .act(&task(ComputerAction::Screenshot, "b", None))
        .await
        .unwrap();
    session
        .act(&task(ComputerAction::LeftClick, "a", Some([5, 5])))
        .await
        .unwrap();

    let refused = session
        .act(&task(ComputerAction::LeftClick, "b", Some([5, 5])))
        .await
        .unwrap_err();
    assert_eq!(
        (refused.code, refused.delivery),
        (ComputerErrorCode::ScreenChanged, Delivery::NotDelivered)
    );

    session
        .act(&task(ComputerAction::Screenshot, "b", None))
        .await
        .unwrap();
    session
        .act(&task(ComputerAction::LeftClick, "b", Some([5, 5])))
        .await
        .unwrap();
    session.end().await;
}

#[tokio::test]
async fn a_stuck_action_is_given_up_and_its_helper_killed() {
    let session = session(STUCK);
    let cancel = CancellationToken::new();
    let screenshot = task(ComputerAction::Screenshot, "a", None);
    let result = run_computer_task(
        "t1",
        &screenshot,
        Duration::from_millis(300),
        &cancel,
        &session,
    )
    .await;
    assert!(result.timed_out);
    assert_eq!(result.exit_code, None);
    let outcome = result.computer.unwrap();
    assert_eq!(
        (outcome.code, outcome.delivery),
        (Some(ComputerErrorCode::Timeout), Some(Delivery::Uncertain))
    );
    assert!(!session.helper_running().await);

    cancel.cancel();
    let result = run_computer_task(
        "t2",
        &screenshot,
        Duration::from_secs(30),
        &cancel,
        &session,
    )
    .await;
    assert!(result.cancelled && !result.timed_out);
}
