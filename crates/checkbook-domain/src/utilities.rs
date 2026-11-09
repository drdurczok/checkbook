use std::collections::BTreeSet;

use chrono::{Datelike, NaiveDate};
use rust_decimal::{Decimal, RoundingStrategy};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContractDates {
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContractStatus {
    Scheduled,
    Active,
    Retired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContractPrice {
    pub effective_on: NaiveDate,
    pub price: Decimal,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ContractValidationError {
    #[error("Contract end date must not precede its start date.")]
    EndBeforeStart,
    #[error("Contract prices must not be negative.")]
    NegativePrice,
    #[error("Only one contract price is allowed for {year:04}-{month:02}.")]
    DuplicatePriceMonth { year: i32, month: u32 },
}

pub fn validate_contract_dates(dates: ContractDates) -> Result<(), ContractValidationError> {
    if dates.end_date.is_some_and(|end| end < dates.start_date) {
        return Err(ContractValidationError::EndBeforeStart);
    }
    Ok(())
}

/// Determine status using the caller's household-local date and inclusive end date.
pub fn contract_status(
    dates: ContractDates,
    today: NaiveDate,
) -> Result<ContractStatus, ContractValidationError> {
    validate_contract_dates(dates)?;
    Ok(if today < dates.start_date {
        ContractStatus::Scheduled
    } else if dates.end_date.is_some_and(|end| today > end) {
        ContractStatus::Retired
    } else {
        ContractStatus::Active
    })
}

/// A contract belongs to every calendar month touched by its inclusive date range.
pub fn contract_active_in_month(
    dates: ContractDates,
    month: NaiveDate,
) -> Result<bool, ContractValidationError> {
    validate_contract_dates(dates)?;
    let month = (month.year(), month.month());
    Ok(month >= (dates.start_date.year(), dates.start_date.month())
        && dates
            .end_date
            .is_none_or(|end| month <= (end.year(), end.month())))
}

/// Validate the complete editable history, independently of its input order.
pub fn validate_contract_prices(prices: &[ContractPrice]) -> Result<(), ContractValidationError> {
    let mut months = BTreeSet::new();
    for entry in prices {
        if entry.price < Decimal::ZERO {
            return Err(ContractValidationError::NegativePrice);
        }
        let year = entry.effective_on.year();
        let month = entry.effective_on.month();
        if !months.insert((year, month)) {
            return Err(ContractValidationError::DuplicatePriceMonth { year, month });
        }
    }
    Ok(())
}

/// Prices take effect for the entire effective month, even before `effective_on`'s day.
/// An empty history or a month before the initial price has no effective price.
pub fn effective_contract_price(
    prices: &[ContractPrice],
    month: NaiveDate,
) -> Result<Option<Decimal>, ContractValidationError> {
    validate_contract_prices(prices)?;
    let month = (month.year(), month.month());
    Ok(prices
        .iter()
        .filter(|entry| (entry.effective_on.year(), entry.effective_on.month()) <= month)
        .max_by_key(|entry| (entry.effective_on.year(), entry.effective_on.month()))
        .map(|entry| entry.price))
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum UtilityCalculationError {
    #[error("Meter readings must not decrease.")]
    DecreasingReading,
    #[error("Utility values must not be negative.")]
    NegativeValue,
    #[error("Utility charge exceeds decimal precision.")]
    Overflow,
}

pub fn meter_usage(
    reading: Decimal,
    previous: Option<Decimal>,
) -> Result<Option<Decimal>, UtilityCalculationError> {
    if reading.is_sign_negative() || previous.is_some_and(|value| value.is_sign_negative()) {
        return Err(UtilityCalculationError::NegativeValue);
    }
    match previous {
        Some(previous) if reading < previous => Err(UtilityCalculationError::DecreasingReading),
        Some(previous) => Ok(Some(reading - previous)),
        None => Ok(None),
    }
}

pub fn utility_charge(
    usage: Option<Decimal>,
    rate: Decimal,
) -> Result<Option<Decimal>, UtilityCalculationError> {
    if rate.is_sign_negative() || usage.is_some_and(|value| value.is_sign_negative()) {
        return Err(UtilityCalculationError::NegativeValue);
    }
    usage
        .map(|usage| {
            usage
                .checked_mul(rate)
                .map(|charge| {
                    charge.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
                })
                .ok_or(UtilityCalculationError::Overflow)
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_ranges_allow_open_and_single_day_ranges_but_reject_reversed_dates()
    -> anyhow::Result<()> {
        let start_date = "2026-12-31".parse()?;
        for end_date in [None, Some(start_date), Some("2027-01-01".parse()?)] {
            assert_eq!(
                validate_contract_dates(ContractDates {
                    start_date,
                    end_date
                }),
                Ok(())
            );
        }
        let invalid = ContractDates {
            start_date,
            end_date: Some("2026-12-30".parse()?),
        };
        assert_eq!(
            validate_contract_dates(invalid),
            Err(ContractValidationError::EndBeforeStart)
        );
        assert_eq!(
            contract_status(invalid, start_date),
            Err(ContractValidationError::EndBeforeStart)
        );
        assert_eq!(
            contract_active_in_month(invalid, start_date),
            Err(ContractValidationError::EndBeforeStart)
        );
        Ok(())
    }

    #[test]
    fn contract_status_uses_exact_dates_and_inclusive_end() -> anyhow::Result<()> {
        let dates = ContractDates {
            start_date: "2026-12-31".parse()?,
            end_date: Some("2027-01-02".parse()?),
        };
        for (today, expected) in [
            ("2026-12-01", ContractStatus::Scheduled),
            ("2026-12-30", ContractStatus::Scheduled),
            ("2026-12-31", ContractStatus::Active),
            ("2027-01-01", ContractStatus::Active),
            ("2027-01-02", ContractStatus::Active),
            ("2027-01-03", ContractStatus::Retired),
        ] {
            assert_eq!(
                contract_status(dates, today.parse()?),
                Ok(expected),
                "{today}"
            );
        }
        let single_day = ContractDates {
            end_date: Some(dates.start_date),
            ..dates
        };
        assert_eq!(
            contract_status(single_day, dates.start_date),
            Ok(ContractStatus::Active)
        );
        let open = ContractDates {
            end_date: None,
            ..dates
        };
        assert_eq!(
            contract_status(open, NaiveDate::MAX),
            Ok(ContractStatus::Active)
        );
        assert_eq!(
            contract_status(open, "2026-12-30".parse()?),
            Ok(ContractStatus::Scheduled)
        );
        Ok(())
    }

    #[test]
    fn monthly_membership_includes_partial_boundary_months_across_years() -> anyhow::Result<()> {
        let dates = ContractDates {
            start_date: "2025-12-31".parse()?,
            end_date: Some("2027-01-01".parse()?),
        };
        for (month, expected) in [
            ("2025-11-30", false),
            ("2025-12-01", true),
            ("2025-12-31", true),
            ("2026-01-01", true),
            ("2026-02-28", true),
            ("2026-12-31", true),
            ("2027-01-01", true),
            ("2027-01-31", true),
            ("2027-02-01", false),
        ] {
            assert_eq!(
                contract_active_in_month(dates, month.parse()?),
                Ok(expected),
                "{month}"
            );
        }
        let single_day = ContractDates {
            start_date: "2024-02-29".parse()?,
            end_date: Some("2024-02-29".parse()?),
        };
        assert_eq!(
            contract_active_in_month(single_day, "2024-02-01".parse()?),
            Ok(true)
        );
        assert_eq!(
            contract_active_in_month(single_day, "2024-03-01".parse()?),
            Ok(false)
        );
        let open = ContractDates {
            end_date: None,
            ..dates
        };
        assert_eq!(contract_active_in_month(open, NaiveDate::MAX), Ok(true));
        assert_eq!(contract_active_in_month(open, NaiveDate::MIN), Ok(false));
        Ok(())
    }

    #[test]
    fn price_history_rejects_negative_rates_and_duplicate_calendar_months() -> anyhow::Result<()> {
        let initial = ContractPrice {
            effective_on: "2026-02-01".parse()?,
            price: Decimal::ZERO,
        };
        assert_eq!(validate_contract_prices(&[]), Ok(()));
        assert_eq!(validate_contract_prices(&[initial]), Ok(()));
        let negative = ContractPrice {
            price: Decimal::new(-1, 8),
            ..initial
        };
        assert_eq!(
            validate_contract_prices(&[negative]),
            Err(ContractValidationError::NegativePrice)
        );
        assert_eq!(
            effective_contract_price(&[negative], "2025-01-01".parse()?),
            Err(ContractValidationError::NegativePrice)
        );
        for effective_on in ["2026-02-01", "2026-02-28"] {
            let duplicate = ContractPrice {
                effective_on: effective_on.parse()?,
                price: Decimal::ONE,
            };
            let history = [initial, duplicate];
            let error = ContractValidationError::DuplicatePriceMonth {
                year: 2026,
                month: 2,
            };
            assert_eq!(validate_contract_prices(&history), Err(error));
            assert_eq!(
                effective_contract_price(&history, "2025-01-01".parse()?),
                Err(ContractValidationError::DuplicatePriceMonth {
                    year: 2026,
                    month: 2
                })
            );
        }
        let next_year = ContractPrice {
            effective_on: "2027-02-01".parse()?,
            price: Decimal::MAX,
        };
        assert_eq!(validate_contract_prices(&[next_year, initial]), Ok(()));
        Ok(())
    }

    #[test]
    fn effective_price_uses_entire_month_and_unsorted_history_across_years() -> anyhow::Result<()> {
        let history = [
            ContractPrice {
                effective_on: "2027-02-28".parse()?,
                price: Decimal::new(123456, 4),
            },
            ContractPrice {
                effective_on: "2025-12-31".parse()?,
                price: Decimal::ONE,
            },
            ContractPrice {
                effective_on: "2026-12-15".parse()?,
                price: Decimal::ZERO,
            },
            ContractPrice {
                effective_on: "2026-01-31".parse()?,
                price: Decimal::new(225, 2),
            },
        ];
        for (month, expected) in [
            ("2025-11-30", None),
            ("2025-12-01", Some(Decimal::ONE)),
            ("2025-12-31", Some(Decimal::ONE)),
            ("2026-01-01", Some(Decimal::new(225, 2))),
            ("2026-01-31", Some(Decimal::new(225, 2))),
            ("2026-11-30", Some(Decimal::new(225, 2))),
            ("2026-12-01", Some(Decimal::ZERO)),
            ("2027-01-31", Some(Decimal::ZERO)),
            ("2027-02-01", Some(Decimal::new(123456, 4))),
            ("2027-02-28", Some(Decimal::new(123456, 4))),
            ("2030-01-01", Some(Decimal::new(123456, 4))),
        ] {
            assert_eq!(
                effective_contract_price(&history, month.parse()?),
                Ok(expected),
                "{month}"
            );
        }
        assert_eq!(effective_contract_price(&[], NaiveDate::MAX), Ok(None));
        assert_eq!(effective_contract_price(&history, NaiveDate::MIN), Ok(None));
        assert_eq!(
            effective_contract_price(&history, NaiveDate::MAX),
            Ok(Some(Decimal::new(123456, 4)))
        );
        Ok(())
    }

    #[test]
    fn price_history_can_be_edited_without_append_only_assumptions() -> anyhow::Result<()> {
        let mut history = [
            ContractPrice {
                effective_on: "2026-01-31".parse()?,
                price: Decimal::ONE,
            },
            ContractPrice {
                effective_on: "2026-03-01".parse()?,
                price: Decimal::from(3),
            },
        ];
        history[0].price = Decimal::from(2);
        assert_eq!(
            effective_contract_price(&history, "2026-02-01".parse()?),
            Ok(Some(Decimal::from(2)))
        );
        history[1].effective_on = "2025-12-31".parse()?;
        assert_eq!(
            effective_contract_price(&history, "2026-01-01".parse()?),
            Ok(Some(Decimal::from(2)))
        );
        assert_eq!(
            effective_contract_price(&history[1..], "2026-01-01".parse()?),
            Ok(Some(Decimal::from(3)))
        );
        Ok(())
    }

    #[test]
    fn first_reading_is_a_baseline_and_decreases_are_rejected() {
        assert_eq!(meter_usage(Decimal::from(120), None), Ok(None));
        assert_eq!(
            meter_usage(Decimal::from(120), Some(Decimal::from(120))),
            Ok(Some(Decimal::ZERO))
        );
        assert_eq!(
            meter_usage(Decimal::from(119), Some(Decimal::from(120))),
            Err(UtilityCalculationError::DecreasingReading)
        );
    }

    #[test]
    fn charge_uses_decimal_currency_rounding() {
        assert_eq!(utility_charge(None, Decimal::ONE), Ok(None));
        assert_eq!(
            utility_charge(Some(Decimal::new(125, 2)), Decimal::new(122, 2)),
            Ok(Some(Decimal::new(153, 2)))
        );
        assert_eq!(
            utility_charge(Some(Decimal::ZERO), Decimal::ONE),
            Ok(Some(Decimal::ZERO))
        );
        assert_eq!(
            utility_charge(Some(Decimal::MAX), Decimal::MAX),
            Err(UtilityCalculationError::Overflow)
        );
    }
}
