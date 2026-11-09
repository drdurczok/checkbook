use chrono::{Months, NaiveDate};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{DomainError, finance::money};

/// A schedule entry whose completed values are authoritative historical data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoanSchedulePayment {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Uuid>,
    pub date: NaiveDate,
    #[serde(
        default,
        with = "rust_decimal::serde::str_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub payment: Option<Decimal>,
    #[serde(
        default,
        with = "rust_decimal::serde::str_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub interest: Option<Decimal>,
    #[serde(
        default,
        with = "rust_decimal::serde::str_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub principal: Option<Decimal>,
    #[serde(
        default,
        with = "rust_decimal::serde::str_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub extra_principal: Option<Decimal>,
    #[serde(
        default,
        with = "rust_decimal::serde::str_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub outstanding_loan_balance: Option<Decimal>,
    #[serde(
        default,
        with = "rust_decimal::serde::str_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub interest_balance: Option<Decimal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed: Option<bool>,
}

impl LoanSchedulePayment {
    /// Legacy rows without an explicit flag are complete unless projected.
    #[must_use]
    pub fn is_completed(&self) -> bool {
        self.completed.unwrap_or(self.projected != Some(true))
    }

    pub fn validate(&self) -> Result<(), DomainError> {
        if [
            self.payment,
            self.interest,
            self.principal,
            self.extra_principal,
            self.outstanding_loan_balance,
            self.interest_balance,
        ]
        .into_iter()
        .flatten()
        .any(|amount| amount.is_sign_negative())
        {
            return Err(DomainError::NegativeAmount);
        }
        Ok(())
    }
}

/// Builds monthly installments after `start` through `end`, anchored to the start
/// day (clamped for short months). The last installment settles cent rounding.
pub fn initial_loan_schedule(
    amount: Decimal,
    annual_rate: Decimal,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<LoanSchedulePayment>, DomainError> {
    if amount.is_sign_negative() {
        return Err(DomainError::NegativeAmount);
    }
    if annual_rate.is_sign_negative() || annual_rate > Decimal::ONE {
        return Err(DomainError::InvalidInterestRate);
    }
    let mut dates = Vec::new();
    for month in 1..=1200 {
        let Some(date) = start.checked_add_months(Months::new(month)) else {
            break;
        };
        if date > end {
            break;
        }
        dates.push(date);
    }
    // Bound the calculation to a century, including malicious transport dates.
    if dates.is_empty()
        || start
            .checked_add_months(Months::new(1201))
            .is_some_and(|date| date <= end)
    {
        return Err(DomainError::InvalidLoanDateRange);
    }
    let rate = annual_rate / Decimal::from(12);
    // Discounted annuity factor avoids large powers/overflow for long terms.
    let discount = Decimal::ONE / (Decimal::ONE + rate);
    let mut factor = Decimal::ZERO;
    let mut power = Decimal::ONE;
    for _ in &dates {
        power *= discount;
        factor += power;
    }
    let installment = money(amount / factor);
    let last = dates.len() - 1;
    let mut balance = money(amount);
    let mut schedule = Vec::with_capacity(dates.len());
    for (index, date) in dates.into_iter().enumerate() {
        let interest = money(balance * rate);
        let payoff = balance + interest;
        let payment = if index == last {
            payoff
        } else {
            // A sub-cent annuity must still reduce principal at currency precision.
            installment.max(interest + Decimal::new(1, 2)).min(payoff)
        };
        let principal = (payment - interest).max(Decimal::ZERO).min(balance);
        balance = money(balance - principal);
        schedule.push(LoanSchedulePayment {
            id: None,
            date,
            payment: Some(payment),
            interest: Some(interest),
            principal: Some(principal),
            extra_principal: None,
            outstanding_loan_balance: Some(balance),
            interest_balance: None,
            projected: Some(true),
            completed: Some(false),
        });
    }
    let mut remaining_interest = Decimal::ZERO;
    for row in schedule.iter_mut().rev() {
        row.interest_balance = Some(remaining_interest);
        remaining_interest += row.interest.unwrap_or_default();
    }
    Ok(schedule)
}

/// The next installment after the latest completed row, or its last actual payment.
/// Same-date rows retain their supplied order; old uncompleted rows are not next.
#[must_use]
pub fn schedule_monthly_payment(schedule: &[LoanSchedulePayment]) -> Option<Decimal> {
    let mut rows: Vec<_> = schedule.iter().collect();
    rows.sort_by_key(|row| row.date);
    let latest_completed = rows.iter().rposition(|row| row.is_completed());
    rows.iter()
        .skip(latest_completed.map_or(0, |index| index + 1))
        .find(|row| !row.is_completed() && row.payment.is_some())
        .and_then(|row| row.payment)
        .or_else(|| {
            rows.iter()
                .rev()
                .find(|row| row.is_completed() && row.payment.is_some())
                .and_then(|row| row.payment)
        })
}

/// Freezes missing financial values during an explicit add/completion operation.
///
/// Callers must not use this to backfill existing completed history. Explicit
/// values (including zero and balance checkpoints) and completion flags survive
/// unchanged; the caller owns the status transition. No future interest is added.
pub fn complete_loan_payment(
    opening_balance: Decimal,
    annual_rate: Decimal,
    monthly_payment: Decimal,
    row: &mut LoanSchedulePayment,
) -> Result<(), DomainError> {
    if opening_balance.is_sign_negative() || monthly_payment.is_sign_negative() {
        return Err(DomainError::NegativeAmount);
    }
    if annual_rate.is_sign_negative() || annual_rate > Decimal::ONE {
        return Err(DomainError::InvalidInterestRate);
    }
    row.validate()?;
    let payment = row.payment.unwrap_or(if opening_balance.is_zero() {
        Decimal::ZERO
    } else {
        monthly_payment
    });
    let interest = row
        .interest
        .unwrap_or_else(|| money(opening_balance * (annual_rate / Decimal::from(12))));
    let principal = row
        .principal
        .unwrap_or_else(|| money((payment - interest).max(Decimal::ZERO)).min(opening_balance));
    let outstanding = row.outstanding_loan_balance.unwrap_or_else(|| {
        money(
            ((opening_balance - principal).max(Decimal::ZERO)
                - row.extra_principal.unwrap_or_default())
            .max(Decimal::ZERO),
        )
    });
    row.payment = Some(payment);
    row.interest = Some(interest);
    row.principal = Some(principal);
    row.outstanding_loan_balance = Some(outstanding);
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciledLoanSchedule {
    pub schedule: Vec<LoanSchedulePayment>,
    pub current_balance: Decimal,
}

/// Recalculates only incomplete rows, retaining every completed value verbatim.
///
/// Completed balance checkpoints override the balance reconstructed from original
/// principal; otherwise completed principal and extra principal reduce it. When
/// no completed financial evidence exists, `fallback_current_balance` anchors
/// projections instead: legacy schedules may omit the loan's earlier history.
/// Callers explicitly undoing the final completed payment can pass the original
/// balance as that fallback. Projected rows never reduce `current_balance`.
///
/// Dates order rows stably; each row represents one monthly accrual period.
/// `interest_balance` is the sum of later incomplete rows' interest within this
/// schedule, not an extrapolation beyond its supplied horizon.
pub fn reconcile_loan_schedule(
    original_balance: Decimal,
    fallback_current_balance: Decimal,
    annual_rate: Decimal,
    monthly_payment: Decimal,
    mut schedule: Vec<LoanSchedulePayment>,
) -> Result<ReconciledLoanSchedule, DomainError> {
    if [original_balance, fallback_current_balance, monthly_payment]
        .into_iter()
        .any(|value| value.is_sign_negative())
    {
        return Err(DomainError::NegativeAmount);
    }
    if annual_rate.is_sign_negative() || annual_rate > Decimal::ONE {
        return Err(DomainError::InvalidInterestRate);
    }
    for row in &schedule {
        row.validate()?;
    }
    schedule.sort_by_key(|row| row.date);
    let has_history = schedule.iter().any(|row| {
        row.is_completed()
            && (row.outstanding_loan_balance.is_some()
                || row.principal.is_some()
                || row.extra_principal.is_some())
    });
    let mut current_balance = if has_history {
        original_balance
    } else {
        fallback_current_balance
    };
    let mut balance = current_balance;
    let monthly_rate = annual_rate / Decimal::from(12);
    for row in &mut schedule {
        if row.is_completed() {
            if let Some(checkpoint) = row.outstanding_loan_balance {
                current_balance = checkpoint;
                balance = checkpoint;
            } else {
                let principal = row.principal.unwrap_or_default();
                let extra = row.extra_principal.unwrap_or_default();
                current_balance =
                    ((current_balance - principal).max(Decimal::ZERO) - extra).max(Decimal::ZERO);
                balance = ((balance - principal).max(Decimal::ZERO) - extra).max(Decimal::ZERO);
            }
            continue;
        }

        let interest = money(balance * monthly_rate);
        let payment = row.payment.unwrap_or(if balance.is_zero() {
            Decimal::ZERO
        } else {
            monthly_payment
        });
        let extra = row.extra_principal.unwrap_or_default();
        let principal = money((payment - interest).max(Decimal::ZERO)).min(balance);
        if !balance.is_zero()
            && (payment < interest || (principal.is_zero() && money(extra).is_zero()))
        {
            return Err(DomainError::NonAmortizingLoan);
        }
        balance = money((balance - principal - extra).max(Decimal::ZERO));
        row.payment = Some(payment);
        row.interest = Some(interest);
        row.principal = Some(principal);
        row.outstanding_loan_balance = Some(balance);
    }
    let mut remaining_interest = Decimal::ZERO;
    for row in schedule.iter_mut().rev() {
        if !row.is_completed() {
            row.interest_balance = Some(remaining_interest);
            remaining_interest += row.interest.unwrap_or_default();
        }
    }
    Ok(ReconciledLoanSchedule {
        schedule,
        current_balance,
    })
}

#[cfg(test)]
mod tests {
    use rust_decimal_macros::dec;

    use super::*;

    fn row() -> Result<LoanSchedulePayment, chrono::ParseError> {
        Ok(LoanSchedulePayment {
            id: None,
            date: NaiveDate::parse_from_str("2028-02-29", "%Y-%m-%d")?,
            payment: None,
            interest: None,
            principal: None,
            extra_principal: None,
            outstanding_loan_balance: None,
            interest_balance: None,
            projected: None,
            completed: None,
        })
    }

    #[test]
    fn initial_schedule_uses_decimal_annuity_and_final_payoff() -> anyhow::Result<()> {
        let start = NaiveDate::parse_from_str("2028-01-31", "%Y-%m-%d")?;
        let end = NaiveDate::parse_from_str("2029-01-31", "%Y-%m-%d")?;
        let rows = initial_loan_schedule(dec!(1000), dec!(0.12), start, end)?;
        assert_eq!(rows.len(), 12);
        assert_eq!(rows[0].date.to_string(), "2028-02-29");
        assert_eq!(rows[1].date.to_string(), "2028-03-31");
        assert_eq!(rows[0].payment, Some(dec!(88.85)));
        assert_eq!(rows[0].interest, Some(dec!(10)));
        assert_eq!(rows[0].principal, Some(dec!(78.85)));
        assert_eq!(
            rows.last().and_then(|row| row.outstanding_loan_balance),
            Some(dec!(0))
        );
        assert_eq!(
            rows.iter().filter_map(|row| row.principal).sum::<Decimal>(),
            dec!(1000)
        );
        assert!(rows.iter().all(|row| !row.is_completed()));
        let reconciled = reconcile_loan_schedule(
            dec!(1000),
            dec!(1000),
            dec!(0.12),
            dec!(88.85),
            rows.clone(),
        )?;
        assert_eq!(reconciled.schedule, rows);
        assert_eq!(reconciled.current_balance, dec!(1000));
        Ok(())
    }

    #[test]
    fn initial_schedule_zero_interest_rounding_dates_and_small_amounts() -> anyhow::Result<()> {
        let start = NaiveDate::parse_from_str("2027-01-31", "%Y-%m-%d")?;
        let end = NaiveDate::parse_from_str("2027-04-30", "%Y-%m-%d")?;
        let rows = initial_loan_schedule(dec!(100), dec!(0), start, end)?;
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].date.to_string(), "2027-02-28");
        assert_eq!(rows[1].date.to_string(), "2027-03-31");
        assert_eq!(rows[0].payment, Some(dec!(33.33)));
        assert_eq!(rows[2].payment, Some(dec!(33.34)));
        assert_eq!(rows[2].outstanding_loan_balance, Some(dec!(0)));
        for amount in [dec!(0), dec!(0.01)] {
            let rows = initial_loan_schedule(amount, dec!(0.12), start, end)?;
            let result = reconcile_loan_schedule(amount, amount, dec!(0.12), dec!(0), rows)?;
            assert_eq!(
                result
                    .schedule
                    .last()
                    .and_then(|row| row.outstanding_loan_balance),
                Some(dec!(0))
            );
        }
        assert_eq!(
            initial_loan_schedule(dec!(1), dec!(0), start, start),
            Err(DomainError::InvalidLoanDateRange)
        );
        assert_eq!(
            initial_loan_schedule(dec!(-1), dec!(0), start, end),
            Err(DomainError::NegativeAmount)
        );
        assert_eq!(
            initial_loan_schedule(dec!(1), dec!(1.1), start, end),
            Err(DomainError::InvalidInterestRate)
        );
        Ok(())
    }

    #[test]
    fn monthly_payment_uses_next_projection_or_latest_actual_not_stale_rows() -> anyhow::Result<()>
    {
        let mut old = pending("2028-01-01")?;
        old.payment = Some(dec!(10));
        let mut actual = pending("2028-02-01")?;
        actual.completed = Some(true);
        actual.payment = Some(dec!(20));
        let mut next = pending("2028-03-01")?;
        next.payment = Some(dec!(30));
        assert_eq!(
            schedule_monthly_payment(&[next, old.clone(), actual.clone()]),
            Some(dec!(30))
        );
        assert_eq!(schedule_monthly_payment(&[old, actual]), Some(dec!(20)));
        assert_eq!(schedule_monthly_payment(&[]), None);
        Ok(())
    }

    #[test]
    fn explicit_completion_freezes_rounded_values_against_later_term_changes() -> anyhow::Result<()>
    {
        let mut payment = row()?;
        payment.payment = Some(dec!(25));
        payment.extra_principal = Some(dec!(1.50));
        payment.completed = Some(true);
        complete_loan_payment(dec!(100.50), dec!(0.12), dec!(50), &mut payment)?;
        assert_eq!(payment.interest, Some(dec!(1.01)));
        assert_eq!(payment.principal, Some(dec!(23.99)));
        assert_eq!(payment.outstanding_loan_balance, Some(dec!(75.01)));
        assert_eq!(payment.interest_balance, None);
        let frozen = payment.clone();
        let reconciled =
            reconcile_loan_schedule(dec!(200), dec!(100.50), dec!(0.24), dec!(80), vec![payment])?;
        assert_eq!(reconciled.current_balance, dec!(75.01));
        assert_eq!(reconciled.schedule, vec![frozen]);
        Ok(())
    }

    #[test]
    fn explicit_completion_preserves_existing_fields_and_scales() -> anyhow::Result<()> {
        let mut payment = row()?;
        payment.id = Some(Uuid::nil());
        payment.payment = Some(dec!(0.000));
        payment.interest = Some(dec!(2.0000));
        payment.principal = Some(dec!(3.000));
        payment.extra_principal = Some(dec!(4.0000));
        payment.outstanding_loan_balance = Some(dec!(9.000));
        payment.interest_balance = Some(dec!(12.0000));
        payment.completed = Some(false);
        payment.projected = Some(true);
        let before = payment.clone();
        complete_loan_payment(dec!(10), dec!(0.12), dec!(7), &mut payment)?;
        assert_eq!(payment, before);
        assert_eq!(
            payment.payment.map(|v| v.serialize()),
            before.payment.map(|v| v.serialize())
        );
        assert_eq!(
            payment.interest.map(|v| v.serialize()),
            before.interest.map(|v| v.serialize())
        );
        assert_eq!(
            payment.principal.map(|v| v.serialize()),
            before.principal.map(|v| v.serialize())
        );
        assert_eq!(
            payment.outstanding_loan_balance.map(|v| v.serialize()),
            before.outstanding_loan_balance.map(|v| v.serialize())
        );
        Ok(())
    }

    #[test]
    fn explicit_completion_caps_overpayment_and_allows_zero_actuals() -> anyhow::Result<()> {
        let mut payment = row()?;
        payment.extra_principal = Some(dec!(50));
        complete_loan_payment(dec!(10), dec!(0), dec!(25), &mut payment)?;
        assert_eq!(payment.payment, Some(dec!(25)));
        assert_eq!(payment.principal, Some(dec!(10)));
        assert_eq!(payment.outstanding_loan_balance, Some(dec!(0)));
        let mut zero = row()?;
        complete_loan_payment(dec!(0), dec!(0.12), dec!(25), &mut zero)?;
        assert_eq!(zero.payment, Some(dec!(0)));
        assert_eq!(zero.interest, Some(dec!(0)));
        let mut low = row()?;
        low.payment = Some(dec!(0));
        complete_loan_payment(dec!(100), dec!(0.12), dec!(25), &mut low)?;
        assert_eq!(low.principal, Some(dec!(0)));
        assert_eq!(low.outstanding_loan_balance, Some(dec!(100)));
        Ok(())
    }

    #[test]
    fn explicit_completion_validation_leaves_row_untouched() -> anyhow::Result<()> {
        for (opening, rate, monthly) in [
            (dec!(-1), dec!(0), dec!(1)),
            (dec!(1), dec!(-0.1), dec!(1)),
            (dec!(1), dec!(1.1), dec!(1)),
            (dec!(1), dec!(0), dec!(-1)),
        ] {
            let mut payment = row()?;
            let before = payment.clone();
            assert!(complete_loan_payment(opening, rate, monthly, &mut payment).is_err());
            assert_eq!(payment, before);
        }
        let mut payment = row()?;
        payment.extra_principal = Some(dec!(-1));
        let before = payment.clone();
        assert_eq!(
            complete_loan_payment(dec!(1), dec!(0), dec!(1), &mut payment),
            Err(DomainError::NegativeAmount)
        );
        assert_eq!(payment, before);
        Ok(())
    }

    #[test]
    fn schedule_allows_partial_rows_and_zero_and_rejects_negative_amounts()
    -> Result<(), chrono::ParseError> {
        let mut payment = row()?;
        assert_eq!(payment.validate(), Ok(()));
        payment.payment = Some(Decimal::ZERO);
        payment.interest_balance = Some(dec!(0.001));
        assert_eq!(payment.validate(), Ok(()));
        for index in 0..6 {
            let mut payment = row()?;
            let fields = [
                &mut payment.payment,
                &mut payment.interest,
                &mut payment.principal,
                &mut payment.extra_principal,
                &mut payment.outstanding_loan_balance,
                &mut payment.interest_balance,
            ];
            *fields[index] = Some(dec!(-0.001));
            assert_eq!(payment.validate(), Err(DomainError::NegativeAmount));
        }
        Ok(())
    }

    fn pending(date: &str) -> Result<LoanSchedulePayment, chrono::ParseError> {
        let mut payment = row()?;
        payment.date = NaiveDate::parse_from_str(date, "%Y-%m-%d")?;
        payment.projected = Some(true);
        Ok(payment)
    }

    #[test]
    fn explicit_completion_wins_over_legacy_projection() -> anyhow::Result<()> {
        let mut payment = row()?;
        assert!(payment.is_completed());
        payment.projected = Some(false);
        assert!(payment.is_completed());
        payment.projected = Some(true);
        assert!(!payment.is_completed());
        payment.completed = Some(true);
        assert!(payment.is_completed());
        payment.projected = None;
        payment.completed = Some(false);
        assert!(!payment.is_completed());
        Ok(())
    }

    #[test]
    fn deserialization_accepts_legacy_missing_optional_fields() -> anyhow::Result<()> {
        use serde::de::{IntoDeserializer, value::MapDeserializer};

        let fields = [("date", "2028-02-29")];
        let deserializer = MapDeserializer::<_, serde::de::value::Error>::new(
            fields
                .into_iter()
                .map(|(key, value)| (key.into_deserializer(), value.into_deserializer())),
        );
        let payment = LoanSchedulePayment::deserialize(deserializer)?;
        assert_eq!(payment, row()?);
        assert!(payment.is_completed());
        Ok(())
    }

    #[test]
    fn completed_rows_retain_all_values_and_decimal_scales() -> anyhow::Result<()> {
        let mut actual = row()?;
        actual.id = Some(Uuid::from_u128(42));
        actual.projected = Some(true);
        actual.completed = Some(true);
        actual.payment = Some(dec!(99.9900));
        actual.interest = Some(dec!(13.1234));
        actual.principal = Some(dec!(82.1200));
        actual.extra_principal = Some(dec!(11.1111));
        actual.outstanding_loan_balance = Some(dec!(700.1234));
        actual.interest_balance = Some(dec!(123.0000));
        let result = reconcile_loan_schedule(
            dec!(1000),
            dec!(900),
            dec!(0.12),
            dec!(100),
            vec![pending("2028-03-31")?, actual.clone()],
        )?;
        assert_eq!(result.schedule[0], actual);
        for (before, after) in [
            (actual.payment, result.schedule[0].payment),
            (actual.interest, result.schedule[0].interest),
            (actual.principal, result.schedule[0].principal),
            (actual.extra_principal, result.schedule[0].extra_principal),
            (
                actual.outstanding_loan_balance,
                result.schedule[0].outstanding_loan_balance,
            ),
            (actual.interest_balance, result.schedule[0].interest_balance),
        ] {
            assert_eq!(
                before.map(|value| value.serialize()),
                after.map(|value| value.serialize())
            );
        }
        assert_eq!(result.current_balance, dec!(700.1234));
        assert_eq!(result.schedule[1].interest, Some(dec!(7.00)));
        Ok(())
    }

    #[test]
    fn latest_completed_checkpoint_then_actual_principal_determine_current_balance()
    -> anyhow::Result<()> {
        let mut first = row()?;
        first.outstanding_loan_balance = Some(dec!(800));
        let mut second = pending("2028-04-30")?;
        second.completed = Some(true);
        second.outstanding_loan_balance = Some(dec!(600));
        let mut third = pending("2028-05-31")?;
        third.completed = Some(true);
        third.principal = Some(dec!(40));
        third.extra_principal = Some(dec!(10));
        let result = reconcile_loan_schedule(
            dec!(1000),
            dec!(900),
            dec!(0.12),
            dec!(100),
            vec![
                third.clone(),
                pending("2028-06-30")?,
                second.clone(),
                first.clone(),
            ],
        )?;
        assert_eq!(result.current_balance, dec!(550));
        assert_eq!(result.schedule[0], first);
        assert_eq!(result.schedule[1], second);
        assert_eq!(result.schedule[2], third);
        assert_eq!(
            result.schedule[3].outstanding_loan_balance,
            Some(dec!(455.50))
        );
        Ok(())
    }

    #[test]
    fn completed_principal_reduces_original_without_a_checkpoint() -> anyhow::Result<()> {
        let mut actual = row()?;
        actual.principal = Some(dec!(100));
        actual.extra_principal = Some(dec!(50));
        let result =
            reconcile_loan_schedule(dec!(1000), dec!(900), dec!(0), dec!(100), vec![actual])?;
        assert_eq!(result.current_balance, dec!(850));
        Ok(())
    }

    #[test]
    fn missing_completed_history_uses_fallback_and_preserves_partial_rows() -> anyhow::Result<()> {
        let mut partial = row()?;
        partial.payment = Some(dec!(100));
        let result = reconcile_loan_schedule(
            dec!(1000),
            dec!(450),
            dec!(0),
            dec!(100),
            vec![partial.clone(), pending("2028-03-31")?],
        )?;
        assert_eq!(result.current_balance, dec!(450));
        assert_eq!(result.schedule[0], partial);
        assert_eq!(result.schedule[1].outstanding_loan_balance, Some(dec!(350)));
        let empty = reconcile_loan_schedule(dec!(1000), dec!(450), dec!(0), dec!(100), vec![])?;
        assert_eq!(empty.current_balance, dec!(450));
        Ok(())
    }

    #[test]
    fn projected_payments_round_monthly_and_sum_remaining_schedule_interest() -> anyhow::Result<()>
    {
        let mut first = pending("2028-01-31")?;
        first.payment = Some(dec!(20.00));
        first.extra_principal = Some(dec!(5.00));
        let result = reconcile_loan_schedule(
            dec!(1000),
            dec!(100.50),
            dec!(0.12),
            dec!(25),
            vec![pending("2028-02-29")?, first],
        )?;
        assert_eq!(result.current_balance, dec!(100.50));
        assert_eq!(result.schedule[0].interest, Some(dec!(1.01)));
        assert_eq!(result.schedule[0].principal, Some(dec!(18.99)));
        assert_eq!(result.schedule[0].extra_principal, Some(dec!(5)));
        assert_eq!(
            result.schedule[0].outstanding_loan_balance,
            Some(dec!(76.51))
        );
        assert_eq!(result.schedule[1].payment, Some(dec!(25)));
        assert_eq!(result.schedule[1].interest, Some(dec!(0.77)));
        assert_eq!(result.schedule[1].principal, Some(dec!(24.23)));
        assert_eq!(
            result.schedule[1].outstanding_loan_balance,
            Some(dec!(52.28))
        );
        assert_eq!(result.schedule[0].interest_balance, Some(dec!(0.77)));
        assert_eq!(result.schedule[1].interest_balance, Some(dec!(0)));
        let repeated = reconcile_loan_schedule(
            dec!(1000),
            result.current_balance,
            dec!(0.12),
            dec!(25),
            result.schedule.clone(),
        )?;
        assert_eq!(repeated, result);
        Ok(())
    }

    #[test]
    fn zero_interest_and_overpayment_cap_principal_without_rewriting_user_inputs()
    -> anyhow::Result<()> {
        let mut first = pending("2028-01-31")?;
        first.payment = Some(dec!(100));
        first.extra_principal = Some(dec!(10));
        let mut last = pending("2028-03-31")?;
        last.payment = Some(dec!(25));
        last.extra_principal = Some(dec!(2));
        let result = reconcile_loan_schedule(
            dec!(50),
            dec!(50),
            dec!(0),
            dec!(100),
            vec![first, pending("2028-02-29")?, last],
        )?;
        assert_eq!(result.schedule[0].principal, Some(dec!(50)));
        assert_eq!(result.schedule[0].payment, Some(dec!(100)));
        assert_eq!(result.schedule[0].extra_principal, Some(dec!(10)));
        assert_eq!(result.schedule[1].payment, Some(dec!(0)));
        assert_eq!(result.schedule[2].payment, Some(dec!(25)));
        assert_eq!(result.schedule[2].extra_principal, Some(dec!(2)));
        for payment in &result.schedule {
            assert_eq!(payment.interest, Some(dec!(0)));
            assert_eq!(payment.outstanding_loan_balance, Some(dec!(0)));
        }
        Ok(())
    }

    #[test]
    fn completion_toggle_freezes_and_unfreezes_calculation() -> anyhow::Result<()> {
        let first = reconcile_loan_schedule(
            dec!(1000),
            dec!(1000),
            dec!(0.12),
            dec!(100),
            vec![pending("2028-01-31")?, pending("2028-02-29")?],
        )?;
        let mut rows = first.schedule;
        rows[0].completed = Some(true);
        let frozen = rows[0].clone();
        let completed =
            reconcile_loan_schedule(dec!(1000), dec!(1000), dec!(0.24), dec!(100), rows)?;
        assert_eq!(completed.schedule[0], frozen);
        assert_eq!(completed.current_balance, dec!(910));
        assert_eq!(completed.schedule[1].interest, Some(dec!(18.20)));
        let mut rows = completed.schedule;
        rows[0].completed = Some(false);
        let undone = reconcile_loan_schedule(dec!(1000), dec!(1000), dec!(0.24), dec!(100), rows)?;
        assert_eq!(undone.current_balance, dec!(1000));
        assert_eq!(undone.schedule[0].interest, Some(dec!(20)));
        assert_eq!(undone.schedule[0].outstanding_loan_balance, Some(dec!(920)));
        Ok(())
    }

    #[test]
    fn missing_completed_values_do_not_erase_prior_projection_progress() -> anyhow::Result<()> {
        let partial = row()?;
        let result = reconcile_loan_schedule(
            dec!(1000),
            dec!(500),
            dec!(0),
            dec!(100),
            vec![
                pending("2028-01-31")?,
                partial.clone(),
                pending("2028-03-31")?,
            ],
        )?;
        assert_eq!(result.current_balance, dec!(500));
        assert_eq!(result.schedule[1], partial);
        assert_eq!(result.schedule[2].outstanding_loan_balance, Some(dec!(300)));
        Ok(())
    }

    #[test]
    fn equal_date_rows_keep_input_order() -> anyhow::Result<()> {
        let mut first = pending("2028-02-29")?;
        first.id = Some(Uuid::from_u128(2));
        let mut second = first.clone();
        second.id = Some(Uuid::from_u128(1));
        let result = reconcile_loan_schedule(
            dec!(1000),
            dec!(1000),
            dec!(0),
            dec!(100),
            vec![first, second],
        )?;
        assert_eq!(result.schedule[0].id, Some(Uuid::from_u128(2)));
        assert_eq!(result.schedule[1].id, Some(Uuid::from_u128(1)));
        assert_eq!(result.schedule[1].outstanding_loan_balance, Some(dec!(800)));
        Ok(())
    }

    #[test]
    fn non_amortizing_and_invalid_values_are_rejected() -> anyhow::Result<()> {
        for payment in [dec!(0), dec!(9), dec!(10)] {
            assert_eq!(
                reconcile_loan_schedule(
                    dec!(1000),
                    dec!(1000),
                    dec!(0.12),
                    payment,
                    vec![pending("2028-02-29")?],
                ),
                Err(DomainError::NonAmortizingLoan)
            );
        }
        let mut with_extra = pending("2028-02-29")?;
        with_extra.extra_principal = Some(dec!(20));
        assert_eq!(
            reconcile_loan_schedule(
                dec!(1000),
                dec!(1000),
                dec!(0.12),
                dec!(9),
                vec![with_extra.clone()],
            ),
            Err(DomainError::NonAmortizingLoan)
        );
        let covered = reconcile_loan_schedule(
            dec!(1000),
            dec!(1000),
            dec!(0.12),
            dec!(10),
            vec![with_extra],
        )?;
        assert_eq!(
            covered.schedule[0].outstanding_loan_balance,
            Some(dec!(980))
        );
        for rate in [dec!(-0.01), dec!(1.01)] {
            assert_eq!(
                reconcile_loan_schedule(dec!(1), dec!(1), rate, dec!(1), vec![]),
                Err(DomainError::InvalidInterestRate)
            );
        }
        assert_eq!(
            reconcile_loan_schedule(dec!(-1), dec!(1), dec!(0), dec!(1), vec![]),
            Err(DomainError::NegativeAmount)
        );
        let mut invalid = pending("2028-02-29")?;
        invalid.extra_principal = Some(dec!(-1));
        assert_eq!(
            reconcile_loan_schedule(dec!(1), dec!(1), dec!(0), dec!(1), vec![invalid]),
            Err(DomainError::NegativeAmount)
        );
        Ok(())
    }
}
