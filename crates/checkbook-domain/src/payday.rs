//! Deterministic payday reconciliation and three-month evidence aggregation.
use std::collections::{BTreeMap, BTreeSet};

use rust_decimal::Decimal;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ExpenseBucket {
    pub category_id: Uuid,
    pub subcategory_id: Option<Uuid>,
}

#[derive(Debug, Clone)]
pub struct Allocation {
    pub id: Uuid,
    pub bucket: Option<ExpenseBucket>,
    pub expense_group_id: Option<Uuid>,
    pub amount: Decimal,
    pub completed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Comparison {
    pub id: Uuid,
    pub actual: Option<Decimal>,
    pub difference: Option<Decimal>,
    pub percentage: Option<Decimal>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reconciliation {
    pub comparisons: Vec<Comparison>,
    pub unplanned: BTreeMap<ExpenseBucket, Decimal>,
    pub allocated: Decimal,
    pub completed: Decimal,
    pub actual: Decimal,
    pub remaining: Decimal,
}

/// Each actual bucket belongs to exactly one allocation: exact subcategory first,
/// category catch-all second, then stable UUID order. Savings/custom allocations
/// deliberately carry no expense bucket and therefore remain unmatched.
#[must_use]
pub fn reconcile(
    income: Decimal,
    allocations: &[Allocation],
    actuals: &BTreeMap<ExpenseBucket, Decimal>,
) -> Reconciliation {
    reconcile_with_groups(income, allocations, actuals, &BTreeMap::new())
}

/// More specific allocations claim spending before group catch-alls, without double counting.
#[must_use]
pub fn reconcile_with_groups(
    income: Decimal,
    allocations: &[Allocation],
    actuals: &BTreeMap<ExpenseBucket, Decimal>,
    category_groups: &BTreeMap<Uuid, Uuid>,
) -> Reconciliation {
    let mut ordered = allocations.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|allocation| {
        let specificity = match &allocation.bucket {
            Some(bucket) if bucket.subcategory_id.is_some() => 0,
            Some(_) => 1,
            None if allocation.expense_group_id.is_some() => 2,
            None => 3,
        };
        (specificity, allocation.id)
    });
    let mut unplanned = actuals.clone();
    let mut matches = BTreeMap::new();
    let mut claimed = BTreeSet::new();
    for allocation in ordered {
        if allocation.bucket.is_none() && allocation.expense_group_id.is_none() {
            continue;
        }
        // Category allocations retain their identity even when their group changes.
        let identity = (
            allocation.bucket.clone(),
            allocation
                .bucket
                .is_none()
                .then_some(allocation.expense_group_id)
                .flatten(),
        );
        if !claimed.insert(identity) {
            continue;
        }
        let keys = unplanned
            .keys()
            .filter(|actual| {
                if let Some(bucket) = &allocation.bucket {
                    actual.category_id == bucket.category_id
                        && (bucket.subcategory_id.is_none()
                            || actual.subcategory_id == bucket.subcategory_id)
                } else {
                    category_groups.get(&actual.category_id).copied() == allocation.expense_group_id
                }
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut total = Decimal::ZERO;
        for key in keys {
            total += unplanned.remove(&key).unwrap_or_default();
        }
        matches.insert(allocation.id, total);
    }
    let allocated = allocations.iter().map(|row| row.amount).sum::<Decimal>();
    Reconciliation {
        comparisons: allocations
            .iter()
            .map(|allocation| {
                let actual = matches.get(&allocation.id).copied();
                Comparison {
                    id: allocation.id,
                    actual,
                    difference: actual.map(|actual| actual - allocation.amount),
                    percentage: actual.and_then(|actual| {
                        if allocation.amount.is_zero() {
                            None
                        } else {
                            Some(
                                ((actual - allocation.amount) / allocation.amount
                                    * Decimal::ONE_HUNDRED)
                                    .round_dp(2),
                            )
                        }
                    }),
                }
            })
            .collect(),
        unplanned,
        allocated,
        completed: allocations
            .iter()
            .filter(|row| row.completed)
            .map(|row| row.amount)
            .sum(),
        actual: actuals.values().copied().sum(),
        remaining: income - allocated,
    }
}

/// Missing months count as zero; only the caller's three completed months enter
/// this calculation. Round once, after averaging exact decimal observations.
#[must_use]
pub fn suggested_amount(
    actuals: [Decimal; 3],
    historical_plan: Option<Decimal>,
    template: Option<Decimal>,
) -> Decimal {
    if actuals.iter().any(|amount| *amount > Decimal::ZERO) {
        (actuals.into_iter().sum::<Decimal>() / Decimal::from(3)).round_dp(2)
    } else {
        historical_plan.or(template).unwrap_or_default().round_dp(2)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuggestedSection {
    Mandatory,
    Monthly,
    Flexible,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SuggestionDecision {
    pub amount: Decimal,
    pub section: SuggestedSection,
    pub recurring_months: usize,
}

/// Realized expenses outrank plans, completion and current template prices.
/// Recurrence requires evidence in at least two separate completed months.
#[must_use]
pub fn suggest(
    actuals: [Decimal; 3],
    historical_plan: Option<Decimal>,
    completed_plan: Option<Decimal>,
    template: Option<Decimal>,
    expense: bool,
) -> SuggestionDecision {
    let recurring_months = actuals
        .iter()
        .filter(|amount| **amount > Decimal::ZERO)
        .count();
    SuggestionDecision {
        amount: suggested_amount(actuals, completed_plan.or(historical_plan), template),
        section: if !expense {
            SuggestedSection::Flexible
        } else if template.is_some() || recurring_months >= 2 {
            SuggestedSection::Mandatory
        } else {
            SuggestedSection::Monthly
        },
        recurring_months,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn group_catchall_claims_only_remaining_categories_and_duplicates_stay_unmatched() {
        let group = Uuid::from_u128(10);
        let category = Uuid::from_u128(11);
        let other = Uuid::from_u128(12);
        let child = ExpenseBucket {
            category_id: category,
            subcategory_id: Some(Uuid::from_u128(13)),
        };
        let root = ExpenseBucket {
            category_id: category,
            subcategory_id: None,
        };
        let sibling = ExpenseBucket {
            category_id: other,
            subcategory_id: None,
        };
        let allocations = vec![
            Allocation {
                id: Uuid::from_u128(1),
                bucket: None,
                expense_group_id: Some(group),
                amount: dec!(200),
                completed: false,
            },
            Allocation {
                id: Uuid::from_u128(2),
                bucket: None,
                expense_group_id: Some(group),
                amount: Decimal::ZERO,
                completed: false,
            },
            Allocation {
                id: Uuid::from_u128(3),
                bucket: Some(root.clone()),
                expense_group_id: Some(group),
                amount: dec!(20),
                completed: false,
            },
            Allocation {
                id: Uuid::from_u128(4),
                bucket: Some(child.clone()),
                expense_group_id: Some(group),
                amount: dec!(10),
                completed: false,
            },
        ];
        let result = reconcile_with_groups(
            dec!(500),
            &allocations,
            &BTreeMap::from([
                (child, dec!(10.01)),
                (root, dec!(20.02)),
                (sibling, dec!(173.80)),
            ]),
            &BTreeMap::from([(category, group), (other, group)]),
        );
        assert_eq!(result.comparisons[0].actual, Some(dec!(173.80)));
        assert_eq!(result.comparisons[1].actual, None);
        assert_eq!(result.comparisons[2].actual, Some(dec!(20.02)));
        assert_eq!(result.comparisons[3].actual, Some(dec!(10.01)));
        assert!(result.unplanned.is_empty());
        assert_eq!(result.actual, dec!(203.83));
    }

    #[test]
    fn exact_match_wins_and_category_does_not_double_count() {
        let category = Uuid::from_u128(1);
        let child = ExpenseBucket {
            category_id: category,
            subcategory_id: Some(Uuid::from_u128(2)),
        };
        let other = ExpenseBucket {
            category_id: category,
            subcategory_id: None,
        };
        let allocations = vec![
            Allocation {
                id: Uuid::from_u128(3),
                expense_group_id: None,
                bucket: Some(other.clone()),
                amount: dec!(20),
                completed: false,
            },
            Allocation {
                id: Uuid::from_u128(4),
                expense_group_id: None,
                bucket: Some(child.clone()),
                amount: dec!(10),
                completed: true,
            },
            Allocation {
                id: Uuid::from_u128(5),
                expense_group_id: None,
                bucket: None,
                amount: dec!(5),
                completed: true,
            },
        ];
        let result = reconcile(
            dec!(100),
            &allocations,
            &BTreeMap::from([(child, dec!(12)), (other, dec!(18))]),
        );
        assert_eq!(result.comparisons[0].actual, Some(dec!(18)));
        assert_eq!(result.comparisons[1].actual, Some(dec!(12)));
        assert_eq!(result.comparisons[2].actual, None);
        assert_eq!(result.actual, dec!(30));
        assert_eq!(result.completed, dec!(15));
        assert_eq!(result.remaining, dec!(65));
        assert!(result.unplanned.is_empty());
    }

    #[test]
    fn duplicate_matches_claim_each_actual_once_and_zero_has_no_percentage() {
        let bucket = ExpenseBucket {
            category_id: Uuid::nil(),
            subcategory_id: None,
        };
        let allocations = vec![
            Allocation {
                id: Uuid::from_u128(1),
                expense_group_id: None,
                bucket: Some(bucket.clone()),
                amount: Decimal::ZERO,
                completed: false,
            },
            Allocation {
                id: Uuid::from_u128(2),
                expense_group_id: None,
                bucket: Some(bucket.clone()),
                amount: dec!(5),
                completed: false,
            },
        ];
        let result = reconcile(
            Decimal::ZERO,
            &allocations,
            &BTreeMap::from([(bucket, dec!(10))]),
        );
        assert_eq!(result.comparisons[0].actual, Some(dec!(10)));
        assert_eq!(result.comparisons[0].percentage, None);
        assert_eq!(result.comparisons[1].actual, None);
        assert_eq!(result.remaining, dec!(-5));
    }

    #[test]
    fn suggestion_decisions_use_recurrence_completion_and_actual_feedback() {
        let recurring = suggest(
            [dec!(1350), dec!(1350), dec!(1350)],
            Some(dec!(1200)),
            None,
            Some(dec!(1200)),
            true,
        );
        assert_eq!(recurring.amount, dec!(1350));
        assert_eq!(recurring.section, SuggestedSection::Mandatory);
        let one_off = suggest(
            [dec!(90), Decimal::ZERO, Decimal::ZERO],
            None,
            None,
            None,
            true,
        );
        assert_eq!(one_off.section, SuggestedSection::Monthly);
        let savings = suggest(
            [Decimal::ZERO; 3],
            Some(dec!(50)),
            Some(dec!(75)),
            Some(dec!(100)),
            false,
        );
        assert_eq!(savings.amount, dec!(75));
        assert_eq!(savings.section, SuggestedSection::Flexible);
    }

    #[test]
    fn suggestions_prioritize_actuals_and_include_zero_months() {
        assert_eq!(
            suggested_amount([dec!(10), dec!(0), dec!(0)], Some(dec!(99)), Some(dec!(80))),
            dec!(3.33)
        );
        assert_eq!(
            suggested_amount([Decimal::ZERO; 3], Some(dec!(12)), Some(dec!(80))),
            dec!(12)
        );
        assert_eq!(
            suggested_amount([Decimal::ZERO; 3], None, Some(dec!(80))),
            dec!(80)
        );
    }
}
