//! How a domain's run counts its rows and says how it ended.

use std::fmt::Write as _;

use jian_store::{ImportResult, ImportStatus};

/// How many failures are described in a marker's `detail`; the count says the rest.
const NOTES_KEPT: usize = 5;

/// What a domain's run did, row by row.
#[derive(Debug, Default)]
pub(crate) struct Tally {
    imported: u32,
    already_there: u32,
    failed: u32,
    notes: Vec<String>,
    left_out: u32,
    left_out_reasons: Vec<&'static str>,
}

impl Tally {
    pub(crate) fn imported(&mut self) {
        self.imported += 1;
    }

    pub(crate) fn already_there(&mut self) {
        self.already_there += 1;
    }

    /// A row that did not go in. `why` names the row (an id, an owner) and the reason, never a
    /// value from it.
    pub(crate) fn failed(&mut self, why: String) {
        self.failed += 1;
        if self.notes.len() < NOTES_KEPT {
            self.notes.push(why);
        }
    }

    /// A row that was refused for a reason the data itself carries (a key the core does not
    /// accept, a memory that had ended). It is not a failure: running again would say the same.
    pub(crate) fn left_out(&mut self, reason: &'static str) {
        self.left_out += 1;
        if !self.left_out_reasons.contains(&reason) {
            self.left_out_reasons.push(reason);
        }
    }

    /// `Done` when no row failed, else `Failed` with what the first few said.
    pub(crate) fn finish(self, note: Option<&str>) -> ImportResult {
        let mut detail = self.notes.join("; ");
        let unnamed = (self.failed as usize).saturating_sub(self.notes.len());
        if unnamed > 0 {
            let _ = write!(detail, " (and {unnamed} more)");
        }
        if self.left_out > 0 {
            if !detail.is_empty() {
                detail.push_str("; ");
            }
            let _ = write!(
                detail,
                "{} left out: {}",
                self.left_out,
                self.left_out_reasons.join(", ")
            );
        }
        if let Some(note) = note {
            if !detail.is_empty() {
                detail.push_str("; ");
            }
            detail.push_str(note);
        }
        ImportResult {
            status: if self.failed == 0 {
                ImportStatus::Done
            } else {
                ImportStatus::Failed
            },
            imported: self.imported,
            already_there: self.already_there,
            failed: self.failed,
            detail: (!detail.is_empty()).then_some(detail),
        }
    }
}

/// A domain that did nothing because it lacks something the run was not given.
pub(crate) fn skipped(why: &str) -> ImportResult {
    ImportResult {
        status: ImportStatus::Skipped,
        imported: 0,
        already_there: 0,
        failed: 0,
        detail: Some(why.to_owned()),
    }
}
