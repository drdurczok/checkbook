use chrono::{DateTime, Datelike, NaiveDate, Utc};
use chrono_tz::Tz;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TimeZoneError {
    #[error("invalid IANA timezone")]
    InvalidTimeZone,
    #[error("calendar date is outside the supported range")]
    InvalidDate,
}

pub fn local_date_at(timezone: &str, now: DateTime<Utc>) -> Result<NaiveDate, TimeZoneError> {
    let timezone = timezone
        .parse::<Tz>()
        .map_err(|_| TimeZoneError::InvalidTimeZone)?;
    Ok(now.with_timezone(&timezone).date_naive())
}

pub fn month_start_at(timezone: &str, now: DateTime<Utc>) -> Result<NaiveDate, TimeZoneError> {
    let local_date = local_date_at(timezone, now)?;
    month_start(local_date)
}

pub fn month_start(value: NaiveDate) -> Result<NaiveDate, TimeZoneError> {
    value.with_day(1).ok_or(TimeZoneError::InvalidDate)
}

/// Shift calendar months and normalize to day 1, rather than preserving the input day.
pub fn shift_month_start(value: NaiveDate, delta: i32) -> Result<NaiveDate, TimeZoneError> {
    let zero_based = i64::from(value.year()) * 12 + i64::from(value.month0()) + i64::from(delta);
    let year = i32::try_from(zero_based.div_euclid(12)).map_err(|_| TimeZoneError::InvalidDate)?;
    let month =
        u32::try_from(zero_based.rem_euclid(12) + 1).map_err(|_| TimeZoneError::InvalidDate)?;
    NaiveDate::from_ymd_opt(year, month, 1).ok_or(TimeZoneError::InvalidDate)
}

/// Whole calendar months between two dates (day-of-month ignored), clamped
/// to zero when `to` is not after `from`. Used to compound a monthly
/// appreciation/depreciation rate from a valuation's anchor date to today.
pub fn months_between(from: NaiveDate, to: NaiveDate) -> i64 {
    let months =
        (to.year() as i64 - from.year() as i64) * 12 + (to.month() as i64 - from.month() as i64);
    months.max(0)
}

#[cfg(test)]
mod tests {
    use chrono::{NaiveDate, TimeZone, Utc};

    use super::{TimeZoneError, local_date_at, month_start, month_start_at, shift_month_start};

    #[test]
    fn month_shifts_normalize_days_and_cross_calendar_boundaries() -> anyhow::Result<()> {
        for (input, delta, expected) in [
            ("2026-01-31", 0, "2026-01-01"),
            ("2026-01-31", 1, "2026-02-01"),
            ("2024-02-29", 12, "2025-02-01"),
            ("2026-12-31", 1, "2027-01-01"),
            ("2026-01-15", -1, "2025-12-01"),
            ("2026-03-31", -14, "2025-01-01"),
            ("0000-01-31", -1, "-0001-12-01"),
            ("-0001-12-31", 1, "0000-01-01"),
        ] {
            let input: NaiveDate = input.parse()?;
            let expected: NaiveDate = expected.parse()?;
            assert_eq!(shift_month_start(input, delta)?, expected);
            assert_eq!(shift_month_start(input, 0)?, month_start(input)?);
        }
        Ok(())
    }

    #[test]
    fn month_shifts_reject_out_of_range_dates_without_overflow() -> anyhow::Result<()> {
        assert_eq!(shift_month_start(NaiveDate::MIN, 0)?, NaiveDate::MIN);
        assert_eq!(
            shift_month_start(NaiveDate::MAX, 0)?,
            month_start(NaiveDate::MAX)?
        );
        for (input, delta) in [
            (NaiveDate::MIN, -1),
            (NaiveDate::MAX, 1),
            (NaiveDate::MIN, i32::MIN),
            (NaiveDate::MAX, i32::MAX),
        ] {
            assert_eq!(
                shift_month_start(input, delta),
                Err(TimeZoneError::InvalidDate)
            );
        }
        Ok(())
    }

    #[test]
    fn resolves_household_date_across_the_utc_month_boundary() -> anyhow::Result<()> {
        let instant = Utc
            .with_ymd_and_hms(2026, 6, 30, 22, 30, 0)
            .single()
            .ok_or_else(|| anyhow::anyhow!("invalid instant"))?;
        assert_eq!(
            local_date_at("Europe/Warsaw", instant)?.to_string(),
            "2026-07-01"
        );
        assert_eq!(
            month_start_at("Europe/Warsaw", instant)?.to_string(),
            "2026-07-01"
        );
        assert_eq!(
            local_date_at("America/New_York", instant)?.to_string(),
            "2026-06-30"
        );
        Ok(())
    }
}
