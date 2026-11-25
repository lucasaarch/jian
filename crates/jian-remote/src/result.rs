//! Fitting a result into one text frame the gateway accepts.

use jian_protocol::machine::{RESULT_BUDGET_BYTES, TaskResult, WorkerMessage};

use crate::ends::keep_ends;

/// What a result's own fields add around a files answer, in bytes. A files answer is already
/// held to its limits by the files worker and cannot be shrunk here.
const ENVELOPE_SLACK: usize = 1_000;
const OMITTED: &str = "Result omitted: payload exceeded the gateway size limit after truncation.";

fn pack(result: &TaskResult) -> String {
    serde_json::to_string(&WorkerMessage::Result(result.clone())).unwrap_or_default()
}

/// The result as the frame that carries it, its output cut from the middle until it fits
/// `budget` bytes: the end of an output is where a failure says what went wrong.
pub fn fit_result(mut result: TaskResult, budget: usize) -> (TaskResult, String) {
    let budget = if result.files.is_some() {
        budget + ENVELOPE_SLACK
    } else {
        budget
    };
    let mut body = pack(&result);
    while body.len() > budget && !result.stdout.is_empty() {
        let overflow = body.len() - budget;
        let length = result.stdout.chars().count();
        result.stdout = keep_ends(&result.stdout, length.saturating_sub(overflow.max(2048)));
        body = pack(&result);
        if result.stdout.chars().count() <= 200 {
            break;
        }
    }
    while body.len() > budget && !result.stderr.is_empty() {
        let overflow = body.len() - budget;
        let length = result.stderr.chars().count();
        result.stderr = keep_ends(&result.stderr, length.saturating_sub(overflow.max(1024)));
        body = pack(&result);
        if result.stderr.chars().count() <= 200 {
            break;
        }
    }
    if body.len() > budget {
        result.stdout.clear();
        result.stderr = OMITTED.into();
        body = pack(&result);
    }
    (result, body)
}

/// Shrinks a result until its JSON fits [`jian_protocol::machine::RESULT_BUDGET_BYTES`], returning it with the serialized form.
pub fn fit(result: TaskResult) -> (TaskResult, String) {
    fit_result(result, RESULT_BUDGET_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_huge_output_is_cut_to_fit_and_keeps_its_end() {
        let result = TaskResult {
            id: "t1".into(),
            exit_code: Some(1),
            stdout: format!("{}FAILED: the last line", "é".repeat(400_000)),
            ..TaskResult::default()
        };
        let (fitted, body) = fit(result);
        assert!(body.len() <= RESULT_BUDGET_BYTES);
        assert!(fitted.stdout.ends_with("FAILED: the last line"));
        assert!(fitted.stdout.contains("of this output were not kept"));
    }

    #[test]
    fn a_small_result_goes_as_it_is() {
        let result = TaskResult {
            id: "t1".into(),
            exit_code: Some(0),
            stdout: "ok".into(),
            ..TaskResult::default()
        };
        let (fitted, _) = fit(result.clone());
        assert_eq!(fitted, result);
    }
}
