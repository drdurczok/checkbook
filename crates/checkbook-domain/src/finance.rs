use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Serialize};

use crate::DomainError;

const MONEY_DP: u32 = 2;
const MAX_LOAN_MONTHS: u32 = 1_200;
const MAX_DEPRECIATION_MONTHS: i64 = 1_200;

pub(crate) fn money(value: Decimal) -> Decimal {
    value.round_dp_with_strategy(MONEY_DP, RoundingStrategy::MidpointAwayFromZero)
}

/// Compounds `base` by `monthly_rate` (a signed fraction, e.g. `-0.02` for
/// 2%/month depreciation or `0.01` for 1%/month appreciation) across
/// `months` whole months. Used to project a property/vehicle's current
/// value forward from its last manually-set valuation.
pub fn compounded_value(
    base: Decimal,
    monthly_rate: Decimal,
    months: i64,
) -> Result<Decimal, DomainError> {
    if base.is_sign_negative() {
        return Err(DomainError::NegativeAmount);
    }
    if monthly_rate < -Decimal::ONE || monthly_rate > Decimal::ONE {
        return Err(DomainError::InvalidDepreciationRate);
    }
    let months = months.clamp(0, MAX_DEPRECIATION_MONTHS);
    let factor = Decimal::ONE + monthly_rate;
    let mut value = base;
    for _ in 0..months {
        value *= factor;
    }
    Ok(money(value).max(Decimal::ZERO))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvoiceLine {
    pub quantity: Decimal,
    pub unit_price: Decimal,
    pub vat_rate: Decimal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvoiceAmounts {
    pub subtotal: Decimal,
    pub tax_amount: Decimal,
    pub total_amount: Decimal,
}

pub fn calculate_invoice(
    lines: &[InvoiceLine],
    conversion_rate: Decimal,
) -> Result<InvoiceAmounts, DomainError> {
    if conversion_rate.is_sign_negative() {
        return Err(DomainError::NegativeAmount);
    }

    let mut subtotal = Decimal::ZERO;
    let mut tax_amount = Decimal::ZERO;
    for line in lines {
        if line.quantity.is_sign_negative() || line.unit_price.is_sign_negative() {
            return Err(DomainError::NegativeAmount);
        }
        if line.vat_rate.is_sign_negative() || line.vat_rate > Decimal::ONE {
            return Err(DomainError::InvalidVatRate);
        }
        let net = money(line.quantity * line.unit_price * conversion_rate);
        subtotal += net;
        tax_amount += money(net * line.vat_rate);
    }
    subtotal = money(subtotal);
    tax_amount = money(tax_amount);
    Ok(InvoiceAmounts {
        subtotal,
        tax_amount,
        total_amount: money(subtotal + tax_amount),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoanOutcome {
    pub months: u32,
    pub interest: Decimal,
}

pub fn simulate_loan_payoff(
    opening_balance: Decimal,
    annual_rate: Decimal,
    monthly_payment: Decimal,
    extra_payment: Decimal,
) -> Result<LoanOutcome, DomainError> {
    if [opening_balance, monthly_payment, extra_payment]
        .into_iter()
        .any(|value| value.is_sign_negative())
    {
        return Err(DomainError::NegativeAmount);
    }
    if annual_rate.is_sign_negative() || annual_rate > Decimal::ONE {
        return Err(DomainError::InvalidInterestRate);
    }
    if opening_balance.is_zero() {
        return Ok(LoanOutcome {
            months: 0,
            interest: Decimal::ZERO,
        });
    }

    let monthly_rate = annual_rate / Decimal::from(12_u32);
    let payment = monthly_payment + extra_payment;
    let first_interest = money(opening_balance * monthly_rate);
    if payment <= first_interest {
        return Err(DomainError::NonAmortizingLoan);
    }

    let mut balance = opening_balance;
    let mut total_interest = Decimal::ZERO;
    for month in 1..=MAX_LOAN_MONTHS {
        let interest = money(balance * monthly_rate);
        total_interest += interest;
        let principal = (payment - interest).min(balance);
        balance = money(balance - principal);
        if balance.is_zero() {
            return Ok(LoanOutcome {
                months: month,
                interest: money(total_interest),
            });
        }
    }

    Err(DomainError::NonAmortizingLoan)
}

#[cfg(test)]
mod tests {
    use rust_decimal_macros::dec;

    use super::{InvoiceLine, calculate_invoice, compounded_value, simulate_loan_payoff};
    use crate::DomainError;

    #[test]
    fn compounded_value_applies_monthly_depreciation_and_appreciation() -> Result<(), DomainError> {
        assert_eq!(compounded_value(dec!(1000), dec!(0), 12)?, dec!(1000));
        assert_eq!(compounded_value(dec!(1000), dec!(-0.10), 0)?, dec!(1000));
        // 1000 depreciating 10%/month for 3 months: 1000 -> 900 -> 810 -> 729
        assert_eq!(compounded_value(dec!(1000), dec!(-0.10), 3)?, dec!(729));
        // 1000 appreciating 1%/month for 2 months: 1000 -> 1010 -> 1020.10
        assert_eq!(compounded_value(dec!(1000), dec!(0.01), 2)?, dec!(1020.10));
        // Negative months (future-dated valuation) clamp to no elapsed time.
        assert_eq!(compounded_value(dec!(1000), dec!(-0.5), -6)?, dec!(1000));
        assert_eq!(
            compounded_value(dec!(1000), dec!(1.5), 1),
            Err(DomainError::InvalidDepreciationRate)
        );
        assert_eq!(
            compounded_value(dec!(-1), dec!(0), 1),
            Err(DomainError::NegativeAmount)
        );
        Ok(())
    }

    #[test]
    fn invoice_rounding_is_decimal_and_line_based() -> Result<(), DomainError> {
        let result = calculate_invoice(
            &[
                InvoiceLine {
                    quantity: dec!(3),
                    unit_price: dec!(0.335),
                    vat_rate: dec!(0.23),
                },
                InvoiceLine {
                    quantity: dec!(1),
                    unit_price: dec!(10),
                    vat_rate: dec!(0.08),
                },
            ],
            dec!(1),
        )?;
        assert_eq!(result.subtotal, dec!(11.01));
        assert_eq!(result.tax_amount, dec!(1.03));
        assert_eq!(result.total_amount, dec!(12.04));
        Ok(())
    }

    #[test]
    fn loan_overpayment_reduces_term_and_interest() -> Result<(), DomainError> {
        let baseline = simulate_loan_payoff(dec!(100000), dec!(0.08), dec!(1500), dec!(0))?;
        let accelerated = simulate_loan_payoff(dec!(100000), dec!(0.08), dec!(1500), dec!(500))?;
        assert!(accelerated.months < baseline.months);
        assert!(accelerated.interest < baseline.interest);
        Ok(())
    }

    #[test]
    fn non_amortizing_payment_is_rejected() {
        assert_eq!(
            simulate_loan_payoff(dec!(100000), dec!(0.12), dec!(1000), dec!(0)),
            Err(DomainError::NonAmortizingLoan)
        );
    }
}
