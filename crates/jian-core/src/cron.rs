//! Five-field cron expressions and the next instant they fire in a time zone.
//!
//! Pure arithmetic on instants (Unix milliseconds): the caller passes the instant to count from,
//! so the same expression gives the same answer in a test and in production. The time zone
//! database is bundled with the build (see `jiff`'s `tzdb-bundle-always`), so a host's own
//! zoneinfo never changes a result.
//!
//! # Daylight saving
//!
//! The expression is read in the zone's wall clock. A wall time that does not exist (the hour
//! skipped when clocks go forward) fires at the moment the clock jumps to, once. A wall time that
//! happens twice (clocks go back) fires at the first of them only.

use jiff::civil::Date;
use jiff::tz::TimeZone;

/// The shortest gap accepted between two runs of one expression.
pub const MIN_CRON_INTERVAL_MS: i64 = 5 * 60 * 1000;
/// How many days ahead [`Cron::next_after`] looks: enough for a 29 February after a leap gap.
const HORIZON_DAYS: u32 = 366 * 8;
/// How many runs [`Cron::parse`] samples to check the shortest gap.
const SAMPLE_RUNS: usize = 24;

/// Why an expression or a zone was refused. The text names the part, never a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CronError {
    /// Not five space-separated fields.
    Shape,
    /// A field has a value, range or step outside what it allows.
    Field(&'static str),
    /// The zone is not in the time zone database.
    Zone,
    /// It fires more often than [`MIN_CRON_INTERVAL_MS`], or never (`0 0 30 2 *`).
    Interval,
}

impl std::fmt::Display for CronError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Shape => formatter.write_str("a cron expression has five fields"),
            Self::Field(name) => write!(formatter, "the {name} field is not valid"),
            Self::Zone => formatter.write_str("unknown time zone"),
            Self::Interval => formatter.write_str("it must fire at most every 5 minutes"),
        }
    }
}

impl std::error::Error for CronError {}

/// A parsed expression: the set of values each field allows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cron {
    minutes: u64,
    hours: u64,
    days: u64,
    months: u64,
    weekdays: u64,
    day_restricted: bool,
    weekday_restricted: bool,
}

/// `minute hour day-of-month month day-of-week`, as lists, ranges and steps (`*/15`, `1-5`,
/// `1,3`). Day of week is `0`-`7` with both `0` and `7` for Sunday. When both day fields are
/// restricted, a day matches if either does, as in Vixie cron.
fn field(text: &str, min: u32, max: u32, name: &'static str) -> Result<u64, CronError> {
    let bad = CronError::Field(name);
    let mut set = 0_u64;
    for part in text.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => (range, step.parse::<u32>().map_err(|_| bad)?),
            None => (part, 1),
        };
        if step == 0 {
            return Err(bad);
        }
        let (low, high) = if range == "*" {
            (min, max)
        } else if let Some((low, high)) = range.split_once('-') {
            (
                low.parse::<u32>().map_err(|_| bad)?,
                high.parse::<u32>().map_err(|_| bad)?,
            )
        } else {
            let value = range.parse::<u32>().map_err(|_| bad)?;
            // `5/10` means from 5 to the top in steps of 10.
            (value, if part.contains('/') { max } else { value })
        };
        if low < min || high > max || low > high {
            return Err(bad);
        }
        let mut value = low;
        while value <= high {
            set |= 1 << value;
            value += step;
        }
    }
    Ok(set)
}

impl Cron {
    /// Reads an expression, and refuses one that fires more often than every five minutes.
    ///
    /// # Errors
    /// [`CronError`] says which part is wrong.
    pub fn parse(text: &str) -> Result<Self, CronError> {
        let fields: Vec<&str> = text.split_whitespace().collect();
        let [minute, hour, day, month, weekday] = fields[..] else {
            return Err(CronError::Shape);
        };
        let mut weekdays = field(weekday, 0, 7, "day of week")?;
        if weekdays & (1 << 7) != 0 {
            weekdays = (weekdays | 1) & !(1 << 7);
        }
        let cron = Self {
            minutes: field(minute, 0, 59, "minute")?,
            hours: field(hour, 0, 23, "hour")?,
            days: field(day, 1, 31, "day of month")?,
            months: field(month, 1, 12, "month")?,
            weekdays,
            day_restricted: day != "*",
            weekday_restricted: weekday != "*",
        };
        cron.check_interval()?;
        Ok(cron)
    }

    /// Samples the runs after a fixed instant in UTC: the same shortest gap holds in any zone
    /// except around a clock change, which is not a reason to refuse an expression.
    fn check_interval(&self) -> Result<(), CronError> {
        let mut at = 1_704_067_200_000; // 2024-01-01T00:00:00Z
        for _ in 0..SAMPLE_RUNS {
            let next = self
                .next_after("UTC", at)
                .map_err(|_| CronError::Interval)?
                .ok_or(CronError::Interval)?;
            if at != 1_704_067_200_000 && next - at < MIN_CRON_INTERVAL_MS {
                return Err(CronError::Interval);
            }
            at = next;
        }
        Ok(())
    }

    fn day_matches(&self, date: Date) -> bool {
        let month = self.months & (1 << date.month()) != 0;
        let day = self.days & (1 << date.day()) != 0;
        let weekday = self.weekdays & (1 << date.weekday().to_sunday_zero_offset()) != 0;
        let either = match (self.day_restricted, self.weekday_restricted) {
            (true, true) => day || weekday,
            (true, false) => day,
            (false, true) => weekday,
            (false, false) => true,
        };
        month && either
    }

    /// The first instant strictly after `after_ms` (Unix milliseconds) at which the expression
    /// fires in `zone`, an IANA name such as `America/Sao_Paulo`. `None` when it never does
    /// within eight years (`0 0 30 2 *`).
    ///
    /// # Errors
    /// [`CronError::Zone`] for a name the database does not have, or an instant out of range.
    pub fn next_after(&self, zone: &str, after_ms: i64) -> Result<Option<i64>, CronError> {
        let tz = TimeZone::get(zone).map_err(|_| CronError::Zone)?;
        let start = jiff::Timestamp::from_millisecond(after_ms).map_err(|_| CronError::Zone)?;
        let mut date = tz.to_datetime(start).date();
        for _ in 0..HORIZON_DAYS {
            if self.day_matches(date) {
                for hour in (0..24_i8).filter(|h| self.hours & (1 << h) != 0) {
                    for minute in (0..60_i8).filter(|m| self.minutes & (1 << m) != 0) {
                        let Ok(instant) = tz
                            .to_ambiguous_timestamp(date.at(hour, minute, 0, 0))
                            .compatible()
                        else {
                            continue;
                        };
                        let at = instant.as_millisecond();
                        if at > after_ms {
                            return Ok(Some(at));
                        }
                    }
                }
            }
            let Ok(tomorrow) = date.tomorrow() else {
                return Ok(None);
            };
            date = tomorrow;
        }
        Ok(None)
    }
}

/// Reads an ISO 8601 instant that carries an offset (`2027-01-05T09:00:00-03:00`, or `Z`) as
/// Unix milliseconds. A time with no offset is refused: it would mean the server's zone.
#[must_use]
pub fn parse_instant_ms(text: &str) -> Option<i64> {
    text.parse::<jiff::Timestamp>()
        .ok()
        .map(jiff::Timestamp::as_millisecond)
}

/// Whether `zone` is a name the bundled database knows.
#[must_use]
pub fn is_time_zone(zone: &str) -> bool {
    TimeZone::get(zone).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(iso: &str) -> i64 {
        iso.parse::<jiff::Timestamp>().unwrap().as_millisecond()
    }

    #[test]
    fn daily_run_keeps_its_wall_clock_across_a_clock_change() {
        let cron = Cron::parse("30 9 * * *").unwrap();
        // New York goes forward on 2025-03-09: 09:30 is 14:30Z before it and 13:30Z after.
        let before = cron
            .next_after("America/New_York", at("2025-03-08T15:00:00Z"))
            .unwrap();
        assert_eq!(before, Some(at("2025-03-09T13:30:00Z")));
        let before = cron
            .next_after("America/New_York", at("2025-03-07T15:00:00Z"))
            .unwrap();
        assert_eq!(before, Some(at("2025-03-08T14:30:00Z")));
    }

    #[test]
    fn a_skipped_wall_time_fires_once_when_the_clock_jumps() {
        let cron = Cron::parse("30 2 * * *").unwrap();
        // 02:30 does not exist on 2025-03-09 in New York; the clock goes 02:00 -> 03:00 (07:00Z).
        let first = cron
            .next_after("America/New_York", at("2025-03-09T00:00:00Z"))
            .unwrap();
        assert_eq!(first, Some(at("2025-03-09T07:30:00Z")));
        let second = cron.next_after("America/New_York", first.unwrap()).unwrap();
        assert_eq!(second, Some(at("2025-03-10T06:30:00Z")));
    }

    #[test]
    fn a_repeated_wall_time_fires_on_its_first_pass_only() {
        let cron = Cron::parse("30 1 * * *").unwrap();
        // Clocks go back on 2025-11-02: 01:30 happens at 05:30Z and again at 06:30Z.
        let first = cron
            .next_after("America/New_York", at("2025-11-02T00:00:00Z"))
            .unwrap();
        assert_eq!(first, Some(at("2025-11-02T05:30:00Z")));
        let next = cron.next_after("America/New_York", first.unwrap()).unwrap();
        assert_eq!(next, Some(at("2025-11-03T06:30:00Z")));
    }

    #[test]
    fn next_counts_from_the_instant_it_is_given_without_drift() {
        let cron = Cron::parse("*/15 * * * *").unwrap();
        let due = at("2025-06-01T12:15:00Z");
        assert_eq!(
            cron.next_after("UTC", due).unwrap(),
            Some(due + 15 * 60_000)
        );
        // Late by a minute and a half: the next one is still on the grid.
        assert_eq!(
            cron.next_after("UTC", due + 90_000).unwrap(),
            Some(due + 15 * 60_000)
        );
    }

    #[test]
    fn day_of_month_or_weekday_when_both_are_restricted() {
        let cron = Cron::parse("0 8 13 * 5").unwrap();
        // Friday 2025-06-06 matches by weekday although it is not the 13th.
        assert_eq!(
            cron.next_after("UTC", at("2025-06-05T00:00:00Z")).unwrap(),
            Some(at("2025-06-06T08:00:00Z"))
        );
    }

    #[test]
    fn leap_day_is_found_years_ahead() {
        let cron = Cron::parse("0 0 29 2 *").unwrap();
        assert_eq!(
            cron.next_after("UTC", at("2025-03-01T00:00:00Z")).unwrap(),
            Some(at("2028-02-29T00:00:00Z"))
        );
        // A date that never exists is refused when the expression is read.
        assert_eq!(Cron::parse("0 0 30 2 *"), Err(CronError::Interval));
    }

    #[test]
    fn refuses_what_is_wrong_or_too_frequent() {
        assert_eq!(Cron::parse("* * * *"), Err(CronError::Shape));
        assert_eq!(Cron::parse("61 * * * *"), Err(CronError::Field("minute")));
        assert_eq!(Cron::parse("*/0 * * * *"), Err(CronError::Field("minute")));
        assert_eq!(Cron::parse("* * * * *"), Err(CronError::Interval));
        assert_eq!(Cron::parse("*/4 * * * *"), Err(CronError::Interval));
        assert!(Cron::parse("*/5 * * * *").is_ok());
        assert!(Cron::parse("0 9 * * 7").is_ok());
        assert_eq!(
            Cron::parse("0 9 * * *").unwrap().next_after("Not/AZone", 0),
            Err(CronError::Zone)
        );
        assert!(is_time_zone("Europe/Lisbon") && !is_time_zone("Mars/Base"));
    }
}
