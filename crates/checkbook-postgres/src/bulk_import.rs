//! Generic typed bulk-import ingestion.
//!
//! This is the integration-agnostic entry point that future source plugins
//! target: callers submit already-normalised, typed domain records and the
//! ingestion writes them into the canonical tables inside a single tenant
//! transaction. Records are deduplicated by `(household_id, source_key)` so a
//! re-submission updates in place instead of duplicating.

use std::collections::BTreeMap;

use chrono::{Datelike, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction, types::Json};
use uuid::Uuid;

use crate::{
    assets::{AssetStoreError, create_linked_account},
    planning, tenant,
};

const BULK_SOURCE: &str = "bulk_load";

#[derive(Debug, thiserror::Error)]
pub enum BulkImportError {
    #[error("bulk import validation failed: {0}")]
    Validation(String),
    #[error("bulk import database operation failed")]
    Database(#[from] sqlx::Error),
    #[error("bulk import materialization failed")]
    Materialization,
}

/// Top-level payload. Every section is optional so an integration can submit
/// only the domains it produces.
#[derive(Debug, Default, Deserialize)]
pub struct BulkImportRequest {
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub income_sources: Vec<IncomeSourceIn>,
    #[serde(default)]
    pub expenses: Vec<EntryIn>,
    #[serde(default)]
    pub accounts: Vec<AccountIn>,
    #[serde(default)]
    pub loans: Vec<LoanIn>,
    #[serde(default)]
    pub properties: Vec<PropertyIn>,
    #[serde(default)]
    pub utilities: Vec<UtilityIn>,
}

#[derive(Debug, Deserialize)]
pub struct IncomeSourceIn {
    pub source_key: String,
    pub name: String,
    #[serde(default = "default_employment")]
    pub source_type: String,
    pub owner_scope: String,
    #[serde(default)]
    pub started_on: Option<NaiveDate>,
    #[serde(default)]
    pub ended_on: Option<NaiveDate>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub sort_order: i32,
    #[serde(default)]
    pub lines: Vec<IncomeLineIn>,
    #[serde(default)]
    pub milestones: Vec<MilestoneIn>,
    #[serde(default)]
    pub custom_fields: Vec<CustomFieldIn>,
    #[serde(default)]
    pub entries: Vec<EntryIn>,
}

#[derive(Debug, Deserialize)]
pub struct IncomeLineIn {
    pub label: String,
    #[serde(default)]
    pub amount: f64,
    pub frequency: String,
    #[serde(default)]
    pub owner_scope: Option<String>,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub sort_order: i32,
}

#[derive(Debug, Deserialize)]
pub struct MilestoneIn {
    pub label: String,
    pub date: NaiveDate,
    #[serde(default)]
    pub sort_order: i32,
}

#[derive(Debug, Deserialize)]
pub struct CustomFieldIn {
    pub label: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub sort_order: i32,
}

/// A single ledger entry (income or expense depending on the section it lives in).
#[derive(Debug, Deserialize)]
pub struct EntryIn {
    pub source_key: String,
    #[serde(default)]
    pub entry_date: Option<NaiveDate>,
    #[serde(default)]
    pub amount: f64,
    #[serde(default = "default_currency")]
    pub currency: String,
    pub description: String,
    #[serde(default)]
    pub notes: String,
    pub owner_scope: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub subcategory: Option<String>,
    #[serde(default)]
    pub extra_payload: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct AccountIn {
    pub source_key: String,
    pub name: String,
    pub account_kind: String,
    pub account_type: String,
    #[serde(default = "default_currency")]
    pub currency: String,
    pub owner_scope: String,
    #[serde(default)]
    pub opened_on: Option<NaiveDate>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub snapshots: Vec<SnapshotIn>,
}

#[derive(Debug, Deserialize)]
pub struct SnapshotIn {
    pub source_key: String,
    #[serde(default)]
    pub balance: f64,
    pub effective_date: NaiveDate,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Deserialize)]
pub struct LoanIn {
    pub source_key: String,
    pub account_source_key: String,
    pub name: String,
    pub liability_type: String,
    pub owner_scope: String,
    #[serde(default)]
    pub original_balance: f64,
    #[serde(default)]
    pub current_balance: f64,
    #[serde(default)]
    pub interest_rate: f64,
    #[serde(default)]
    pub monthly_payment: f64,
    #[serde(default)]
    pub start_date: Option<NaiveDate>,
    #[serde(default)]
    pub end_date: Option<NaiveDate>,
    #[serde(default)]
    pub notes: String,
    /// Links this loan to a `properties[]` entry (by its `source_key`), e.g.
    /// a mortgage to its apartment or a car loan to its vehicle. Properties
    /// are ingested before loans specifically so this resolves.
    #[serde(default)]
    pub property_source_key: Option<String>,
    #[serde(default)]
    pub payments: Vec<LoanPaymentIn>,
}

#[derive(Debug, Deserialize)]
pub struct LoanPaymentIn {
    pub source_key: String,
    pub payment_date: NaiveDate,
    #[serde(default)]
    pub total_payment: f64,
    #[serde(default)]
    pub principal_amount: f64,
    #[serde(default)]
    pub interest_amount: f64,
    #[serde(default)]
    pub extra_payment: f64,
    #[serde(default)]
    pub remaining_balance: Option<f64>,
    #[serde(default)]
    pub interest_balance: Option<f64>,
    /// Legacy status used when `completed` is not explicitly supplied.
    #[serde(default)]
    pub projected: bool,
    /// Completed rows are immutable to subsequent automatic imports.
    #[serde(default)]
    pub completed: Option<bool>,
}

impl LoanPaymentIn {
    fn is_completed(&self) -> bool {
        self.completed.unwrap_or(!self.projected)
    }
}

fn default_currency() -> String {
    "PLN".to_owned()
}

fn default_employment() -> String {
    "employment".to_owned()
}

const SCOPES: [&str; 3] = ["self", "spouse", "joint"];

fn validate_scope(scope: &str) -> Result<(), BulkImportError> {
    if SCOPES.contains(&scope) {
        Ok(())
    } else {
        Err(BulkImportError::Validation(format!(
            "invalid owner_scope: {scope}"
        )))
    }
}

fn dec2(value: f64) -> Result<Decimal, BulkImportError> {
    Decimal::try_from(value)
        .map(|amount| amount.round_dp(2).max(Decimal::ZERO))
        .map_err(|_| BulkImportError::Validation(format!("invalid amount: {value}")))
}

fn dec6(value: f64) -> Result<Decimal, BulkImportError> {
    let parsed = Decimal::try_from(value)
        .map_err(|_| BulkImportError::Validation(format!("invalid depreciation_rate: {value}")))?;
    if parsed < Decimal::NEGATIVE_ONE || parsed > Decimal::ONE {
        return Err(BulkImportError::Validation(format!(
            "depreciation_rate must be between -1 and 1: {value}"
        )));
    }
    Ok(parsed.round_dp(6))
}

fn rate(value: f64) -> Result<Decimal, BulkImportError> {
    let parsed = Decimal::try_from(value)
        .map_err(|_| BulkImportError::Validation(format!("invalid interest_rate: {value}")))?;
    if parsed < Decimal::ZERO || parsed > Decimal::ONE {
        return Err(BulkImportError::Validation(format!(
            "interest_rate must be between 0 and 1: {value}"
        )));
    }
    Ok(parsed.round_dp(8))
}

#[derive(Debug, Default)]
struct Counts {
    inserted: u64,
    updated: u64,
    by_entity: BTreeMap<String, u64>,
}

impl Counts {
    fn record(&mut self, entity: &str, inserted: bool) {
        if inserted {
            self.inserted += 1;
        } else {
            self.updated += 1;
        }
        *self.by_entity.entry(entity.to_owned()).or_default() += 1;
    }

    fn to_value(&self) -> Value {
        json!({
            "inserted": self.inserted,
            "updated": self.updated,
            "by_entity": self.by_entity,
        })
    }
}

/// Result returned to the caller.
#[derive(Debug)]
pub struct BulkImportOutcome {
    pub run_id: Uuid,
    pub counts: Value,
}

pub async fn run_bulk_import(
    pool: &PgPool,
    household_id: Uuid,
    request: BulkImportRequest,
) -> Result<BulkImportOutcome, BulkImportError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let mut counts = Counts::default();

    for account in &request.accounts {
        ingest_account(&mut transaction, household_id, account, &mut counts).await?;
    }
    // Properties before loans and utilities: loans resolve an optional
    // `property_source_key` link, and utility bills attach to a property by
    // source_key.
    for property in &request.properties {
        ingest_property(&mut transaction, household_id, property, &mut counts).await?;
    }
    for loan in &request.loans {
        ingest_loan(&mut transaction, household_id, loan, &mut counts).await?;
    }
    for utility in &request.utilities {
        ingest_utility(&mut transaction, household_id, utility, &mut counts).await?;
    }
    for source in &request.income_sources {
        ingest_income_source(&mut transaction, household_id, source, &mut counts).await?;
    }
    for expense in &request.expenses {
        ingest_entry(
            &mut transaction,
            household_id,
            expense,
            "expense",
            None,
            &mut counts,
        )
        .await?;
    }

    let counts_value = counts.to_value();
    let run_id = record_run(
        &mut transaction,
        household_id,
        &request.source,
        &counts_value,
    )
    .await?;
    transaction.commit().await?;

    planning::materialize_household(pool, household_id, Utc::now().date_naive())
        .await
        .map_err(|error| {
            tracing::error!(%error, "bulk import materialization failed");
            BulkImportError::Materialization
        })?;

    Ok(BulkImportOutcome {
        run_id,
        counts: counts_value,
    })
}

async fn ingest_account(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    account: &AccountIn,
    counts: &mut Counts,
) -> Result<Uuid, BulkImportError> {
    validate_scope(&account.owner_scope)?;
    if account.account_kind != "asset" && account.account_kind != "liability" {
        return Err(BulkImportError::Validation(format!(
            "invalid account_kind: {}",
            account.account_kind
        )));
    }
    let row = sqlx::query(
        "INSERT INTO financial_accounts
            (household_id, name, account_kind, account_type, currency, owner_scope, opened_on, notes, source_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (household_id, source_key) DO UPDATE SET
            name = EXCLUDED.name, account_kind = EXCLUDED.account_kind,
            account_type = EXCLUDED.account_type, currency = EXCLUDED.currency,
            owner_scope = EXCLUDED.owner_scope, opened_on = EXCLUDED.opened_on,
            notes = EXCLUDED.notes, updated_at = now()
         RETURNING id, (xmax = 0) AS inserted",
    )
    .bind(household_id)
    .bind(&account.name)
    .bind(&account.account_kind)
    .bind(&account.account_type)
    .bind(&account.currency)
    .bind(&account.owner_scope)
    .bind(account.opened_on)
    .bind(&account.notes)
    .bind(&account.source_key)
    .fetch_one(&mut **tx)
    .await?;
    let account_id: Uuid = row.try_get("id")?;
    counts.record("accounts", row.try_get("inserted")?);

    for snapshot in &account.snapshots {
        let snap = sqlx::query(
            "INSERT INTO account_balance_snapshots
                (household_id, account_id, balance, effective_date, data_source, source_key, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (household_id, account_id, effective_date, source_key) DO UPDATE SET
                balance = EXCLUDED.balance, data_source = EXCLUDED.data_source,
                notes = EXCLUDED.notes, updated_at = now()
             RETURNING (xmax = 0) AS inserted",
        )
        .bind(household_id)
        .bind(account_id)
        .bind(dec2(snapshot.balance)?)
        .bind(snapshot.effective_date)
        .bind(BULK_SOURCE)
        .bind(&snapshot.source_key)
        .bind(&snapshot.notes)
        .fetch_one(&mut **tx)
        .await?;
        counts.record("account_snapshots", snap.try_get("inserted")?);
    }
    Ok(account_id)
}

async fn ingest_loan(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    loan: &LoanIn,
    counts: &mut Counts,
) -> Result<(), BulkImportError> {
    validate_scope(&loan.owner_scope)?;
    if !["debt", "loan", "mortgage"].contains(&loan.liability_type.as_str()) {
        return Err(BulkImportError::Validation(format!(
            "invalid liability_type: {}",
            loan.liability_type
        )));
    }
    // A loan must be backed by a liability financial account.
    let account = AccountIn {
        source_key: loan.account_source_key.clone(),
        name: loan.name.clone(),
        account_kind: "liability".to_owned(),
        account_type: loan.liability_type.clone(),
        currency: default_currency(),
        owner_scope: loan.owner_scope.clone(),
        opened_on: loan.start_date,
        notes: String::new(),
        snapshots: Vec::new(),
    };
    let account_id = ingest_account(tx, household_id, &account, counts).await?;

    let linked_property_id = match &loan.property_source_key {
        Some(property_source_key) => Some(
            sqlx::query!(
                "SELECT id FROM properties WHERE household_id = $1 AND source_key = $2",
                household_id,
                property_source_key
            )
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| {
                BulkImportError::Validation(format!(
                    "loan {} references unknown property_source_key {property_source_key}",
                    loan.source_key
                ))
            })?
            .id,
        ),
        None => None,
    };

    let row = sqlx::query!(
        "INSERT INTO loans
            (household_id, account_id, name, liability_type, owner_scope, original_balance,
             current_balance, interest_rate, monthly_payment, start_date, end_date, notes,
             linked_property_id, data_source, source_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (household_id, source_key) DO UPDATE SET
            name = EXCLUDED.name, liability_type = EXCLUDED.liability_type,
            owner_scope = EXCLUDED.owner_scope, original_balance = EXCLUDED.original_balance,
            current_balance = EXCLUDED.current_balance, interest_rate = EXCLUDED.interest_rate,
            monthly_payment = EXCLUDED.monthly_payment, start_date = EXCLUDED.start_date,
            end_date = EXCLUDED.end_date, notes = EXCLUDED.notes,
            linked_property_id = EXCLUDED.linked_property_id,
            terms_payload = loans.terms_payload - 'payment_schedule', updated_at = now()
         RETURNING id, schedule_opening_balance, (xmax = 0) AS \"inserted!\"",
        household_id,
        account_id,
        &loan.name,
        &loan.liability_type,
        &loan.owner_scope,
        dec2(loan.original_balance)?,
        dec2(loan.current_balance)?,
        rate(loan.interest_rate)?,
        dec2(loan.monthly_payment)?,
        loan.start_date,
        loan.end_date,
        &loan.notes,
        linked_property_id,
        BULK_SOURCE,
        &loan.source_key
    )
    .fetch_one(&mut **tx)
    .await?;
    let loan_id = row.id;
    counts.record("loans", row.inserted);

    let source_keys: Vec<String> = loan
        .payments
        .iter()
        .map(|payment| payment.source_key.clone())
        .collect();
    sqlx::query!(
        "DELETE FROM loan_payments
         WHERE household_id = $1 AND loan_id = $2 AND NOT completed
           AND (source_key IS NULL OR NOT (source_key = ANY($3)))",
        household_id,
        loan_id,
        &source_keys
    )
    .execute(&mut **tx)
    .await?;

    for (index, payment) in loan.payments.iter().enumerate() {
        let schedule_order = i32::try_from(index)
            .map_err(|_| BulkImportError::Validation("too many loan payment rows".to_owned()))?;
        let pay = sqlx::query!(
            "INSERT INTO loan_payments
                (household_id, loan_id, payment_date, total_payment, principal_amount,
                 interest_amount, extra_payment, remaining_balance, source_key,
                 completed, interest_balance, schedule_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (household_id, source_key) DO UPDATE SET
                loan_id = EXCLUDED.loan_id, payment_date = EXCLUDED.payment_date,
                total_payment = EXCLUDED.total_payment, principal_amount = EXCLUDED.principal_amount,
                interest_amount = EXCLUDED.interest_amount, extra_payment = EXCLUDED.extra_payment,
                remaining_balance = EXCLUDED.remaining_balance,
                completed = EXCLUDED.completed, interest_balance = EXCLUDED.interest_balance,
                schedule_order = EXCLUDED.schedule_order, updated_at = now()
             WHERE NOT loan_payments.completed
             RETURNING (xmax = 0) AS \"inserted!\"",
            household_id,
            loan_id,
            payment.payment_date,
            dec2(payment.total_payment)?,
            dec2(payment.principal_amount)?,
            dec2(payment.interest_amount)?,
            dec2(payment.extra_payment)?,
            payment.remaining_balance.map(dec2).transpose()?,
            &payment.source_key,
            payment.is_completed(),
            payment.interest_balance.map(dec2).transpose()?,
            schedule_order
        )
        .fetch_optional(&mut **tx)
        .await?;
        if let Some(pay) = pay {
            counts.record("loan_payments", pay.inserted);
        }
    }

    // Reconcile persisted history, not the incoming copy of completed payments.
    let (stored, defaults) = crate::loan_payments::load(tx, household_id, loan_id).await?;
    let mut schedule = stored.clone();
    let mut contractual_payments = std::collections::HashSet::new();
    for (index, payment) in schedule.iter_mut().enumerate() {
        if payment.id.is_some_and(|id| defaults.contains(&id)) {
            contractual_payments.insert(index);
            if !payment.is_completed() {
                payment.payment = None;
            }
        }
    }
    let has_history = stored.iter().any(|payment| {
        payment.is_completed()
            && (payment.outstanding_loan_balance.is_some()
                || payment.principal.is_some()
                || payment.extra_principal.is_some())
    });
    let opening_balance = row.schedule_opening_balance.unwrap_or(if has_history {
        dec2(loan.original_balance)?
    } else {
        dec2(loan.current_balance)?
    });
    let reconciled = checkbook_domain::reconcile_loan_schedule(
        opening_balance,
        dec2(loan.current_balance)?,
        rate(loan.interest_rate)?,
        dec2(loan.monthly_payment)?,
        schedule,
    )
    .map_err(|error| BulkImportError::Validation(error.to_string()))?;
    let mut schedule = reconciled.schedule;
    crate::loan_payments::replace(
        tx,
        household_id,
        loan_id,
        &stored,
        &mut schedule,
        &contractual_payments,
        false,
    )
    .await
    .map_err(|error| match error {
        AssetStoreError::Database(source) => BulkImportError::Database(source),
        other => BulkImportError::Validation(other.to_string()),
    })?;
    sqlx::query!(
        "UPDATE loans SET current_balance = $3, schedule_opening_balance = $4 WHERE household_id = $1 AND id = $2",
        household_id,
        loan_id,
        reconciled.current_balance,
        opening_balance
    )
    .execute(&mut **tx)
    .await?;

    // Imported backing accounts intentionally have no balance snapshots. Net worth
    // reads the canonical loan schedule and excludes the legacy wealth:debt aggregate.
    Ok(())
}

async fn ingest_income_source(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    source: &IncomeSourceIn,
    counts: &mut Counts,
) -> Result<(), BulkImportError> {
    validate_scope(&source.owner_scope)?;
    let row = sqlx::query(
        "INSERT INTO income_sources
            (household_id, name, source_type, owner_scope, started_on, ended_on, notes, sort_order, source_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (household_id, source_key) DO UPDATE SET
            name = EXCLUDED.name, source_type = EXCLUDED.source_type,
            owner_scope = EXCLUDED.owner_scope, started_on = EXCLUDED.started_on,
            ended_on = EXCLUDED.ended_on, notes = EXCLUDED.notes,
            sort_order = EXCLUDED.sort_order, updated_at = now()
         RETURNING id, (xmax = 0) AS inserted",
    )
    .bind(household_id)
    .bind(&source.name)
    .bind(&source.source_type)
    .bind(&source.owner_scope)
    .bind(source.started_on)
    .bind(source.ended_on)
    .bind(&source.notes)
    .bind(source.sort_order)
    .bind(&source.source_key)
    .fetch_one(&mut **tx)
    .await?;
    let source_id: Uuid = row.try_get("id")?;
    counts.record("income_sources", row.try_get("inserted")?);

    // Children are re-synced wholesale: clear then re-insert so re-imports stay consistent.
    sqlx::query(
        "DELETE FROM income_source_lines WHERE household_id = $1 AND income_source_id = $2",
    )
    .bind(household_id)
    .bind(source_id)
    .execute(&mut **tx)
    .await?;
    for (index, line) in source.lines.iter().enumerate() {
        if let Some(scope) = &line.owner_scope {
            validate_scope(scope)?;
        }
        sqlx::query(
            "INSERT INTO income_source_lines
                (household_id, income_source_id, label, amount, frequency, owner_scope, category, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        )
        .bind(household_id)
        .bind(source_id)
        .bind(&line.label)
        .bind(dec2(line.amount)?)
        .bind(&line.frequency)
        .bind(line.owner_scope.as_deref())
        .bind(&line.category)
        .bind(if line.sort_order != 0 { line.sort_order } else { index as i32 })
        .execute(&mut **tx)
        .await?;
        counts.record("income_source_lines", true);
    }

    sqlx::query(
        "DELETE FROM income_source_milestones WHERE household_id = $1 AND income_source_id = $2",
    )
    .bind(household_id)
    .bind(source_id)
    .execute(&mut **tx)
    .await?;
    for (index, milestone) in source.milestones.iter().enumerate() {
        sqlx::query(
            "INSERT INTO income_source_milestones
                (household_id, income_source_id, label, milestone_date, sort_order)
             VALUES ($1,$2,$3,$4,$5)",
        )
        .bind(household_id)
        .bind(source_id)
        .bind(&milestone.label)
        .bind(milestone.date)
        .bind(if milestone.sort_order != 0 {
            milestone.sort_order
        } else {
            index as i32
        })
        .execute(&mut **tx)
        .await?;
        counts.record("income_source_milestones", true);
    }

    sqlx::query(
        "DELETE FROM income_source_custom_fields WHERE household_id = $1 AND income_source_id = $2",
    )
    .bind(household_id)
    .bind(source_id)
    .execute(&mut **tx)
    .await?;
    for (index, field) in source.custom_fields.iter().enumerate() {
        sqlx::query(
            "INSERT INTO income_source_custom_fields
                (household_id, income_source_id, label, value, sort_order)
             VALUES ($1,$2,$3,$4,$5)",
        )
        .bind(household_id)
        .bind(source_id)
        .bind(&field.label)
        .bind(&field.value)
        .bind(if field.sort_order != 0 {
            field.sort_order
        } else {
            index as i32
        })
        .execute(&mut **tx)
        .await?;
        counts.record("income_source_custom_fields", true);
    }

    for entry in &source.entries {
        ingest_entry(tx, household_id, entry, "income", Some(source_id), counts).await?;
    }
    Ok(())
}

async fn ingest_entry(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    entry: &EntryIn,
    direction: &str,
    income_source_id: Option<Uuid>,
    counts: &mut Counts,
) -> Result<(), BulkImportError> {
    validate_scope(&entry.owner_scope)?;
    let kind = if direction == "income" {
        "income"
    } else {
        "expense"
    };
    let category_id = match &entry.category {
        Some(name) if !name.trim().is_empty() => {
            Some(get_or_create_category(tx, household_id, kind, name, None).await?)
        }
        _ => None,
    };
    let subcategory_id = match (&entry.subcategory, category_id) {
        (Some(name), Some(parent)) if !name.trim().is_empty() => {
            Some(get_or_create_category(tx, household_id, kind, name, Some(parent)).await?)
        }
        _ => None,
    };
    let payload = entry.extra_payload.clone().unwrap_or_else(|| json!({}));
    let row = sqlx::query(
        "INSERT INTO ledger_entries
            (household_id, direction, status, amount, currency, entry_date, description, notes,
             owner_scope, data_source, category_id, subcategory_id, income_source_id,
             source_key, extra_payload)
         VALUES ($1,$2,'actual',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (household_id, source_key) DO UPDATE SET
            direction = EXCLUDED.direction, amount = EXCLUDED.amount, currency = EXCLUDED.currency,
            entry_date = EXCLUDED.entry_date, description = EXCLUDED.description,
            notes = EXCLUDED.notes, owner_scope = EXCLUDED.owner_scope,
            category_id = EXCLUDED.category_id, subcategory_id = EXCLUDED.subcategory_id,
            income_source_id = EXCLUDED.income_source_id, extra_payload = EXCLUDED.extra_payload,
            updated_at = now()
         RETURNING (xmax = 0) AS inserted",
    )
    .bind(household_id)
    .bind(direction)
    .bind(dec2(entry.amount)?)
    .bind(&entry.currency)
    .bind(entry.entry_date)
    .bind(entry.description.trim())
    .bind(&entry.notes)
    .bind(&entry.owner_scope)
    .bind(BULK_SOURCE)
    .bind(category_id)
    .bind(subcategory_id)
    .bind(income_source_id)
    .bind(&entry.source_key)
    .bind(Json(payload))
    .fetch_one(&mut **tx)
    .await?;
    counts.record(
        if direction == "income" {
            "income_entries"
        } else {
            "expense_entries"
        },
        row.try_get("inserted")?,
    );
    Ok(())
}

async fn get_or_create_category(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    kind: &str,
    name: &str,
    parent_id: Option<Uuid>,
) -> Result<Uuid, BulkImportError> {
    let normalized = name.trim().to_lowercase();
    if let Some(row) = sqlx::query(
        "SELECT id FROM categories
         WHERE household_id = $1 AND kind = $2 AND normalized_name = $3
           AND parent_id IS NOT DISTINCT FROM $4",
    )
    .bind(household_id)
    .bind(kind)
    .bind(&normalized)
    .bind(parent_id)
    .fetch_optional(&mut **tx)
    .await?
    {
        return Ok(row.try_get("id")?);
    }
    let row = sqlx::query(
        "INSERT INTO categories (household_id, kind, name, normalized_name, parent_id)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id",
    )
    .bind(household_id)
    .bind(kind)
    .bind(name.trim())
    .bind(&normalized)
    .bind(parent_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(row.try_get("id")?)
}

async fn record_run(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    source: &str,
    counts: &Value,
) -> Result<Uuid, BulkImportError> {
    let label = if source.trim().is_empty() {
        "bulk-import"
    } else {
        source.trim()
    };
    let row = sqlx::query(
        "INSERT INTO data_load_runs
            (household_id, idempotency_key, status, archive_version, counts, archive_path,
             archive_sha256, committed_at)
         VALUES ($1,$2,'committed',0,$3,$4,'',now())
         RETURNING id",
    )
    .bind(household_id)
    .bind(format!("bulk:{label}:{}", Uuid::now_v7()))
    .bind(Json(counts.clone()))
    .bind(format!("inline:{label}"))
    .fetch_one(&mut **tx)
    .await?;
    Ok(row.try_get("id")?)
}

// ---- Properties + renovation projects ----

#[derive(Debug, Deserialize)]
pub struct PropertyIn {
    pub source_key: String,
    pub name: String,
    #[serde(default)]
    pub valuation: f64,
    pub valuation_date: NaiveDate,
    /// Monthly compounding rate applied forward from `valuation`/`valuation_date`.
    /// Negative depreciates, positive appreciates; omit or use 0 for a flat value.
    #[serde(default)]
    pub depreciation_rate: f64,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub started_on: Option<NaiveDate>,
    #[serde(default)]
    pub ended_on: Option<NaiveDate>,
    #[serde(default)]
    pub notes: String,
    #[serde(default = "default_property_category")]
    pub category: String,
    /// Links this property/vehicle to an existing entry in `accounts[]` (by
    /// its `source_key`) instead of minting a second, disconnected
    /// `financial_accounts` row for the same physical asset. When absent, a
    /// fresh linked account is created from `valuation`/`valuation_date` so
    /// every property still gets net-worth history.
    #[serde(default)]
    pub account_source_key: Option<String>,
    #[serde(default)]
    pub projects: Vec<ProjectIn>,
}

fn default_property_category() -> String {
    "property".to_owned()
}

#[derive(Debug, Deserialize)]
pub struct ProjectIn {
    pub source_key: String,
    pub name: String,
    #[serde(default)]
    pub budget: f64,
    #[serde(default)]
    pub valuation_date: Option<NaiveDate>,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub rooms: Vec<RoomIn>,
}

#[derive(Debug, Deserialize)]
pub struct RoomIn {
    pub name: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub sections: Vec<SectionIn>,
}

#[derive(Debug, Deserialize)]
pub struct SectionIn {
    pub name: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub items: Vec<ItemIn>,
}

#[derive(Debug, Deserialize)]
pub struct ItemIn {
    pub name: String,
    #[serde(default)]
    pub unit_price: Option<f64>,
    #[serde(default)]
    pub quantity: Option<f64>,
    #[serde(default)]
    pub total_cost: f64,
    #[serde(default)]
    pub completed: bool,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Deserialize)]
pub struct UtilityIn {
    pub service_key: String,
    pub label: String,
    #[serde(default = "default_service_kind")]
    pub service_kind: String,
    #[serde(default)]
    pub unit: String,
    pub property_source_key: String,
    #[serde(default)]
    pub bills: Vec<UtilityBillIn>,
}

#[derive(Debug, Deserialize)]
pub struct UtilityBillIn {
    pub source_key: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub amount: f64,
    #[serde(default = "default_currency")]
    pub currency: String,
    pub charge_date: NaiveDate,
    #[serde(default = "default_owner_joint")]
    pub owner_scope: String,
    #[serde(default = "default_true")]
    pub is_recurring: bool,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub reading: Option<f64>,
    #[serde(default)]
    pub usage_amount: Option<f64>,
}

fn default_status() -> String {
    "active".to_owned()
}

fn default_service_kind() -> String {
    "cost".to_owned()
}

fn default_owner_joint() -> String {
    "joint".to_owned()
}

fn default_true() -> bool {
    true
}

fn dec4(value: f64) -> Result<Decimal, BulkImportError> {
    Decimal::try_from(value)
        .map(|amount| amount.round_dp(4).max(Decimal::ZERO))
        .map_err(|_| BulkImportError::Validation(format!("invalid amount: {value}")))
}

fn validate_status(status: &str) -> Result<(), BulkImportError> {
    if ["planned", "active", "completed"].contains(&status) {
        Ok(())
    } else {
        Err(BulkImportError::Validation(format!(
            "invalid status: {status}"
        )))
    }
}

async fn ingest_property(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    property: &PropertyIn,
    counts: &mut Counts,
) -> Result<(), BulkImportError> {
    validate_status(&property.status)?;
    if !["property", "vehicle", "other"].contains(&property.category.as_str()) {
        return Err(BulkImportError::Validation(format!(
            "invalid property category: {}",
            property.category
        )));
    }
    let row = sqlx::query(
        "INSERT INTO properties
            (household_id, name, valuation, valuation_date, depreciation_rate, status,
             started_on, ended_on, notes, category, data_source, source_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (household_id, source_key) DO UPDATE SET
            name = EXCLUDED.name, valuation = EXCLUDED.valuation,
            valuation_date = EXCLUDED.valuation_date,
            depreciation_rate = EXCLUDED.depreciation_rate, status = EXCLUDED.status,
            started_on = EXCLUDED.started_on, ended_on = EXCLUDED.ended_on,
            notes = EXCLUDED.notes, category = EXCLUDED.category, updated_at = now()
         RETURNING id, account_id, (xmax = 0) AS inserted",
    )
    .bind(household_id)
    .bind(&property.name)
    .bind(dec2(property.valuation)?)
    .bind(property.valuation_date)
    .bind(dec6(property.depreciation_rate)?)
    .bind(&property.status)
    .bind(property.started_on)
    .bind(property.ended_on)
    .bind(&property.notes)
    .bind(&property.category)
    .bind(BULK_SOURCE)
    .bind(&property.source_key)
    .fetch_one(&mut **tx)
    .await?;
    let property_id: Uuid = row.try_get("id")?;
    let existing_account_id: Option<Uuid> = row.try_get("account_id")?;
    counts.record("properties", row.try_get("inserted")?);

    // Link the property to the net-worth-tracked account for its valuation
    // instead of leaving it as a disconnected number: reuse an existing
    // account when the payload names one (e.g. a spreadsheet's separate
    // "wealth" account for the same apartment/car), otherwise mint a fresh
    // one so every property/vehicle has net-worth history.
    let account_id = if let Some(account_source_key) = &property.account_source_key {
        let account = sqlx::query!(
            "SELECT id FROM financial_accounts WHERE household_id = $1 AND source_key = $2",
            household_id,
            account_source_key
        )
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| {
            BulkImportError::Validation(format!(
                "property {} references unknown account_source_key {account_source_key}",
                property.source_key
            ))
        })?;
        Some(account.id)
    } else {
        existing_account_id
    };
    let account_id = match account_id {
        Some(id) => id,
        None => create_linked_account(
            tx,
            household_id,
            &property.name,
            &property.category,
            &default_currency(),
            dec2(property.valuation)?,
            property.valuation_date,
        )
        .await
        .map_err(|error| match error {
            AssetStoreError::Database(source) => BulkImportError::Database(source),
            other => BulkImportError::Validation(other.to_string()),
        })?,
    };
    sqlx::query!(
        "UPDATE properties SET account_id = $3 WHERE household_id = $1 AND id = $2",
        household_id,
        property_id,
        account_id
    )
    .execute(&mut **tx)
    .await?;

    for project in &property.projects {
        ingest_project(tx, household_id, property_id, project, counts).await?;
    }
    Ok(())
}

async fn ingest_project(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    property_id: Uuid,
    project: &ProjectIn,
    counts: &mut Counts,
) -> Result<(), BulkImportError> {
    validate_status(&project.status)?;
    let valuation_date = project
        .valuation_date
        .unwrap_or_else(|| Utc::now().date_naive());
    let row = sqlx::query(
        "INSERT INTO projects
            (household_id, linked_property_id, name, budget, valuation_date, stored_status,
             notes, data_source, source_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (household_id, source_key) DO UPDATE SET
            linked_property_id = EXCLUDED.linked_property_id, name = EXCLUDED.name,
            budget = EXCLUDED.budget, valuation_date = EXCLUDED.valuation_date,
            stored_status = EXCLUDED.stored_status, notes = EXCLUDED.notes, updated_at = now()
         RETURNING id, (xmax = 0) AS inserted",
    )
    .bind(household_id)
    .bind(property_id)
    .bind(&project.name)
    .bind(dec2(project.budget)?)
    .bind(valuation_date)
    .bind(&project.status)
    .bind(&project.notes)
    .bind(BULK_SOURCE)
    .bind(&project.source_key)
    .fetch_one(&mut **tx)
    .await?;
    let project_id: Uuid = row.try_get("id")?;
    counts.record("projects", row.try_get("inserted")?);

    // Rooms/sections/items carry no source_key, so re-sync the tree wholesale.
    sqlx::query("DELETE FROM project_rooms WHERE household_id = $1 AND project_id = $2")
        .bind(household_id)
        .bind(project_id)
        .execute(&mut **tx)
        .await?;
    for (ri, room) in project.rooms.iter().enumerate() {
        let room_row = sqlx::query(
            "INSERT INTO project_rooms (household_id, project_id, name, notes, sort_order)
             VALUES ($1,$2,$3,$4,$5)
             RETURNING id",
        )
        .bind(household_id)
        .bind(project_id)
        .bind(&room.name)
        .bind(&room.notes)
        .bind(ri as i32)
        .fetch_one(&mut **tx)
        .await?;
        let room_id: Uuid = room_row.try_get("id")?;
        counts.record("project_rooms", true);
        for (si, section) in room.sections.iter().enumerate() {
            let section_row = sqlx::query(
                "INSERT INTO project_sections (household_id, room_id, name, notes, sort_order)
                 VALUES ($1,$2,$3,$4,$5)
                 RETURNING id",
            )
            .bind(household_id)
            .bind(room_id)
            .bind(&section.name)
            .bind(&section.notes)
            .bind(si as i32)
            .fetch_one(&mut **tx)
            .await?;
            let section_id: Uuid = section_row.try_get("id")?;
            counts.record("project_sections", true);
            for (ii, item) in section.items.iter().enumerate() {
                sqlx::query(
                    "INSERT INTO project_items
                        (household_id, section_id, name, unit_price, quantity, total_cost,
                         completed, notes, sort_order)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                )
                .bind(household_id)
                .bind(section_id)
                .bind(&item.name)
                .bind(item.unit_price.map(dec4).transpose()?)
                .bind(item.quantity.map(dec4).transpose()?)
                .bind(dec2(item.total_cost)?)
                .bind(item.completed)
                .bind(&item.notes)
                .bind(ii as i32)
                .execute(&mut **tx)
                .await?;
                counts.record("project_items", true);
            }
        }
    }
    Ok(())
}

async fn lookup_property_id(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    source_key: &str,
) -> Result<Option<Uuid>, BulkImportError> {
    let row = sqlx::query("SELECT id FROM properties WHERE household_id = $1 AND source_key = $2")
        .bind(household_id)
        .bind(source_key)
        .fetch_optional(&mut **tx)
        .await?;
    match row {
        Some(row) => Ok(Some(row.try_get("id")?)),
        None => Ok(None),
    }
}

async fn ingest_utility(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    utility: &UtilityIn,
    counts: &mut Counts,
) -> Result<(), BulkImportError> {
    if utility.service_kind != "cost" && utility.service_kind != "metered" {
        return Err(BulkImportError::Validation(format!(
            "invalid service_kind: {}",
            utility.service_kind
        )));
    }
    let property_id = lookup_property_id(tx, household_id, &utility.property_source_key)
        .await?
        .ok_or_else(|| {
            BulkImportError::Validation(format!(
                "unknown property_source_key: {}",
                utility.property_source_key
            ))
        })?;

    let import_key = format!("import_{}_{}", property_id.simple(), utility.service_key);
    let source_keys: Vec<_> = utility
        .bills
        .iter()
        .map(|bill| bill.source_key.clone())
        .collect();
    let existing = sqlx::query!(
        "SELECT property_id, utility_contract_id FROM utility_bills
         WHERE household_id=$1 AND source_key = ANY($2)",
        household_id,
        &source_keys,
    )
    .fetch_all(&mut **tx)
    .await?;
    if existing
        .iter()
        .any(|bill| bill.property_id != Some(property_id))
    {
        return Err(BulkImportError::Validation(
            "Imported utility bills cannot move to another property.".to_owned(),
        ));
    }
    let contract_id = sqlx::query_scalar!(
        "SELECT utility_contract_id FROM utility_contract_import_sources
         WHERE household_id=$1 AND property_id=$2 AND source_service_key=$3",
        household_id,
        property_id,
        utility.service_key,
    )
    .fetch_optional(&mut **tx)
    .await?;
    if existing
        .iter()
        .any(|bill| contract_id.is_none() || bill.utility_contract_id != contract_id)
    {
        return Err(BulkImportError::Validation(
            "Imported utility bills cannot move to another contract.".to_owned(),
        ));
    }
    let service_key = if let Some(id) = contract_id {
        let current = sqlx::query!(
            "SELECT s.service_key,s.unit,s.service_kind,c.start_date,c.end_date,c.tracking_mode
             FROM utility_contracts c JOIN utility_services s
             ON s.household_id=c.household_id AND s.id=c.service_id
             WHERE c.household_id=$1 AND c.property_id=$2 AND c.id=$3",
            household_id,
            property_id,
            id,
        )
        .fetch_one(&mut **tx)
        .await?;
        if current.unit != utility.unit || current.service_kind != utility.service_kind {
            return Err(BulkImportError::Validation(
                "Imported utility unit and kind cannot change an existing contract.".to_owned(),
            ));
        }
        // Lifetime guards use month boundaries: contract pricing and editing
        // are whole-month, so a bill lands inside a lifetime month even when
        // its day precedes the contract's exact start day.
        let start_month = month_start(current.start_date);
        if current.tracking_mode != "actual"
            && utility
                .bills
                .iter()
                .any(|bill| bill.charge_date < start_month)
        {
            return Err(BulkImportError::Validation(
                "Earlier imported history requires an explicit start date and tariff correction for this contract.".to_owned(),
            ));
        }
        if let Some(end) = current.end_date {
            let end_month_exclusive = month_after(end);
            if utility
                .bills
                .iter()
                .any(|bill| bill.charge_date >= end_month_exclusive)
            {
                return Err(BulkImportError::Validation(
                    "Imported utility bills cannot be recorded after the contract end date."
                        .to_owned(),
                ));
            }
        }
        current.service_key
    } else {
        import_key
    };
    // External keys are property-scoped so another property's import cannot
    // replace this contract's configuration or recorded amounts.
    let service_row = sqlx::query!(
        r#"INSERT INTO utility_services (household_id, service_key, label, service_kind, unit)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (household_id, service_key) DO UPDATE SET
            label = EXCLUDED.label, service_kind = EXCLUDED.service_kind,
            unit = EXCLUDED.unit, updated_at = now()
         RETURNING id, (xmax = 0) AS "inserted!""#,
        household_id,
        service_key,
        utility.label,
        utility.service_kind,
        utility.unit,
    )
    .fetch_one(&mut **tx)
    .await?;
    let service_id = service_row.id;
    counts.record("utility_services", service_row.inserted);

    let earliest = utility.bills.iter().map(|bill| bill.charge_date).min();
    // Without bills, start at the property start or household-local creation
    // date. Imported amounts are actual observations, never inferred tariffs.
    let start_date = sqlx::query_scalar!(
        r#"SELECT COALESCE($3::date, p.started_on, (p.created_at AT TIME ZONE h.timezone)::date) AS "start_date!"
           FROM properties p JOIN households h ON h.id=p.household_id
           WHERE p.household_id=$1 AND p.id=$2"#,
        household_id, property_id, earliest,
    ).fetch_one(&mut **tx).await?;
    let contract_id = sqlx::query_scalar!(
        "INSERT INTO utility_contracts (household_id,property_id,service_id,start_date,tracking_mode,sort_order)
         VALUES ($1,$2,$3,$4,'actual',COALESCE((SELECT max(sort_order)+1 FROM utility_contracts WHERE household_id=$1 AND property_id=$2),0))
         ON CONFLICT (household_id,service_id) DO UPDATE SET start_date=LEAST(utility_contracts.start_date,EXCLUDED.start_date)
         RETURNING id", household_id, property_id, service_id, start_date,
    ).fetch_one(&mut **tx).await?;
    sqlx::query!(
        "INSERT INTO utility_contract_import_sources (household_id,property_id,source_service_key,utility_contract_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT (household_id,property_id,source_service_key) DO NOTHING",
        household_id, property_id, utility.service_key, contract_id,
    ).execute(&mut **tx).await?;
    sqlx::query!(
        "INSERT INTO utility_subject_services (household_id,property_id,service_id)
         VALUES ($1,$2,$3) ON CONFLICT (household_id,property_id,contract_id,service_id) DO NOTHING",
        household_id, property_id, service_id,
    ).execute(&mut **tx).await?;

    for bill in &utility.bills {
        validate_scope(&bill.owner_scope)?;
        let bill_row = sqlx::query!(
            r#"INSERT INTO utility_bills
                (household_id, property_id, service_id, provider, description, amount, currency,
                 charge_date, owner_scope, data_source, is_recurring, notes, source_key, utility_contract_id, amount_source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'actual')
             ON CONFLICT (household_id, source_key) DO UPDATE SET
                utility_contract_id = EXCLUDED.utility_contract_id, amount_source = 'actual',
                provider = EXCLUDED.provider, description = EXCLUDED.description,
                amount = EXCLUDED.amount, currency = EXCLUDED.currency,
                charge_date = EXCLUDED.charge_date, owner_scope = EXCLUDED.owner_scope,
                is_recurring = EXCLUDED.is_recurring, notes = EXCLUDED.notes, updated_at = now()
             RETURNING id, (xmax = 0) AS "inserted!""#,
            household_id, property_id, service_id, bill.provider, bill.description,
            dec2(bill.amount)?, bill.currency, bill.charge_date, bill.owner_scope,
            BULK_SOURCE, bill.is_recurring, bill.notes, bill.source_key, contract_id,
        )
        .fetch_one(&mut **tx)
        .await?;
        let bill_id = bill_row.id;
        counts.record("utility_bills", bill_row.inserted);

        if let Some(reading) = bill.reading {
            sqlx::query(
                "INSERT INTO utility_meter_readings
                    (household_id, utility_bill_id, reading, usage_amount, unit)
                 VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (household_id, utility_bill_id) DO UPDATE SET
                    reading = EXCLUDED.reading, usage_amount = EXCLUDED.usage_amount,
                    unit = EXCLUDED.unit, updated_at = now()",
            )
            .bind(household_id)
            .bind(bill_id)
            .bind(dec4(reading)?)
            .bind(bill.usage_amount.map(dec4).transpose()?)
            .bind(&utility.unit)
            .execute(&mut **tx)
            .await?;
            counts.record("utility_meter_readings", true);
        }
    }
    Ok(())
}

/// First day of the month containing `date`; contract lifetimes are whole-month.
fn month_start(date: NaiveDate) -> NaiveDate {
    date.with_day(1).unwrap_or(date)
}

/// First day of the month after `date`'s month; the exclusive end bound.
fn month_after(date: NaiveDate) -> NaiveDate {
    use chrono::Months;
    month_start(date)
        .checked_add_months(Months::new(1))
        .unwrap_or_else(|| month_start(date))
}

#[cfg(test)]
mod loan_payment_tests {
    use super::*;

    #[test]
    fn completion_status_respects_override() -> Result<(), serde_json::Error> {
        for (projected, completed, expected) in [
            (false, None, true),
            (true, None, false),
            (false, Some(false), false),
            (true, Some(false), false),
            (false, Some(true), true),
            (true, Some(true), true),
        ] {
            let payment: LoanPaymentIn = serde_json::from_value(json!({
                "source_key": "test:payment",
                "payment_date": "2026-07-12",
                "projected": projected,
                "completed": completed,
            }))?;
            assert_eq!(payment.is_completed(), expected);
        }
        Ok(())
    }

    #[test]
    fn legacy_payment_payload_defaults_to_completed() -> Result<(), serde_json::Error> {
        let payment: LoanPaymentIn = serde_json::from_value(json!({
            "source_key": "test:payment",
            "payment_date": "2026-07-12",
            "interest_balance": 12.34,
        }))?;
        assert!(payment.is_completed());
        assert_eq!(payment.total_payment, 0.0);
        assert_eq!(payment.interest_balance, Some(12.34));
        assert_eq!(payment.remaining_balance, None);
        Ok(())
    }
}
