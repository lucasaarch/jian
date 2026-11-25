//! Times as the log and state.json write them: ISO 8601 in UTC with milliseconds, the form the
//! Node worker wrote, so `status` and `logs` read either.

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// The current UTC time as an ISO 8601 string with milliseconds, as the logs and state file write it.
pub fn now_iso() -> String {
    iso(now_ms())
}

/// `ms` since the Unix epoch as `2026-05-01T12:34:56.789Z`.
pub fn iso(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let rest = ms % 86_400_000;
    let (year, month, day) = civil(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

/// What [`iso`] wrote, back to ms since the epoch; `None` for anything else.
pub fn parse_iso(text: &str) -> Option<u64> {
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<u64>().ok();
    if text.len() != 24 || !text.ends_with('Z') {
        return None;
    }
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second, ms) = (
        number(11..13)?,
        number(14..16)?,
        number(17..19)?,
        number(20..23)?,
    );
    let days = days_from_civil(
        i64::try_from(year).ok()?,
        u32::try_from(month).ok()?,
        u32::try_from(day).ok()?,
    );
    let day_ms = ((hour * 60 + minute) * 60 + second) * 1000 + ms;
    u64::try_from(days)
        .ok()
        .map(|days| days * 86_400_000 + day_ms)
}

/// The inverse of [`civil`] (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let mp = i64::from((month + 9) % 12);
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's `civil_from_days`).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    #[test]
    fn formats_as_javascript_to_iso_string() {
        assert_eq!(super::iso(0), "1970-01-01T00:00:00.000Z");
        // 2024-02-29T23:59:59.999Z, a leap day.
        assert_eq!(super::iso(1_709_251_199_999), "2024-02-29T23:59:59.999Z");
        assert_eq!(
            super::parse_iso("2024-02-29T23:59:59.999Z"),
            Some(1_709_251_199_999)
        );
        assert_eq!(super::parse_iso("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(super::parse_iso("yesterday"), None);
    }
}
