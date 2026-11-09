use rust_decimal::{Decimal, RoundingStrategy};

use crate::DomainError;

fn rounded_money(value: Decimal) -> Decimal {
    value.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
}

#[must_use]
pub fn median_outlier_trim(mut values: Vec<Decimal>) -> Vec<Decimal> {
    if values.len() < 4 {
        return values;
    }
    values.sort_unstable();
    let midpoint = if values.len().is_multiple_of(2) {
        let upper = values.len() / 2;
        (values[upper - 1] + values[upper]) / Decimal::from(2_u8)
    } else {
        values[values.len() / 2]
    };
    if midpoint <= Decimal::new(1, 2) {
        return values;
    }
    let threshold = midpoint / Decimal::from(2_u8);
    let filtered = values
        .iter()
        .copied()
        .filter(|value| (*value - midpoint).abs() <= threshold)
        .collect::<Vec<_>>();
    if filtered.len() >= 3 {
        filtered
    } else {
        values
    }
}

pub fn ten_percent_trimmed_mean(mut values: Vec<Decimal>) -> Result<Decimal, DomainError> {
    values.retain(|value| *value > Decimal::ZERO);
    if values.is_empty() {
        return Ok(Decimal::ZERO);
    }
    values.sort_unstable();
    let trim = if values.len() >= 10 {
        values.len() / 10
    } else {
        0
    };
    let retained = &values[trim..values.len() - trim];
    let total = retained.iter().copied().sum::<Decimal>();
    let count =
        Decimal::from(u32::try_from(retained.len()).map_err(|_| DomainError::NegativeAmount)?);
    Ok(rounded_money(total / count))
}

pub fn cadence_months(cadence: &str) -> Result<u32, DomainError> {
    match cadence {
        "monthly" => Ok(1),
        "quarterly" => Ok(3),
        "yearly" => Ok(12),
        _ => Err(DomainError::InvalidCadence),
    }
}

#[cfg(test)]
mod tests {
    use rust_decimal_macros::dec;

    use super::{cadence_months, median_outlier_trim, ten_percent_trimmed_mean};
    use crate::DomainError;

    #[test]
    fn median_filter_removes_values_more_than_fifty_percent_from_midpoint() {
        assert_eq!(
            median_outlier_trim(vec![dec!(100), dec!(102), dec!(98), dec!(1000)]),
            vec![dec!(98), dec!(100), dec!(102)]
        );
    }

    #[test]
    fn median_filter_keeps_small_samples() {
        assert_eq!(
            median_outlier_trim(vec![dec!(100), dec!(102), dec!(1000)]),
            vec![dec!(100), dec!(102), dec!(1000)]
        );
    }

    #[test]
    fn ten_percent_trimmed_mean_discards_both_tails() -> Result<(), DomainError> {
        let mean = ten_percent_trimmed_mean(vec![
            dec!(1),
            dec!(10),
            dec!(10),
            dec!(10),
            dec!(10),
            dec!(10),
            dec!(10),
            dec!(10),
            dec!(10),
            dec!(100),
        ])?;
        assert_eq!(mean, dec!(10));
        Ok(())
    }

    #[test]
    fn cadence_values_are_stable() {
        assert_eq!(cadence_months("monthly"), Ok(1));
        assert_eq!(cadence_months("quarterly"), Ok(3));
        assert_eq!(cadence_months("yearly"), Ok(12));
        assert_eq!(cadence_months("weekly"), Err(DomainError::InvalidCadence));
    }
}
