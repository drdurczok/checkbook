use chrono::{DateTime, Datelike, Duration, NaiveDate, Timelike, Utc, Weekday};
use chrono_tz::America::New_York;
use rust_decimal::Decimal;

/// Yahoo's US equity symbols, including share classes such as BRK-B.
pub fn normalize_ticker(value: Option<&str>) -> Result<Option<String>, &'static str> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let value = value.to_ascii_uppercase();
    if value.len() > 15
        || !value.as_bytes()[0].is_ascii_alphabetic()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
        || value.ends_with('-')
        || value.contains("--")
    {
        return Err("Ticker must be a US stock or ETF symbol (for example AAPL or BRK-B).");
    }
    Ok(Some(value))
}

#[derive(Debug, Clone, PartialEq)]
pub struct DailyClose {
    pub close: Decimal,
    pub price_date: NaiveDate,
}

pub fn select_completed_close(
    bars: &[(DateTime<Utc>, Option<Decimal>)],
    now: DateTime<Utc>,
    regular_end: DateTime<Utc>,
    precision: u32,
) -> Option<DailyClose> {
    let today = now.with_timezone(&New_York).date_naive();
    bars.iter()
        .filter_map(|(at, close)| {
            let date = at.with_timezone(&New_York).date_naive();
            let close = (*close)?;
            if matches!(date.weekday(), Weekday::Sat | Weekday::Sun)
                || at > &now
                || close.round_dp(precision.clamp(2, 6)) <= Decimal::ZERO
                || date > today
                || date < today - Duration::days(7)
                || (date == today
                    && (regular_end.with_timezone(&New_York).date_naive() != today
                        || now < regular_end + Duration::minutes(20)))
            {
                return None;
            }
            Some(DailyClose {
                close: close.round_dp(precision.clamp(2, 6)),
                price_date: date,
            })
        })
        .max_by_key(|bar| bar.price_date)
}

/// A refresh window changes after the normal close plus publication delay,
/// not at midnight (which would cache yesterday's bar through today's close).
pub fn refresh_window(at: DateTime<Utc>) -> NaiveDate {
    let local = at.with_timezone(&New_York);
    let date = local.date_naive();
    if local.hour() < 16 || (local.hour() == 16 && local.minute() < 20) {
        date.pred_opt().unwrap_or(date)
    } else {
        date
    }
}

pub fn refresh_due(
    last_attempt: Option<DateTime<Utc>>,
    last_success: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    if let Some(attempt) = last_attempt {
        if now < attempt + Duration::minutes(30) {
            return false;
        }
        if last_success == Some(attempt)
            && refresh_window(attempt) == refresh_window(now)
            && now < attempt + Duration::hours(1)
        {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    #[test]
    fn symbols_are_normalized_and_restricted() {
        assert_eq!(normalize_ticker(Some(" brk-b ")), Ok(Some("BRK-B".into())));
        assert_eq!(normalize_ticker(Some(" ")), Ok(None));
        for symbol in ["AAPL.L", "^GSPC", "=X", "../A", "A--B", "A-", "123"] {
            assert!(normalize_ticker(Some(symbol)).is_err());
        }
    }
    #[test]
    fn weekend_null_and_invalid_bars_preserve_friday_close() -> anyhow::Result<()> {
        let now = Utc
            .with_ymd_and_hms(2026, 11, 8, 17, 0, 0)
            .single()
            .ok_or_else(|| anyhow::anyhow!("date"))?;
        let friday = now - Duration::days(2);
        let bars = [
            (friday, Some("99.125".parse()?)),
            (now, None),
            (now, Some("0.00001".parse()?)),
            (now + Duration::days(1), Some(Decimal::ONE)),
        ];
        assert_eq!(
            select_completed_close(&bars, now, friday, 2).map(|price| price.close),
            Some("99.12".parse()?)
        );
        assert!(
            select_completed_close(
                &[(now - Duration::days(8), Some(Decimal::ONE))],
                now,
                friday,
                2
            )
            .is_none()
        );
        Ok(())
    }
    #[test]
    fn early_close_and_dst_cadence() -> anyhow::Result<()> {
        for (month, day, utc_hour) in [(7, 2, 17), (11, 27, 18)] {
            let end = Utc
                .with_ymd_and_hms(2026, month, day, utc_hour, 0, 0)
                .single()
                .ok_or_else(|| anyhow::anyhow!("date"))?;
            let bars = [(end - Duration::hours(3), Some(Decimal::ONE))];
            assert!(select_completed_close(&bars, end + Duration::minutes(19), end, 2).is_none());
            assert!(select_completed_close(&bars, end + Duration::minutes(20), end, 2).is_some());
            assert!(!refresh_due(
                Some(end),
                Some(end),
                end + Duration::minutes(59)
            ));
            assert!(refresh_due(
                Some(end),
                Some(end),
                end + Duration::minutes(60)
            ));
        }
        Ok(())
    }
    #[test]
    fn close_is_completed_and_decimal_rounded() -> anyhow::Result<()> {
        let now = Utc
            .with_ymd_and_hms(2026, 11, 4, 21, 10, 0)
            .single()
            .ok_or_else(|| anyhow::anyhow!("date"))?;
        let end = now - Duration::minutes(10);
        let bars = vec![
            (now - Duration::days(1), Some("332.8900146484375".parse()?)),
            (now, Some("349.3901062011719".parse()?)),
        ];
        assert_eq!(
            select_completed_close(&bars, now, end, 2).map(|bar| bar.close),
            Some("332.89".parse()?)
        );
        assert_eq!(
            select_completed_close(&bars, now + Duration::minutes(10), end, 2).map(|bar| bar.close),
            Some("349.39".parse()?)
        );
        assert!(refresh_due(
            Some(now),
            Some(now),
            now + Duration::minutes(31)
        ));
        assert!(!refresh_due(Some(now), None, now + Duration::minutes(29)));
        Ok(())
    }
}
