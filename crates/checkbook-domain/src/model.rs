use std::{fmt, str::FromStr};

use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DomainError {
    #[error("amount must not be negative")]
    NegativeAmount,
    #[error("currency must be a three-letter ISO 4217 code")]
    InvalidCurrency,
    #[error("invalid VAT rate")]
    InvalidVatRate,
    #[error("monthly payment does not cover accrued interest")]
    NonAmortizingLoan,
    #[error("invalid annual interest rate")]
    InvalidInterestRate,
    #[error("loan end date must include at least one monthly payment after its start date")]
    InvalidLoanDateRange,
    #[error("invalid cadence")]
    InvalidCadence,
    #[error("depreciation rate must be between -100% and 100% per month")]
    InvalidDepreciationRate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MembershipRole {
    Owner,
    Contributor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipKind {
    Owner,
    Spouse,
    Member,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OwnershipScope {
    SelfOwned,
    Spouse,
    Joint,
}

impl OwnershipScope {
    #[must_use]
    pub const fn as_api_str(self) -> &'static str {
        match self {
            Self::SelfOwned => "self",
            Self::Spouse => "spouse",
            Self::Joint => "joint",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataSource {
    BulkLoad,
    AppManual,
    PlanningOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Income,
    Expense,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryStatus {
    Actual,
    Planned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanPriority {
    Idea,
    Considering,
    NiceToHave,
    MustHave,
    NonNegotiable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CategoryKind {
    Expense,
    Income,
    Asset,
    Liability,
    Utility,
    Planning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupKind {
    Location,
    Contract,
    IncomeSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectStatus {
    Planned,
    Active,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cadence {
    Monthly,
    Quarterly,
    Yearly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalType {
    SavingsTarget,
    DebtPaydown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Active,
    Achieved,
    Paused,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Money {
    amount: Decimal,
    currency: String,
}

impl Money {
    pub fn new(amount: Decimal, currency: impl Into<String>) -> Result<Self, DomainError> {
        if amount.is_sign_negative() {
            return Err(DomainError::NegativeAmount);
        }
        let currency = currency.into().trim().to_ascii_uppercase();
        if currency.len() != 3 || !currency.bytes().all(|byte| byte.is_ascii_alphabetic()) {
            return Err(DomainError::InvalidCurrency);
        }
        Ok(Self {
            amount: amount.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero),
            currency,
        })
    }

    #[must_use]
    pub const fn amount(&self) -> Decimal {
        self.amount
    }

    #[must_use]
    pub fn currency(&self) -> &str {
        &self.currency
    }
}

impl fmt::Display for Money {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} {}", self.amount, self.currency)
    }
}

impl FromStr for OwnershipScope {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "self" => Ok(Self::SelfOwned),
            "spouse" => Ok(Self::Spouse),
            "joint" => Ok(Self::Joint),
            _ => Err("unknown ownership scope"),
        }
    }
}

#[cfg(test)]
mod tests {
    use rust_decimal_macros::dec;

    use super::{DomainError, Money, OwnershipScope};

    #[test]
    fn money_rejects_negative_amounts_and_invalid_currency() {
        assert_eq!(
            Money::new(dec!(-0.01), "PLN"),
            Err(DomainError::NegativeAmount)
        );
        assert_eq!(Money::new(dec!(1), "ZL"), Err(DomainError::InvalidCurrency));
    }

    #[test]
    fn money_rounds_at_the_domain_boundary() -> Result<(), DomainError> {
        let money = Money::new(dec!(12.345), "pln")?;
        assert_eq!(money.amount(), dec!(12.35));
        assert_eq!(money.currency(), "PLN");
        Ok(())
    }

    #[test]
    fn ownership_api_values_are_stable() {
        assert_eq!(OwnershipScope::SelfOwned.as_api_str(), "self");
        assert_eq!(OwnershipScope::Spouse.as_api_str(), "spouse");
        assert_eq!(OwnershipScope::Joint.as_api_str(), "joint");
    }
}
