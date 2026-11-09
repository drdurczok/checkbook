//! Pure, anchor-based recurring expense dates. No clock or persistence is consulted.

use chrono::{Datelike, Days, Months, NaiveDate};

/// Maximum inclusive query-window span, in days (approximately 100 years).
pub const MAX_RECURRING_RANGE_DAYS: i64 = 36_600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecurringOccurrence {
    /// Zero-based position in the original schedule, not in the query window.
    pub index: u32,
    pub date: NaiveDate,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RecurringError {
    #[error("invalid recurring cadence")]
    InvalidCadence,
    #[error("recurring end date precedes its start date")]
    InvalidScheduleRange,
    #[error("recurring query end precedes its start")]
    InvalidQueryRange,
    #[error("recurring query range exceeds 36600 days")]
    RangeTooLarge,
    #[error("recurring date is outside the supported calendar range")]
    DateOutOfRange,
}

#[derive(Clone, Copy)]
enum RecurringCadence {
    Days(u32),
    Months(u32),
}

impl RecurringCadence {
    fn parse(value: &str) -> Result<Self, RecurringError> {
        match value {
            "weekly" => Ok(Self::Days(7)),
            "biweekly" => Ok(Self::Days(14)),
            "" | "monthly" => Ok(Self::Months(1)),
            "quarterly" => Ok(Self::Months(3)),
            "yearly" => Ok(Self::Months(12)),
            _ => Err(RecurringError::InvalidCadence),
        }
    }

    fn date(self, start: NaiveDate, index: u32) -> Result<NaiveDate, RecurringError> {
        let date = match self {
            Self::Days(days) => {
                start.checked_add_days(Days::new(u64::from(days) * u64::from(index)))
            }
            Self::Months(months) => {
                let months = months
                    .checked_mul(index)
                    .ok_or(RecurringError::DateOutOfRange)?;
                // Always shift the original anchor, never a previously clamped date.
                start.checked_add_months(Months::new(months))
            }
        };
        date.ok_or(RecurringError::DateOutOfRange)
    }

    fn index_at_or_before(self, start: NaiveDate, date: NaiveDate) -> Result<u32, RecurringError> {
        let index = match self {
            Self::Days(days) => (date - start).num_days() / i64::from(days),
            Self::Months(months) => {
                let elapsed = (i64::from(date.year()) - i64::from(start.year())) * 12
                    + i64::from(date.month0())
                    - i64::from(start.month0());
                elapsed / i64::from(months)
            }
        };
        u32::try_from(index).map_err(|_| RecurringError::DateOutOfRange)
    }
}

/// Return a zero-based schedule date, clamping short months to their final day.
///
/// Accepted cadences are `weekly`, `biweekly`, `monthly`, `quarterly`, and
/// `yearly`. An empty cadence defaults to monthly. The original day is restored
/// after a short month; for example, yearly February 29 returns on leap years.
pub fn recurring_date(
    start: NaiveDate,
    cadence: &str,
    index: u32,
) -> Result<NaiveDate, RecurringError> {
    RecurringCadence::parse(cadence)?.date(start, index)
}

/// Return occurrences within inclusive query and optional schedule-end bounds.
///
/// Indices refer to the original schedule, whose first occurrence is `start`.
/// Reversed query/schedule bounds are errors; disjoint valid ranges are empty.
/// Query windows spanning more than [`MAX_RECURRING_RANGE_DAYS`] days are rejected
/// rather than silently truncated. Generation seeks directly to the window, so
/// an old schedule does not require visiting its historical occurrences.
pub fn recurring_occurrences(
    start: NaiveDate,
    end: Option<NaiveDate>,
    cadence: &str,
    from: NaiveDate,
    until: NaiveDate,
) -> Result<Vec<RecurringOccurrence>, RecurringError> {
    let cadence = RecurringCadence::parse(cadence)?;
    if end.is_some_and(|end| end < start) {
        return Err(RecurringError::InvalidScheduleRange);
    }
    if until < from {
        return Err(RecurringError::InvalidQueryRange);
    }
    if (until - from).num_days() > MAX_RECURRING_RANGE_DAYS {
        return Err(RecurringError::RangeTooLarge);
    }
    let from = from.max(start);
    let until = end.map_or(until, |end| until.min(end));
    if until < from {
        return Ok(Vec::new());
    }
    let first = cadence.index_at_or_before(start, from)?;
    let last = cadence.index_at_or_before(start, until)?;
    let mut occurrences = Vec::new();
    for index in first..=last {
        let date = cadence.date(start, index)?;
        if date >= from && date <= until {
            occurrences.push(RecurringOccurrence { index, date });
        }
    }
    Ok(occurrences)
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_RECURRING_RANGE_DAYS, RecurringError, RecurringOccurrence, recurring_date,
        recurring_occurrences,
    };
    use chrono::{Days, NaiveDate};

    #[test]
    fn calendar_cadences_restore_the_original_anchor() -> anyhow::Result<()> {
        for (start, cadence, index, expected) in [
            ("2025-01-31", "monthly", 1, "2025-02-28"),
            ("2025-01-31", "monthly", 2, "2025-03-31"),
            ("2024-01-31", "monthly", 1, "2024-02-29"),
            ("2024-01-31", "", 2, "2024-03-31"),
            ("2023-11-30", "quarterly", 1, "2024-02-29"),
            ("2023-11-30", "quarterly", 2, "2024-05-30"),
            ("2024-02-29", "yearly", 1, "2025-02-28"),
            ("2024-02-29", "yearly", 4, "2028-02-29"),
            ("2096-02-29", "yearly", 4, "2100-02-28"),
            ("2096-02-29", "yearly", 8, "2104-02-29"),
            ("2025-04-30", "monthly", 1, "2025-05-30"),
        ] {
            assert_eq!(
                recurring_date(start.parse()?, cadence, index)?,
                expected.parse::<NaiveDate>()?
            );
        }
        Ok(())
    }

    #[test]
    fn day_cadences_cross_month_and_year_boundaries() -> anyhow::Result<()> {
        let start = "2023-12-29".parse()?;
        assert_eq!(
            recurring_date(start, "weekly", 1)?,
            "2024-01-05".parse::<NaiveDate>()?
        );
        assert_eq!(
            recurring_date(start, "biweekly", 1)?,
            "2024-01-12".parse::<NaiveDate>()?
        );
        assert_eq!(
            recurring_date("2024-02-23".parse()?, "weekly", 1)?,
            "2024-03-01".parse::<NaiveDate>()?
        );
        for cadence in ["weekly", "biweekly", "monthly", "quarterly", "yearly", ""] {
            assert_eq!(recurring_date(start, cadence, 0)?, start);
        }
        Ok(())
    }

    #[test]
    fn windows_and_schedule_end_are_inclusive_and_keep_original_indices() -> anyhow::Result<()> {
        let start = "2024-01-31".parse()?;
        let end = "2024-03-31".parse()?;
        assert_eq!(
            recurring_occurrences(
                start,
                Some(end),
                "monthly",
                "2024-02-29".parse()?,
                "2024-12-31".parse()?
            )?,
            vec![
                RecurringOccurrence {
                    index: 1,
                    date: "2024-02-29".parse()?
                },
                RecurringOccurrence {
                    index: 2,
                    date: end
                },
            ]
        );
        assert_eq!(
            recurring_occurrences(start, Some(start), "monthly", start, start)?,
            vec![RecurringOccurrence {
                index: 0,
                date: start
            }]
        );
        assert!(
            recurring_occurrences(
                start,
                Some(end),
                "monthly",
                "2024-04-01".parse()?,
                "2024-05-01".parse()?
            )?
            .is_empty()
        );
        assert!(
            recurring_occurrences(
                start,
                None,
                "monthly",
                "2023-01-01".parse()?,
                "2023-12-31".parse()?
            )?
            .is_empty()
        );
        assert!(
            recurring_occurrences(
                start,
                None,
                "monthly",
                "2024-03-01".parse()?,
                "2024-03-30".parse()?
            )?
            .is_empty()
        );
        Ok(())
    }

    #[test]
    fn weekly_and_biweekly_generation_seek_and_respect_end() -> anyhow::Result<()> {
        let start: NaiveDate = "2000-01-01".parse()?;
        for cadence in ["weekly", "biweekly"] {
            let from = recurring_date(start, cadence, 1000)?;
            let end = recurring_date(start, cadence, 1002)?;
            let occurrences = recurring_occurrences(
                start,
                Some(end),
                cadence,
                from,
                recurring_date(start, cadence, 1003)?,
            )?;
            assert_eq!(occurrences.len(), 3);
            assert_eq!(
                occurrences[0],
                RecurringOccurrence {
                    index: 1000,
                    date: from
                }
            );
            assert_eq!(
                occurrences[2],
                RecurringOccurrence {
                    index: 1002,
                    date: end
                }
            );
            assert!(
                recurring_occurrences(
                    start,
                    None,
                    cadence,
                    from + Days::new(1),
                    recurring_date(start, cadence, 1001)? - Days::new(1)
                )?
                .is_empty()
            );
        }
        Ok(())
    }

    #[test]
    fn calendar_windows_match_direct_dates_without_anchor_drift() -> anyhow::Result<()> {
        let start: NaiveDate = "1996-02-29".parse()?;
        let from: NaiveDate = "2024-02-28".parse()?;
        let until: NaiveDate = "2028-03-01".parse()?;
        for cadence in ["", "monthly", "quarterly", "yearly"] {
            let expected: Vec<_> = (0..400)
                .map(|index| {
                    recurring_date(start, cadence, index)
                        .map(|date| RecurringOccurrence { index, date })
                })
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .filter(|occurrence| occurrence.date >= from && occurrence.date <= until)
                .collect();
            assert_eq!(
                recurring_occurrences(start, None, cadence, from, until)?,
                expected
            );
            assert_eq!(
                recurring_occurrences(start, Some(until), cadence, from, until + Days::new(100))?,
                expected
            );
        }
        Ok(())
    }

    #[test]
    fn rejects_invalid_cadences_ranges_and_overflow() -> anyhow::Result<()> {
        let start: NaiveDate = "2024-01-01".parse()?;
        for cadence in ["daily", "Monthly", " monthly ", "unknown"] {
            assert_eq!(
                recurring_date(start, cadence, 0),
                Err(RecurringError::InvalidCadence)
            );
            assert_eq!(
                recurring_occurrences(start, None, cadence, start, start),
                Err(RecurringError::InvalidCadence)
            );
        }
        assert_eq!(
            recurring_occurrences(start, Some(start - Days::new(1)), "monthly", start, start),
            Err(RecurringError::InvalidScheduleRange)
        );
        assert_eq!(
            recurring_occurrences(start, None, "monthly", start, start - Days::new(1)),
            Err(RecurringError::InvalidQueryRange)
        );
        for cadence in ["weekly", "biweekly", "monthly", "quarterly", "yearly"] {
            assert_eq!(
                recurring_date(NaiveDate::MAX, cadence, 1),
                Err(RecurringError::DateOutOfRange)
            );
            assert_eq!(
                recurring_date(start, cadence, u32::MAX),
                Err(RecurringError::DateOutOfRange)
            );
            assert_eq!(recurring_date(NaiveDate::MIN, cadence, 0)?, NaiveDate::MIN);
            assert_eq!(
                recurring_occurrences(
                    NaiveDate::MAX,
                    None,
                    cadence,
                    NaiveDate::MAX,
                    NaiveDate::MAX
                )?,
                vec![RecurringOccurrence {
                    index: 0,
                    date: NaiveDate::MAX
                }]
            );
        }
        let limit = start + Days::new(MAX_RECURRING_RANGE_DAYS as u64);
        assert!(!recurring_occurrences(start, None, "weekly", start, limit)?.is_empty());
        assert_eq!(
            recurring_occurrences(start, None, "yearly", start, limit + Days::new(1)),
            Err(RecurringError::RangeTooLarge)
        );
        Ok(())
    }
}
