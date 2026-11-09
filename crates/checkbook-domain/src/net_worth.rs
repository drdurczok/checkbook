use std::collections::BTreeSet;

use chrono::{Datelike, NaiveDate};
use rust_decimal::Decimal;

#[derive(Debug, Clone, PartialEq)]
pub struct NetWorthComponent {
    pub group_key: String,
    pub label: String,
    pub value: Decimal,
}

/// Validate canonical monthly values independently of their transport or store.
pub fn validate_month(
    period: NaiveDate,
    mut components: Vec<NetWorthComponent>,
) -> Result<Vec<NetWorthComponent>, &'static str> {
    if period.day() != 1 {
        return Err("Net worth period must be the first day of a month.");
    }
    if components.len() > 500 {
        return Err("A month cannot hold more than 500 components.");
    }
    let mut seen = BTreeSet::new();
    let mut total_magnitude = Decimal::ZERO;
    for component in &mut components {
        component.label = component.label.trim().to_owned();
        component.group_key = component.group_key.trim().to_owned();
        if component.label.is_empty() {
            return Err("Component labels cannot be empty.");
        }
        if !matches!(
            component.group_key.as_str(),
            "investing" | "savings" | "non_liquid_assets" | "debt"
        ) {
            return Err("Component group must be investing, savings, non_liquid_assets, or debt.");
        }
        if component.group_key == "debt" && component.value < Decimal::ZERO {
            return Err("Debt components are stored as non-negative magnitudes.");
        }
        if !seen.insert((component.group_key.clone(), component.label.clone())) {
            return Err("Component labels must be unique within their group.");
        }
        // Bound every possible group sum and the final net worth before arithmetic.
        total_magnitude = total_magnitude
            .checked_add(component.value.abs())
            .ok_or("Component values exceed the supported decimal range.")?;
    }
    Ok(components)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn component(group: &str, label: &str, value: Decimal) -> NetWorthComponent {
        NetWorthComponent {
            group_key: group.to_owned(),
            label: label.to_owned(),
            value,
        }
    }

    #[test]
    fn normalizes_and_validates_components() -> Result<(), &'static str> {
        let period = NaiveDate::from_ymd_opt(2026, 1, 1).ok_or("date")?;
        let normalized = validate_month(
            period,
            vec![component(" savings ", " Cash ", Decimal::ZERO)],
        )?;
        assert_eq!(normalized[0].label, "Cash");
        assert_eq!(normalized[0].group_key, "savings");
        for invalid in [
            vec![component("other", "Cash", Decimal::ONE)],
            vec![component("savings", " ", Decimal::ONE)],
            vec![component("debt", "Loan", -Decimal::ONE)],
            vec![
                component("savings", "Cash", Decimal::ZERO),
                component("savings", " Cash ", Decimal::ONE),
            ],
            vec![
                component("savings", "Cash", Decimal::MAX),
                component("investing", "ETF", Decimal::ONE),
            ],
            vec![component("savings", "Cash", Decimal::ZERO); 501],
        ] {
            assert!(validate_month(period, invalid).is_err());
        }
        assert!(validate_month(period.succ_opt().ok_or("date")?, vec![]).is_err());
        assert!(
            validate_month(
                period,
                vec![component("investing", "Adjustment", -Decimal::ONE)]
            )
            .is_ok()
        );
        assert!(validate_month(period, vec![]).is_ok());
        Ok(())
    }
}
