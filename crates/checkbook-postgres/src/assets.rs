use checkbook_domain::{
    LoanSchedulePayment, initial_loan_schedule, month_start_at, reconcile_loan_schedule,
    schedule_monthly_payment,
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{planning::materialize_household_in_transaction, tenant};

#[derive(Debug, Clone)]
pub struct CreateLoanInput {
    pub name: String,
    pub liability_type: String,
    pub owner_scope: String,
    pub current_balance: Decimal,
    pub monthly_payment: Decimal,
    pub interest_rate: Decimal,
    pub original_balance: Option<Decimal>,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub notes: String,
    pub linked_property_id: Option<Uuid>,
    pub base_currency: String,
    pub household_timezone: String,
}

#[derive(Debug, Clone)]
pub struct UpdateLoanInput {
    pub name: String,
    pub current_balance: Option<Decimal>,
    pub monthly_payment: Option<Decimal>,
    pub interest_rate: Decimal,
    pub original_balance: Option<Decimal>,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub notes: String,
    pub linked_property_id: Option<Uuid>,
    pub actor_user_id: Uuid,
    pub household_timezone: String,
    pub payment_schedule: Option<Vec<LoanSchedulePayment>>,
}

#[derive(Debug, Clone)]
pub struct AssetInput {
    pub name: String,
    pub total_cost: Decimal,
    pub valuation_date: NaiveDate,
    pub status: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    pub notes: String,
    pub kind: String,
    pub category: String,
    pub account_type: Option<String>,
    pub account_registration: Option<String>,
    pub holdings: Vec<AccountHoldingInput>,
    pub depreciation_rate: Decimal,
    pub depreciation_enabled: bool,
    pub utilities_enabled: bool,
    pub projects_enabled: bool,
    pub expenses_enabled: bool,
    pub linked_category_ids: Vec<Uuid>,
    pub details: Value,
    pub base_currency: String,
    pub household_timezone: String,
}

/// One ordered position (lot) on an account-category asset. Holdings are
/// always written as a full replacement list, like project rooms.
#[derive(Debug, Clone)]
pub struct AccountHoldingInput {
    pub name: String,
    pub ticker: Option<String>,
    pub quantity: Option<Decimal>,
    pub unit_price: Option<Decimal>,
    pub value: Decimal,
    pub purchased_on: Option<NaiveDate>,
    pub sold_on: Option<NaiveDate>,
    pub sell_value: Option<Decimal>,
    pub notes: String,
}

#[derive(Debug, Clone)]
pub struct CreatedRecord {
    pub id: Uuid,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct LoanRow {
    pub id: Uuid,
    pub name: String,
    pub current_balance: Decimal,
    pub monthly_payment: Decimal,
    pub interest_rate: Decimal,
    pub original_balance: Decimal,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub notes: String,
    pub terms_payload: Value,
    pub linked_property_id: Option<Uuid>,
}

#[derive(Debug, Clone)]
pub struct AssetRow {
    pub id: Uuid,
    pub name: String,
    pub total_cost: Decimal,
    pub valuation_date: NaiveDate,
    pub status: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    pub notes: String,
    pub kind: String,
    pub category: String,
    pub account_type: Option<String>,
    pub account_registration: Option<String>,
    pub depreciation_rate: Decimal,
    pub depreciation_enabled: bool,
    pub utilities_enabled: bool,
    pub projects_enabled: bool,
    pub expenses_enabled: bool,
    pub account_id: Option<Uuid>,
    pub linked_asset_id: Option<Uuid>,
}

#[derive(Debug, Clone)]
pub struct ItemRow {
    pub room_id: Uuid,
    pub room_name: String,
    pub room_notes: String,
    pub room_sort: i32,
    pub section_id: Uuid,
    pub section_name: String,
    pub section_notes: String,
    pub section_sort: i32,
    pub item_name: String,
    pub unit_price: Option<Decimal>,
    pub quantity: Option<Decimal>,
    pub total_cost: Decimal,
    pub completed: bool,
    pub item_notes: String,
    pub item_sort: i32,
}

#[derive(Debug, Clone)]
pub struct HoldingsRow {
    pub ticker: Option<String>,
    pub id: Uuid,
    pub name: String,
    pub quantity: Option<Decimal>,
    pub unit_price: Option<Decimal>,
    pub value: Decimal,
    pub purchased_on: Option<NaiveDate>,
    pub sold_on: Option<NaiveDate>,
    pub sell_value: Option<Decimal>,
    pub notes: String,
}

#[derive(Debug, Clone)]
pub struct AssetDetails {
    pub row: AssetRow,
    pub items: Vec<ItemRow>,
    pub holdings: Vec<HoldingsRow>,
    pub linked_asset_name: Option<String>,
    pub linked_category_ids: Vec<Uuid>,
    pub linked_expense_total: Decimal,
}

#[derive(Debug, thiserror::Error)]
pub enum AssetStoreError {
    #[error("database error")]
    Database(#[from] sqlx::Error),
    #[error("not found")]
    NotFound,
    #[error("{0}")]
    Validation(String),
}

pub async fn create_loan(
    pool: &PgPool,
    household_id: Uuid,
    input: CreateLoanInput,
) -> Result<CreatedRecord, AssetStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    if let Some(property_id) = input.linked_property_id {
        ensure_property(&mut transaction, household_id, property_id).await?;
    }
    let effective_date = input.start_date.unwrap_or(
        checkbook_domain::local_date_at(&input.household_timezone, chrono::Utc::now())
            .map_err(|error| AssetStoreError::Validation(format!("invalid timezone: {error}")))?,
    );
    let account_id = sqlx::query!(
        "INSERT INTO financial_accounts
            (household_id, name, account_kind, account_type, currency,
             owner_scope, opened_on, closed_on, notes, source_key)
         VALUES ($1, $2, 'liability', $3, $4, $5, $6, $7, $8, $9)
         RETURNING id",
        household_id,
        input.name.trim(),
        &input.liability_type,
        &input.base_currency,
        &input.owner_scope,
        input.start_date,
        input.end_date,
        &input.notes,
        format!("app_manual:loan-account:{}", Uuid::now_v7())
    )
    .fetch_one(&mut *transaction)
    .await?
    .id;
    let original_balance = input.original_balance.unwrap_or(input.current_balance);
    let mut initial_schedule = match (input.start_date, input.end_date) {
        (Some(start), Some(end)) => {
            initial_loan_schedule(original_balance, input.interest_rate, start, end)
                .map_err(|error| AssetStoreError::Validation(error.to_string()))?
        }
        _ => Vec::new(),
    };
    let current_balance = if initial_schedule.is_empty() {
        input.current_balance
    } else {
        original_balance
    };
    let monthly_payment =
        schedule_monthly_payment(&initial_schedule).unwrap_or(input.monthly_payment);
    let id = sqlx::query!(
        "INSERT INTO loans
            (household_id, account_id, name, liability_type, owner_scope,
             original_balance, current_balance, interest_rate, monthly_payment,
             start_date, end_date, notes, linked_property_id, source_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id",
        household_id,
        account_id,
        input.name.trim(),
        &input.liability_type,
        &input.owner_scope,
        original_balance,
        current_balance,
        input.interest_rate,
        monthly_payment,
        input.start_date,
        input.end_date,
        &input.notes,
        input.linked_property_id,
        format!("app_manual:loan:{}", Uuid::now_v7())
    )
    .fetch_one(&mut *transaction)
    .await?
    .id;
    if !initial_schedule.is_empty() {
        crate::loan_payments::replace(
            &mut transaction,
            household_id,
            id,
            &[],
            &mut initial_schedule,
            &std::collections::HashSet::new(),
            false,
        )
        .await?;
    }
    sqlx::query!(
        "INSERT INTO account_balance_snapshots
            (household_id, account_id, balance, effective_date, data_source, source_key)
         VALUES ($1, $2, $3, $4, 'app_manual', $5)",
        household_id,
        account_id,
        current_balance,
        effective_date,
        format!("app_manual:loan-balance:{}", Uuid::now_v7())
    )
    .execute(&mut *transaction)
    .await?;
    materialize_after_write(&mut transaction, household_id, &input.household_timezone).await?;
    transaction.commit().await?;
    Ok(CreatedRecord {
        id,
        name: input.name,
    })
}

pub async fn update_loan(
    pool: &PgPool,
    household_id: Uuid,
    loan_id: Uuid,
    scopes: &[String],
    input: UpdateLoanInput,
) -> Result<LoanRow, AssetStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let existing = sqlx::query!(
        "SELECT account_id, original_balance, current_balance, schedule_opening_balance, source_key FROM loans
         WHERE household_id = $1 AND id = $2 AND owner_scope = ANY($3)
         FOR UPDATE",
        household_id,
        loan_id,
        scopes
    )
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(AssetStoreError::NotFound)?;
    if let Some(property_id) = input.linked_property_id {
        ensure_property(&mut transaction, household_id, property_id).await?;
    }
    let (stored, defaults) =
        crate::loan_payments::load(&mut transaction, household_id, loan_id).await?;
    let explicit_schedule = input.payment_schedule.is_some();
    let original_balance = input.original_balance.unwrap_or(existing.original_balance);
    // A persisted anchor also marks an explicitly cleared schedule as initialized.
    let generate =
        stored.is_empty() && existing.schedule_opening_balance.is_none() && !explicit_schedule;
    let mut schedule = input.payment_schedule.unwrap_or_else(|| stored.clone());
    if generate && let (Some(start), Some(end)) = (input.start_date, input.end_date) {
        schedule = initial_loan_schedule(original_balance, input.interest_rate, start, end)
            .map_err(|error| AssetStoreError::Validation(error.to_string()))?;
    }
    let generated = generate && !schedule.is_empty();
    let monthly_payment = schedule_monthly_payment(&schedule)
        .or_else(|| schedule_monthly_payment(&stored))
        .unwrap_or_default();
    schedule.sort_by_key(|row| row.date);
    let mut contractual_payments = std::collections::HashSet::new();
    for (index, payment) in schedule.iter_mut().enumerate() {
        payment
            .validate()
            .map_err(|error| AssetStoreError::Validation(error.to_string()))?;
        let inherited_default = payment.id.is_some_and(|id| defaults.contains(&id))
            && stored
                .iter()
                .any(|prior| prior.id == payment.id && prior.payment == payment.payment);
        // Pending installments share the next base payment. Imported forecasts can
        // contain declining payments based on assumptions absent from loan terms;
        // retaining those while recomputing interest can make an unrelated edit fail.
        if inherited_default || !payment.is_completed() {
            contractual_payments.insert(index);
            if !payment.is_completed() {
                payment.payment = None;
            }
        }
    }
    let opening_balance = if generated {
        original_balance
    } else {
        existing
            .schedule_opening_balance
            .unwrap_or(existing.current_balance)
    };
    let persisted_opening = if explicit_schedule || !schedule.is_empty() {
        Some(opening_balance)
    } else {
        existing.schedule_opening_balance
    };
    let fallback_balance = opening_balance;
    if explicit_schedule {
        for index in 0..schedule.len() {
            let payment = &schedule[index];
            let newly_completed = payment.is_completed()
                && !stored.iter().any(|prior| {
                    prior.id.is_some() && prior.id == payment.id && prior.is_completed()
                });
            if newly_completed {
                let prefix = reconcile_loan_schedule(
                    opening_balance,
                    fallback_balance,
                    input.interest_rate,
                    monthly_payment,
                    schedule[..index].to_vec(),
                )
                .map_err(|error| AssetStoreError::Validation(error.to_string()))?;
                let opening = prefix
                    .schedule
                    .last()
                    .and_then(|row| row.outstanding_loan_balance)
                    .unwrap_or(prefix.current_balance);
                checkbook_domain::complete_loan_payment(
                    opening,
                    input.interest_rate,
                    monthly_payment,
                    &mut schedule[index],
                )
                .map_err(|error| AssetStoreError::Validation(error.to_string()))?;
            }
        }
    }
    let reconciled = reconcile_loan_schedule(
        opening_balance,
        fallback_balance,
        input.interest_rate,
        monthly_payment,
        schedule,
    )
    .map_err(|error| AssetStoreError::Validation(error.to_string()))?;
    let mut schedule = reconciled.schedule;
    crate::loan_payments::replace(
        &mut transaction,
        household_id,
        loan_id,
        &stored,
        &mut schedule,
        &contractual_payments,
        explicit_schedule,
    )
    .await?;
    let row = sqlx::query_as!(
        LoanRow,
        r#"UPDATE loans
         SET name = $3, current_balance = $4, monthly_payment = $5,
             interest_rate = $6, original_balance = $7, start_date = $8,
             end_date = $9, notes = $10, linked_property_id = $11, updated_at = now(),
             terms_payload = terms_payload - 'payment_schedule', schedule_opening_balance = $12
         WHERE household_id = $1 AND id = $2
         RETURNING id, name, current_balance, monthly_payment, interest_rate,
             original_balance, start_date, end_date, notes, linked_property_id,
             app.loan_terms_with_schedule(household_id, id, terms_payload) AS "terms_payload!: Value""#,
        household_id,
        loan_id,
        input.name.trim(),
        reconciled.current_balance,
        schedule_monthly_payment(&schedule).unwrap_or_default(),
        input.interest_rate,
        original_balance,
        input.start_date,
        input.end_date,
        &input.notes,
        input.linked_property_id,
        persisted_opening
    )
    .fetch_one(&mut *transaction)
    .await?;
    sqlx::query!(
        "UPDATE financial_accounts
         SET name = $3, opened_on = $4, closed_on = $5, notes = $6, updated_at = now()
         WHERE household_id = $1 AND id = $2",
        household_id,
        existing.account_id,
        &row.name,
        row.start_date,
        row.end_date,
        &row.notes
    )
    .execute(&mut *transaction)
    .await?;
    // Retain manual backing snapshots for account history compatibility. Net worth
    // now reads every loan's canonical schedule directly, including imported loans.
    if existing
        .source_key
        .as_deref()
        .is_some_and(|key| key.starts_with("app_manual:loan:"))
    {
        let effective_date =
            checkbook_domain::local_date_at(&input.household_timezone, chrono::Utc::now())
                .map_err(|error| {
                    AssetStoreError::Validation(format!("invalid timezone: {error}"))
                })?;
        sqlx::query!(
            "INSERT INTO account_balance_snapshots
            (household_id, account_id, balance, effective_date, data_source, source_key)
         VALUES ($1, $2, $3, $4, 'app_manual', $5)",
            household_id,
            existing.account_id,
            row.current_balance,
            effective_date,
            format!("app_manual:loan-balance:{}", Uuid::now_v7())
        )
        .execute(&mut *transaction)
        .await?;
    }
    sqlx::query!(
        "INSERT INTO audit_events
            (household_id, actor_user_id, event_type, resource_type, resource_id)
         VALUES ($1, $2, 'loan.updated', 'loan', $3)",
        household_id,
        input.actor_user_id,
        loan_id
    )
    .execute(&mut *transaction)
    .await?;
    materialize_after_write(&mut transaction, household_id, &input.household_timezone).await?;
    transaction.commit().await?;
    Ok(row)
}

pub async fn list_loans(
    pool: &PgPool,
    household_id: Uuid,
    scopes: &[String],
) -> Result<Vec<LoanRow>, AssetStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let rows = sqlx::query_as!(
        LoanRow,
        r#"SELECT id, name, current_balance, monthly_payment, interest_rate,
                original_balance, start_date, end_date, notes, linked_property_id,
                app.loan_terms_with_schedule(household_id, id, terms_payload) AS "terms_payload!: Value"
         FROM loans
         WHERE household_id = $1 AND owner_scope = ANY($2)
         ORDER BY name"#,
        household_id,
        scopes
    )
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(rows)
}

pub async fn create_asset(
    pool: &PgPool,
    household_id: Uuid,
    input: AssetInput,
) -> Result<CreatedRecord, AssetStoreError> {
    if input.kind != "asset" && input.category == "account" {
        return Err(AssetStoreError::Validation(
            "Only assets can be accounts.".to_owned(),
        ));
    }
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let id = if input.kind == "asset" {
        let id = sqlx::query!(
            "INSERT INTO properties
                (household_id, name, valuation, valuation_date, status,
                 started_on, ended_on, notes, category, account_type, account_registration,
                 depreciation_rate, depreciation_enabled,
                 utilities_enabled, projects_enabled, expenses_enabled, data_source, source_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                     $12, $13, $14, $15, $16, 'app_manual', $17)
             RETURNING id",
            household_id,
            input.name.trim(),
            input.total_cost,
            input.valuation_date,
            &input.status,
            input.started_on,
            input.ended_on,
            &input.notes,
            &input.category,
            input.account_type.as_deref(),
            input.account_registration.as_deref(),
            input.depreciation_rate,
            input.depreciation_enabled,
            input.utilities_enabled,
            input.projects_enabled,
            input.expenses_enabled,
            format!("app_manual:property:{}", Uuid::now_v7())
        )
        .fetch_one(&mut *transaction)
        .await?
        .id;
        let account_type = linked_account_type(&input.category, input.account_type.as_deref());
        let account_id = create_linked_account(
            &mut transaction,
            household_id,
            input.name.trim(),
            account_type,
            &input.base_currency,
            input.total_cost,
            input.valuation_date,
        )
        .await?;
        sqlx::query!(
            "UPDATE properties SET account_id = $3 WHERE household_id = $1 AND id = $2",
            household_id,
            id,
            account_id
        )
        .execute(&mut *transaction)
        .await?;
        if input.category == "account" {
            replace_holdings(&mut transaction, household_id, id, &input.holdings).await?;
        }
        replace_rooms(
            &mut transaction,
            household_id,
            Some(id),
            None,
            &input.details,
            &input.status,
        )
        .await?;
        replace_property_categories(
            &mut transaction,
            household_id,
            id,
            &input.linked_category_ids,
        )
        .await?;
        id
    } else {
        let linked = linked_asset_id(&input.details)?;
        if let Some(property_id) = linked {
            ensure_property(&mut transaction, household_id, property_id).await?;
        }
        let id = sqlx::query!(
            "INSERT INTO projects
                (household_id, linked_property_id, name, budget, valuation_date,
                 stored_status, started_on, ended_on, notes, data_source, source_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'app_manual', $10)
             RETURNING id",
            household_id,
            linked,
            input.name.trim(),
            input.total_cost,
            input.valuation_date,
            &input.status,
            input.started_on,
            input.ended_on,
            &input.notes,
            format!("app_manual:project:{}", Uuid::now_v7())
        )
        .fetch_one(&mut *transaction)
        .await?
        .id;
        replace_rooms(
            &mut transaction,
            household_id,
            None,
            Some(id),
            &input.details,
            &input.status,
        )
        .await?;
        id
    };
    materialize_after_write(&mut transaction, household_id, &input.household_timezone).await?;
    transaction.commit().await?;
    Ok(CreatedRecord {
        id,
        name: input.name,
    })
}

pub async fn list_assets(
    pool: &PgPool,
    household_id: Uuid,
) -> Result<Vec<AssetDetails>, AssetStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let rows = load_assets_in_transaction(&mut transaction, household_id).await?;
    let mut responses = Vec::with_capacity(rows.len());
    for row in rows {
        responses
            .push(load_asset_details_in_transaction(&mut transaction, household_id, row).await?);
    }
    transaction.commit().await?;
    Ok(responses)
}

pub async fn update_asset(
    pool: &PgPool,
    household_id: Uuid,
    asset_id: Uuid,
    input: AssetInput,
) -> Result<AssetDetails, AssetStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let existing = load_asset_in_transaction(&mut transaction, household_id, asset_id)
        .await?
        .ok_or(AssetStoreError::NotFound)?;
    if existing.kind != "asset" && input.category == "account" {
        return Err(AssetStoreError::Validation(
            "Only assets can be accounts.".to_owned(),
        ));
    }
    let updated = if existing.kind == "asset" {
        sqlx::query!(
            "UPDATE properties
             SET name = $3, valuation = $4, valuation_date = $5, status = $6,
                 started_on = $7, ended_on = $8, notes = $9, category = $10,
                 account_type = $11, account_registration = $12,
                 depreciation_rate = $13, depreciation_enabled = $14, utilities_enabled = $15,
                 projects_enabled = $16, expenses_enabled = $17, updated_at = now()
             WHERE household_id = $1 AND id = $2",
            household_id,
            asset_id,
            input.name.trim(),
            input.total_cost,
            input.valuation_date,
            &input.status,
            input.started_on,
            input.ended_on,
            &input.notes,
            &input.category,
            input.account_type.as_deref(),
            input.account_registration.as_deref(),
            input.depreciation_rate,
            input.depreciation_enabled,
            input.utilities_enabled,
            input.projects_enabled,
            input.expenses_enabled
        )
        .execute(&mut *transaction)
        .await?;
        // An account's linked financial_accounts row carries the subtype
        // ('savings'/'stocks'/'options') so net-worth classifiers group it,
        // never the literal category 'account'.
        let linked_type = linked_account_type(&input.category, input.account_type.as_deref());
        if let Some(account_id) = existing.account_id {
            sqlx::query!(
                "UPDATE financial_accounts SET name = $3, account_type = $4
                 WHERE household_id = $1 AND id = $2",
                household_id,
                account_id,
                input.name.trim(),
                linked_type
            )
            .execute(&mut *transaction)
            .await?;
            if existing.total_cost != input.total_cost
                || existing.valuation_date != input.valuation_date
            {
                sqlx::query!(
                    "INSERT INTO account_balance_snapshots
                        (household_id, account_id, balance, effective_date, data_source, source_key)
                     VALUES ($1, $2, $3, $4, 'app_manual', $5)",
                    household_id,
                    account_id,
                    input.total_cost,
                    input.valuation_date,
                    format!("app_manual:physical-asset-balance:{}", Uuid::now_v7())
                )
                .execute(&mut *transaction)
                .await?;
            }
        } else {
            let account_id = create_linked_account(
                &mut transaction,
                household_id,
                input.name.trim(),
                linked_type,
                &input.base_currency,
                input.total_cost,
                input.valuation_date,
            )
            .await?;
            sqlx::query!(
                "UPDATE properties SET account_id = $3 WHERE household_id = $1 AND id = $2",
                household_id,
                asset_id,
                account_id
            )
            .execute(&mut *transaction)
            .await?;
        }
        // Always rewritten so converting an account to another category
        // cannot leave orphaned holdings behind (the FK alone allows them).
        replace_holdings(
            &mut transaction,
            household_id,
            asset_id,
            if input.category == "account" {
                &input.holdings
            } else {
                &[]
            },
        )
        .await?;
        replace_rooms(
            &mut transaction,
            household_id,
            Some(asset_id),
            None,
            &input.details,
            &input.status,
        )
        .await?;
        replace_property_categories(
            &mut transaction,
            household_id,
            asset_id,
            &input.linked_category_ids,
        )
        .await?;
        load_asset_in_transaction(&mut transaction, household_id, asset_id)
            .await?
            .ok_or(AssetStoreError::NotFound)?
    } else {
        let linked = linked_asset_id(&input.details)?;
        if let Some(property_id) = linked {
            ensure_property(&mut transaction, household_id, property_id).await?;
        }
        sqlx::query!(
            "UPDATE projects
             SET linked_property_id = $3, name = $4, budget = $5,
                 valuation_date = $6, stored_status = $7, started_on = $8,
                 ended_on = $9, notes = $10, updated_at = now()
             WHERE household_id = $1 AND id = $2",
            household_id,
            asset_id,
            linked,
            input.name.trim(),
            input.total_cost,
            input.valuation_date,
            &input.status,
            input.started_on,
            input.ended_on,
            &input.notes
        )
        .execute(&mut *transaction)
        .await?;
        replace_rooms(
            &mut transaction,
            household_id,
            None,
            Some(asset_id),
            &input.details,
            &input.status,
        )
        .await?;
        load_asset_in_transaction(&mut transaction, household_id, asset_id)
            .await?
            .ok_or(AssetStoreError::NotFound)?
    };
    let response =
        load_asset_details_in_transaction(&mut transaction, household_id, updated).await?;
    materialize_after_write(&mut transaction, household_id, &input.household_timezone).await?;
    transaction.commit().await?;
    Ok(response)
}

pub async fn delete_asset(
    pool: &PgPool,
    household_id: Uuid,
    asset_id: Uuid,
    household_timezone: &str,
) -> Result<(), AssetStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let existing = load_asset_in_transaction(&mut transaction, household_id, asset_id)
        .await?
        .ok_or(AssetStoreError::NotFound)?;
    if existing.kind == "asset" {
        let linked = sqlx::query!(
            r#"SELECT count(*) AS "linked!"
             FROM projects
             WHERE household_id = $1 AND linked_property_id = $2"#,
            household_id,
            asset_id
        )
        .fetch_one(&mut *transaction)
        .await?
        .linked;
        if linked > 0 {
            let noun = if linked == 1 { "project" } else { "projects" };
            return Err(AssetStoreError::Validation(format!(
                "Unlink or delete the {linked} related {noun} first."
            )));
        }
        sqlx::query!(
            "DELETE FROM properties WHERE household_id = $1 AND id = $2",
            household_id,
            asset_id
        )
        .execute(&mut *transaction)
        .await?;
    } else {
        sqlx::query!(
            "DELETE FROM projects WHERE household_id = $1 AND id = $2",
            household_id,
            asset_id
        )
        .execute(&mut *transaction)
        .await?;
    }
    materialize_after_write(&mut transaction, household_id, household_timezone).await?;
    transaction.commit().await?;
    Ok(())
}

/// Creates (or reuses, if one already exists) a top-level expense category
/// named after the property/vehicle and links it, so the user can start
/// tagging expenses to this specific asset without first hand-rolling a
/// generic category.
pub async fn create_own_category(
    pool: &PgPool,
    household_id: Uuid,
    asset_id: Uuid,
) -> Result<AssetDetails, AssetStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let existing = load_asset_in_transaction(&mut transaction, household_id, asset_id)
        .await?
        .ok_or(AssetStoreError::NotFound)?;
    if existing.kind != "asset" {
        return Err(AssetStoreError::Validation(
            "Only properties and vehicles can have a dedicated expense category.".to_owned(),
        ));
    }
    let category_id =
        ensure_own_expense_category(&mut transaction, household_id, &existing.name).await?;
    sqlx::query!(
        "INSERT INTO property_categories (household_id, property_id, category_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (household_id, property_id, category_id) DO NOTHING",
        household_id,
        asset_id,
        category_id
    )
    .execute(&mut *transaction)
    .await?;
    let updated = load_asset_in_transaction(&mut transaction, household_id, asset_id)
        .await?
        .ok_or(AssetStoreError::NotFound)?;
    let response =
        load_asset_details_in_transaction(&mut transaction, household_id, updated).await?;
    transaction.commit().await?;
    Ok(response)
}

async fn ensure_own_expense_category(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    name: &str,
) -> Result<Uuid, AssetStoreError> {
    let name = name.trim();
    let normalized = name.to_lowercase();
    if normalized.is_empty() {
        return Err(AssetStoreError::Validation(
            "Property name is required to create its category.".to_owned(),
        ));
    }
    if let Some(row) = sqlx::query!(
        "SELECT id FROM categories
         WHERE household_id = $1 AND kind = 'expense' AND parent_id IS NULL
           AND normalized_name = $2",
        household_id,
        normalized
    )
    .fetch_optional(&mut **transaction)
    .await?
    {
        return Ok(row.id);
    }
    Ok(sqlx::query!(
        "INSERT INTO categories (household_id, kind, name, normalized_name)
         VALUES ($1, 'expense', $2, $3)
         RETURNING id",
        household_id,
        name,
        normalized
    )
    .fetch_one(&mut **transaction)
    .await?
    .id)
}

async fn load_assets_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
) -> Result<Vec<AssetRow>, sqlx::Error> {
    sqlx::query_as!(
        AssetRow,
        r#"SELECT id AS "id!", name AS "name!", valuation AS "total_cost!: Decimal",
                valuation_date AS "valuation_date!", status AS "status!",
                started_on, ended_on, notes AS "notes!", 'asset' AS "kind!",
                category AS "category!", account_type, account_registration,
                depreciation_rate AS "depreciation_rate!: Decimal",
                depreciation_enabled AS "depreciation_enabled!",
                utilities_enabled AS "utilities_enabled!", projects_enabled AS "projects_enabled!",
                expenses_enabled AS "expenses_enabled!",
                account_id, NULL::uuid AS linked_asset_id
         FROM properties WHERE household_id = $1
         UNION ALL
         SELECT id AS "id!", name AS "name!", budget AS "total_cost!: Decimal",
                valuation_date AS "valuation_date!", stored_status AS "status!",
                started_on, ended_on, notes AS "notes!",
                'project' AS "kind!", 'other' AS "category!",
                NULL::text AS account_type, NULL::text AS account_registration,
                0::numeric AS "depreciation_rate!: Decimal",
                true AS "depreciation_enabled!",
                true AS "utilities_enabled!", true AS "projects_enabled!", true AS "expenses_enabled!",
                NULL::uuid AS account_id,
                linked_property_id AS linked_asset_id
         FROM projects WHERE household_id = $1
         ORDER BY 9, 2"#,
        household_id
    )
    .fetch_all(&mut **transaction)
    .await
}

async fn load_asset_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    asset_id: Uuid,
) -> Result<Option<AssetRow>, sqlx::Error> {
    sqlx::query_as!(
        AssetRow,
        r#"SELECT id AS "id!", name AS "name!", valuation AS "total_cost!: Decimal",
                valuation_date AS "valuation_date!", status AS "status!",
                started_on, ended_on, notes AS "notes!", 'asset' AS "kind!",
                category AS "category!", account_type, account_registration,
                depreciation_rate AS "depreciation_rate!: Decimal",
                depreciation_enabled AS "depreciation_enabled!",
                utilities_enabled AS "utilities_enabled!", projects_enabled AS "projects_enabled!",
                expenses_enabled AS "expenses_enabled!",
                account_id, NULL::uuid AS linked_asset_id
         FROM properties WHERE household_id = $1 AND id = $2
         UNION ALL
         SELECT id AS "id!", name AS "name!", budget AS "total_cost!: Decimal",
                valuation_date AS "valuation_date!", stored_status AS "status!",
                started_on, ended_on, notes AS "notes!",
                'project' AS "kind!", 'other' AS "category!",
                NULL::text AS account_type, NULL::text AS account_registration,
                0::numeric AS "depreciation_rate!: Decimal",
                true AS "depreciation_enabled!",
                true AS "utilities_enabled!", true AS "projects_enabled!", true AS "expenses_enabled!",
                NULL::uuid AS account_id,
                linked_property_id AS linked_asset_id
         FROM projects WHERE household_id = $1 AND id = $2"#,
        household_id,
        asset_id
    )
    .fetch_optional(&mut **transaction)
    .await
}

async fn load_asset_details_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    row: AssetRow,
) -> Result<AssetDetails, sqlx::Error> {
    let items = sqlx::query_as!(
        ItemRow,
        r#"SELECT r.id AS "room_id!", r.name AS "room_name!", r.notes AS "room_notes!",
                r.sort_order AS "room_sort!", s.id AS "section_id!",
                s.name AS "section_name!", s.notes AS "section_notes!",
                s.sort_order AS "section_sort!", i.name AS "item_name!",
                i.unit_price, i.quantity, i.total_cost AS "total_cost!: Decimal",
                i.completed AS "completed!", i.notes AS "item_notes!",
                i.sort_order AS "item_sort!"
         FROM project_rooms r
         JOIN project_sections s
           ON s.household_id = r.household_id AND s.room_id = r.id
         JOIN project_items i
           ON i.household_id = s.household_id AND i.section_id = s.id
         WHERE r.household_id = $1
           AND (($2 = 'asset' AND r.property_id = $3)
             OR ($2 = 'project' AND r.project_id = $3))
         ORDER BY r.sort_order, r.created_at, s.sort_order, s.created_at,
                  i.sort_order, i.created_at"#,
        household_id,
        &row.kind,
        row.id
    )
    .fetch_all(&mut **transaction)
    .await?;
    let holdings = if row.kind == "asset" {
        sqlx::query_as!(
            HoldingsRow,
            r#"SELECT id AS "id!", name AS "name!", ticker, quantity, unit_price,
                    value AS "value!: Decimal", purchased_on, sold_on, sell_value,
                    notes AS "notes!"
             FROM account_holdings
             WHERE household_id = $1 AND property_id = $2
             ORDER BY sort_order, created_at, id"#,
            household_id,
            row.id
        )
        .fetch_all(&mut **transaction)
        .await?
    } else {
        Vec::new()
    };
    let linked_asset_name = if let Some(linked) = row.linked_asset_id {
        sqlx::query!(
            "SELECT name FROM properties WHERE household_id = $1 AND id = $2",
            household_id,
            linked
        )
        .fetch_optional(&mut **transaction)
        .await?
        .map(|row| row.name)
    } else {
        None
    };
    let (linked_category_ids, linked_expense_total) = if row.kind == "asset" {
        let category_ids = sqlx::query_scalar!(
            r#"SELECT category_id AS "category_id!"
             FROM property_categories WHERE household_id = $1 AND property_id = $2
             UNION
             SELECT c.id AS "category_id!"
             FROM categories c
             JOIN expense_groups g
               ON g.household_id = c.household_id AND g.id = c.expense_group_id
             WHERE c.household_id = $1 AND g.linked_property_id = $2"#,
            household_id,
            row.id
        )
        .fetch_all(&mut **transaction)
        .await?;
        let total = sqlx::query_scalar!(
            r#"SELECT COALESCE(sum(amount), 0)::numeric AS "total!: Decimal"
             FROM ledger_entries
             WHERE household_id = $1 AND direction = 'expense'
               AND (category_id = ANY($2) OR subcategory_id = ANY($2))"#,
            household_id,
            &category_ids
        )
        .fetch_one(&mut **transaction)
        .await?;
        (category_ids, total)
    } else {
        (Vec::new(), Decimal::ZERO)
    };
    Ok(AssetDetails {
        row,
        items,
        holdings,
        linked_asset_name,
        linked_category_ids,
        linked_expense_total,
    })
}

/// Wholesale-replaces which expense categories a property/vehicle is
/// linked to, mirroring `replace_rooms`'s delete-then-reinsert approach.
async fn replace_property_categories(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    property_id: Uuid,
    category_ids: &[Uuid],
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "DELETE FROM property_categories WHERE household_id = $1 AND property_id = $2",
        household_id,
        property_id
    )
    .execute(&mut **transaction)
    .await?;
    for category_id in category_ids {
        sqlx::query!(
            "INSERT INTO property_categories (household_id, property_id, category_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (household_id, property_id, category_id) DO NOTHING",
            household_id,
            property_id,
            category_id
        )
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

/// Wholesale-replaces the ordered holdings of an account-category property,
/// mirroring `replace_rooms`'s delete-then-reinsert approach with
/// `sort_order = index`.
async fn replace_holdings(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    property_id: Uuid,
    holdings: &[AccountHoldingInput],
) -> Result<(), AssetStoreError> {
    sqlx::query!(
        "DELETE FROM account_holdings WHERE household_id = $1 AND property_id = $2",
        household_id,
        property_id
    )
    .execute(&mut **transaction)
    .await?;
    for (index, holding) in holdings.iter().enumerate() {
        let sort_order = i32::try_from(index)
            .map_err(|_| AssetStoreError::Validation("Too many holdings.".to_owned()))?;
        sqlx::query!(
            "INSERT INTO account_holdings
                (household_id, property_id, name, quantity, unit_price, value,
                 purchased_on, sold_on, sell_value, notes, sort_order, ticker)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
            household_id,
            property_id,
            holding.name.trim(),
            holding.quantity,
            holding.unit_price,
            holding.value,
            holding.purchased_on,
            holding.sold_on,
            holding.sell_value,
            &holding.notes,
            sort_order,
            checkbook_domain::holding_prices::normalize_ticker(holding.ticker.as_deref())
                .map_err(|error| AssetStoreError::Validation(error.to_owned()))?
        )
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

async fn replace_rooms(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    property_id: Option<Uuid>,
    project_id: Option<Uuid>,
    details: &Value,
    stored_status: &str,
) -> Result<(), AssetStoreError> {
    sqlx::query!(
        "DELETE FROM project_rooms
         WHERE household_id = $1
           AND (property_id IS NOT DISTINCT FROM $2)
           AND (project_id IS NOT DISTINCT FROM $3)",
        household_id,
        property_id,
        project_id
    )
    .execute(&mut **transaction)
    .await?;
    let Some(rooms) = details.get("rooms").and_then(Value::as_array) else {
        return Ok(());
    };
    for (room_index, room) in rooms.iter().enumerate() {
        let room_sort = i32::try_from(room_index)
            .map_err(|_| AssetStoreError::Validation("Too many rooms.".to_owned()))?;
        let room_id = sqlx::query!(
            "INSERT INTO project_rooms
                (household_id, project_id, property_id, name, notes, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id",
            household_id,
            project_id,
            property_id,
            text(room, "name", "General"),
            text(room, "notes", ""),
            room_sort
        )
        .fetch_one(&mut **transaction)
        .await?
        .id;
        let sections = room
            .get("sections")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for (section_index, section) in sections.iter().enumerate() {
            let section_sort = i32::try_from(section_index)
                .map_err(|_| AssetStoreError::Validation("Too many sections.".to_owned()))?;
            let section_id = sqlx::query!(
                "INSERT INTO project_sections
                    (household_id, room_id, name, notes, sort_order)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id",
                household_id,
                room_id,
                text(section, "name", "General"),
                text(section, "notes", ""),
                section_sort
            )
            .fetch_one(&mut **transaction)
            .await?
            .id;
            let items = section
                .get("items")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            for (item_index, item) in items.iter().enumerate() {
                let unit_price = decimal(item.get("unit_price"));
                let quantity = decimal(item.get("quantity"));
                let total_cost = match (unit_price, quantity) {
                    (Some(price), Some(count)) => (price * count).round_dp(2),
                    _ => decimal(item.get("total_cost")).unwrap_or(Decimal::ZERO),
                };
                let completed = item
                    .get("completed")
                    .and_then(Value::as_bool)
                    .unwrap_or(stored_status == "completed");
                let item_sort = i32::try_from(item_index)
                    .map_err(|_| AssetStoreError::Validation("Too many items.".to_owned()))?;
                sqlx::query!(
                    "INSERT INTO project_items
                        (household_id, section_id, name, unit_price, quantity,
                         total_cost, completed, notes, sort_order)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                    household_id,
                    section_id,
                    text(item, "name", "Item"),
                    unit_price,
                    quantity,
                    total_cost,
                    completed,
                    text(item, "notes", ""),
                    item_sort
                )
                .execute(&mut **transaction)
                .await?;
            }
        }
    }
    Ok(())
}

/// The `financial_accounts.account_type` for a property's linked account:
/// accounts carry their subtype so net-worth classifiers route them by
/// account type; every other category is its own account type, as before.
fn linked_account_type<'a>(category: &'a str, account_type: Option<&'a str>) -> &'a str {
    if category == "account" {
        account_type.unwrap_or(category)
    } else {
        category
    }
}

/// Creates the `financial_accounts` asset row (+ initial balance snapshot)
/// that net worth actually reads its non-liquid-assets figures from, and
/// returns its id so the caller can store it on the owning `properties` row.
/// Every property/vehicle created through the app gets one of these so its
/// valuation is tracked with history instead of duplicated as a bare column.
/// `pub(crate)` so the bulk importer can reuse it for properties that don't
/// carry an explicit `account_source_key` linking them to an existing account.
pub(crate) async fn create_linked_account(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    name: &str,
    account_type: &str,
    currency: &str,
    valuation: Decimal,
    valuation_date: NaiveDate,
) -> Result<Uuid, AssetStoreError> {
    let account_id = sqlx::query!(
        "INSERT INTO financial_accounts
            (household_id, name, account_kind, account_type, currency,
             owner_scope, notes, source_key)
         VALUES ($1, $2, 'asset', $3, $4, 'joint', '', $5)
         RETURNING id",
        household_id,
        name,
        account_type,
        currency,
        format!("app_manual:physical-asset-account:{}", Uuid::now_v7())
    )
    .fetch_one(&mut **transaction)
    .await?
    .id;
    sqlx::query!(
        "INSERT INTO account_balance_snapshots
            (household_id, account_id, balance, effective_date, data_source, source_key)
         VALUES ($1, $2, $3, $4, 'app_manual', $5)",
        household_id,
        account_id,
        valuation,
        valuation_date,
        format!("app_manual:physical-asset-balance:{}", Uuid::now_v7())
    )
    .execute(&mut **transaction)
    .await?;
    Ok(account_id)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ValuationRow {
    pub id: Uuid,
    pub value: Decimal,
    pub effective_date: NaiveDate,
}

// TECH DEBT: `account_balance_snapshots` now hosts at least four distinct
// "kinds" of row (ordinary account balances, `app_depreciation:` automatic
// monthly snapshots, `app_manual:physical-asset-balance:` initial property
// balances, and this valuation-history prefix), distinguished only by
// `source_key LIKE '<prefix>%'` string matching — there's no DB-enforced
// discriminator, so a typo'd prefix silently matches zero rows instead of
// failing loudly, and every new query has to know and correctly restate the
// right prefix (see dashboard.rs's net-worth queries, which must exclude
// this prefix to honor the "purely informational" contract below). If a
// fifth kind is ever needed, this should become a real `snapshot_kind`
// check-constrained column (or property valuation history should move to
// its own table with a proper FK to `properties`) rather than a fifth prefix.
pub(crate) const VALUATION_HISTORY_PREFIX: &str = "app_manual:property-valuation-history:";

/// Lists user-entered supplementary value/date history points for a
/// property, oldest first. Distinct from the mandatory Value/As-of anchor
/// stored directly on `properties` (that stays the compounding anchor) and
/// from the automatic monthly depreciation snapshots (`app_depreciation:`
/// source_key prefix) — these are purely informational extra data points.
pub async fn list_property_valuations(
    pool: &PgPool,
    household_id: Uuid,
    property_id: Uuid,
) -> Result<Vec<ValuationRow>, AssetStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let account_id = sqlx::query_scalar!(
        "SELECT account_id FROM properties WHERE household_id = $1 AND id = $2",
        household_id,
        property_id
    )
    .fetch_optional(&mut *transaction)
    .await?
    .flatten();
    let Some(account_id) = account_id else {
        return Ok(Vec::new());
    };
    let rows = sqlx::query_as!(
        ValuationRow,
        r#"SELECT id AS "id!", balance AS "value!: Decimal", effective_date AS "effective_date!"
         FROM account_balance_snapshots
         WHERE household_id = $1 AND account_id = $2 AND source_key LIKE $3
         ORDER BY effective_date, created_at"#,
        household_id,
        account_id,
        format!("{VALUATION_HISTORY_PREFIX}%")
    )
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(rows)
}

pub async fn create_property_valuation(
    pool: &PgPool,
    household_id: Uuid,
    property_id: Uuid,
    value: Decimal,
    effective_date: NaiveDate,
    base_currency: &str,
) -> Result<ValuationRow, AssetStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let property = sqlx::query!(
        "SELECT name, category, account_type, account_id
         FROM properties WHERE household_id = $1 AND id = $2",
        household_id,
        property_id
    )
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(AssetStoreError::NotFound)?;
    let account_id = if let Some(account_id) = property.account_id {
        account_id
    } else {
        // No linked account yet (e.g. some bulk-imported properties) — create
        // one first so this history entry has somewhere to live.
        let account_id = create_linked_account(
            &mut transaction,
            household_id,
            &property.name,
            linked_account_type(&property.category, property.account_type.as_deref()),
            base_currency,
            value,
            effective_date,
        )
        .await?;
        sqlx::query!(
            "UPDATE properties SET account_id = $3 WHERE household_id = $1 AND id = $2",
            household_id,
            property_id,
            account_id
        )
        .execute(&mut *transaction)
        .await?;
        account_id
    };
    let id = sqlx::query_scalar!(
        "INSERT INTO account_balance_snapshots
            (household_id, account_id, balance, effective_date, data_source, source_key)
         VALUES ($1, $2, $3, $4, 'app_manual', $5)
         RETURNING id",
        household_id,
        account_id,
        value,
        effective_date,
        format!("{VALUATION_HISTORY_PREFIX}{}", Uuid::now_v7())
    )
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(ValuationRow {
        id,
        value,
        effective_date,
    })
}

pub async fn delete_property_valuation(
    pool: &PgPool,
    household_id: Uuid,
    property_id: Uuid,
    valuation_id: Uuid,
) -> Result<(), AssetStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let account_id = sqlx::query_scalar!(
        "SELECT account_id FROM properties WHERE household_id = $1 AND id = $2",
        household_id,
        property_id
    )
    .fetch_optional(&mut *transaction)
    .await?
    .flatten();
    let Some(account_id) = account_id else {
        return Err(AssetStoreError::NotFound);
    };
    let deleted = sqlx::query!(
        "DELETE FROM account_balance_snapshots
         WHERE household_id = $1 AND account_id = $2 AND id = $3 AND source_key LIKE $4",
        household_id,
        account_id,
        valuation_id,
        format!("{VALUATION_HISTORY_PREFIX}%")
    )
    .execute(&mut *transaction)
    .await?;
    if deleted.rows_affected() == 0 {
        return Err(AssetStoreError::NotFound);
    }
    transaction.commit().await?;
    Ok(())
}

/// Recomputes each depreciating/appreciating property's current value from
/// its anchor (`valuation`/`valuation_date`) and writes (or updates) one
/// `account_balance_snapshots` row for `current_month`, so the net-worth
/// trend shows a smooth curve without anyone opening the property. Keyed by
/// a deterministic source_key per (account, month) so re-running the same
/// month is an upsert, not a duplicate — snapshots from prior months, and
/// any manual edits, are left untouched.
pub(crate) async fn refresh_property_depreciation_snapshots(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    current_month: NaiveDate,
) -> Result<u64, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT account_id AS "account_id!", valuation, valuation_date, depreciation_rate
         FROM properties
         WHERE household_id = $1 AND account_id IS NOT NULL
           AND depreciation_rate <> 0 AND depreciation_enabled"#,
        household_id
    )
    .fetch_all(&mut **transaction)
    .await?;
    let mut written = 0_u64;
    for row in rows {
        let months = checkbook_domain::months_between(row.valuation_date, current_month);
        let Ok(current_value) =
            checkbook_domain::compounded_value(row.valuation, row.depreciation_rate, months)
        else {
            continue;
        };
        sqlx::query!(
            "INSERT INTO account_balance_snapshots
                (household_id, account_id, balance, effective_date, data_source, source_key)
             VALUES ($1, $2, $3, $4, 'app_manual', $5)
             ON CONFLICT (household_id, account_id, effective_date, source_key)
             DO UPDATE SET balance = EXCLUDED.balance, updated_at = now()",
            household_id,
            row.account_id,
            current_value,
            current_month,
            format!("app_depreciation:{}:{}", row.account_id, current_month)
        )
        .execute(&mut **transaction)
        .await?;
        written += 1;
    }
    Ok(written)
}

async fn ensure_property(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    property_id: Uuid,
) -> Result<(), AssetStoreError> {
    let exists = sqlx::query!(
        r#"SELECT EXISTS(
            SELECT 1 FROM properties WHERE household_id = $1 AND id = $2
         ) AS "exists!""#,
        household_id,
        property_id
    )
    .fetch_one(&mut **transaction)
    .await?
    .exists;
    if exists {
        Ok(())
    } else {
        Err(AssetStoreError::Validation(
            "Linked asset was not found.".to_owned(),
        ))
    }
}

async fn materialize_after_write(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    timezone: &str,
) -> Result<(), AssetStoreError> {
    let current_month = month_start_at(timezone, chrono::Utc::now())
        .map_err(|error| AssetStoreError::Validation(format!("invalid timezone: {error}")))?;
    materialize_household_in_transaction(transaction, household_id, current_month)
        .await
        .map_err(|error| {
            AssetStoreError::Validation(format!(
                "planning materialization after asset write failed: {error}"
            ))
        })
        .map(|_| ())
}

fn linked_asset_id(details: &Value) -> Result<Option<Uuid>, AssetStoreError> {
    details
        .get("linked_asset_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| {
            Uuid::parse_str(value)
                .map_err(|_| AssetStoreError::Validation("Linked asset id is invalid.".to_owned()))
        })
        .transpose()
}

fn decimal(value: Option<&Value>) -> Option<Decimal> {
    match value? {
        Value::Number(number) => Decimal::from_str_exact(&number.to_string()).ok(),
        Value::String(value) => Decimal::from_str_exact(
            &value
                .replace(char::is_whitespace, "")
                .replace(',', ".")
                .chars()
                .filter(|character| character.is_ascii_digit() || matches!(character, '-' | '.'))
                .collect::<String>(),
        )
        .ok(),
        _ => None,
    }
}

fn text<'a>(value: &'a Value, key: &str, default: &'a str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or(default)
}
