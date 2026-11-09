use checkbook_domain::month_start_at;
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{planning::materialize_household_in_transaction, tenant};

#[derive(Debug, Clone)]
pub struct ManualLedgerEntryInput {
    pub direction: LedgerDirection,
    pub amount: Decimal,
    pub currency: String,
    pub entry_date: Option<NaiveDate>,
    pub description: String,
    pub notes: String,
    pub owner_scope: String,
    pub category_name: String,
    pub subcategory_name: Option<String>,
    pub income_source_id: Option<Uuid>,
    pub allowed_scopes: Vec<String>,
    pub household_timezone: String,
}

#[derive(Debug, Clone)]
pub struct IncomeSourceInput {
    pub name: String,
    pub source_type: String,
    pub owner_scope: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    pub notes: String,
    pub sort_order: i32,
    pub lines: Vec<IncomeLineInput>,
    pub fields: Vec<IncomeCustomFieldInput>,
    pub milestones: Vec<IncomeMilestoneInput>,
    pub allowed_scopes: Vec<String>,
    pub household_timezone: String,
}

#[derive(Debug, Clone)]
pub struct IncomeLineInput {
    pub label: String,
    pub amount: Decimal,
    pub frequency: String,
    pub owner_scope: Option<String>,
    pub category: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    pub notes: String,
    pub fields: Vec<IncomeCustomFieldInput>,
}

#[derive(Debug, Clone)]
pub struct IncomeCustomFieldInput {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone)]
pub struct IncomeMilestoneInput {
    pub label: String,
    pub milestone_date: NaiveDate,
}

#[derive(Debug, Clone)]
pub struct IncomeSourceEntryInput {
    pub amount: Decimal,
    pub entry_date: Option<NaiveDate>,
    pub description: String,
    pub notes: String,
    pub owner_scope: Option<String>,
    pub extra_payload: Value,
    pub allowed_scopes: Vec<String>,
    pub household_timezone: String,
}

#[derive(Debug, Clone)]
pub struct IncomeSourceRecord {
    pub id: Uuid,
    pub name: String,
    pub source_type: String,
    pub owner_scope: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    pub notes: String,
    pub sort_order: i32,
}

#[derive(Debug, Clone)]
pub struct IncomeLineRecord {
    pub id: Uuid,
    pub label: String,
    pub amount: Decimal,
    pub frequency: String,
    pub owner_scope: Option<String>,
    pub category: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    pub notes: String,
}

#[derive(Debug, Clone)]
pub struct IncomeCustomFieldRecord {
    pub income_source_id: Option<Uuid>,
    pub income_source_line_id: Option<Uuid>,
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone)]
pub struct IncomeMilestoneRecord {
    pub label: String,
    pub milestone_date: NaiveDate,
}

#[derive(Debug, Clone)]
pub struct IncomeEntryRecord {
    pub id: Uuid,
    pub description: String,
    pub amount: Decimal,
    pub entry_date: Option<NaiveDate>,
    pub owner_scope: String,
    pub notes: String,
    pub extra_payload: Value,
}

#[derive(Debug, Clone)]
pub struct IncomeSourceDetails {
    pub source: IncomeSourceRecord,
    pub lines: Vec<IncomeLineRecord>,
    pub fields: Vec<IncomeCustomFieldRecord>,
    pub milestones: Vec<IncomeMilestoneRecord>,
    pub entries: Vec<IncomeEntryRecord>,
}

#[derive(Debug, Clone, Copy)]
pub enum LedgerDirection {
    Income,
    Expense,
}

impl LedgerDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Income => "income",
            Self::Expense => "expense",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RecordsStoreError {
    #[error("{0}")]
    Validation(String),
    #[error("permission denied")]
    Forbidden,
    #[error("resource not found")]
    NotFound,
    #[error("database error")]
    Database(#[from] sqlx::Error),
}

pub async fn create_manual_ledger_entry(
    pool: &PgPool,
    household_id: Uuid,
    input: ManualLedgerEntryInput,
) -> Result<Uuid, RecordsStoreError> {
    if !input
        .allowed_scopes
        .iter()
        .any(|allowed| allowed == &input.owner_scope)
    {
        return Err(RecordsStoreError::Forbidden);
    }
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    if let Some(source_id) = input.income_source_id {
        let owner_scope = sqlx::query!(
            "SELECT owner_scope
             FROM income_sources
             WHERE household_id = $1 AND id = $2",
            household_id,
            source_id
        )
        .fetch_optional(&mut *transaction)
        .await?
        .map(|row| row.owner_scope);
        let Some(owner_scope) = owner_scope else {
            return Err(RecordsStoreError::NotFound);
        };
        if !input
            .allowed_scopes
            .iter()
            .any(|allowed| allowed == &owner_scope)
        {
            return Err(RecordsStoreError::Forbidden);
        }
    }
    let category_id = category(
        &mut transaction,
        household_id,
        input.direction.as_str(),
        &input.category_name,
        None,
    )
    .await?;
    let subcategory_id = if let Some(name) = input
        .subcategory_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
    {
        Some(
            category(
                &mut transaction,
                household_id,
                input.direction.as_str(),
                name,
                Some(category_id),
            )
            .await?,
        )
    } else {
        None
    };
    let source_key = format!("app_manual:{}:{}", input.direction.as_str(), Uuid::now_v7());
    let id = sqlx::query!(
        "INSERT INTO ledger_entries
            (household_id, direction, status, amount, currency, entry_date,
             description, notes, owner_scope, data_source, category_id,
             subcategory_id, income_source_id, source_key)
         VALUES ($1, $2, 'actual', $3, $4, $5, $6, $7, $8,
                 'app_manual', $9, $10, $11, $12)
         RETURNING id",
        household_id,
        input.direction.as_str(),
        input.amount,
        input.currency,
        input.entry_date,
        input.description.trim(),
        input.notes,
        input.owner_scope,
        category_id,
        subcategory_id,
        input.income_source_id,
        source_key
    )
    .fetch_one(&mut *transaction)
    .await?
    .id;
    let current_month = month_start_at(&input.household_timezone, chrono::Utc::now())
        .map_err(|error| RecordsStoreError::Validation(format!("invalid timezone: {error}")))?;
    materialize_household_in_transaction(&mut transaction, household_id, current_month)
        .await
        .map_err(|error| {
            RecordsStoreError::Validation(format!(
                "planning materialization after record write failed: {error}"
            ))
        })?;
    transaction.commit().await?;
    Ok(id)
}

pub async fn list_income_sources(
    pool: &PgPool,
    household_id: Uuid,
    allowed_scopes: &[String],
) -> Result<Vec<IncomeSourceDetails>, RecordsStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let rows = sqlx::query_as!(
        IncomeSourceRecord,
        "SELECT id, name, source_type, owner_scope, started_on, ended_on, notes, sort_order
         FROM income_sources
         WHERE household_id = $1 AND owner_scope = ANY($2)
         ORDER BY sort_order, name",
        household_id,
        allowed_scopes
    )
    .fetch_all(&mut *transaction)
    .await?;
    let mut responses = Vec::with_capacity(rows.len());
    for row in rows {
        responses.push(
            load_income_source_details(&mut transaction, household_id, row, allowed_scopes).await?,
        );
    }
    transaction.commit().await?;
    Ok(responses)
}

pub async fn create_income_source(
    pool: &PgPool,
    household_id: Uuid,
    input: IncomeSourceInput,
) -> Result<IncomeSourceDetails, RecordsStoreError> {
    if !allowed_scope(&input.allowed_scopes, &input.owner_scope) {
        return Err(RecordsStoreError::Forbidden);
    }
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let row = sqlx::query_as!(
        IncomeSourceRecord,
        "INSERT INTO income_sources
            (household_id, name, source_type, owner_scope, started_on, ended_on,
             notes, sort_order, source_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, name, source_type, owner_scope, started_on, ended_on,
                   notes, sort_order",
        household_id,
        input.name.trim(),
        &input.source_type,
        &input.owner_scope,
        input.started_on,
        input.ended_on,
        &input.notes,
        input.sort_order,
        format!("app_manual:income-source:{}", Uuid::now_v7())
    )
    .fetch_one(&mut *transaction)
    .await?;
    replace_income_source_details(&mut transaction, household_id, row.id, &input).await?;
    let response =
        load_income_source_details(&mut transaction, household_id, row, &input.allowed_scopes)
            .await?;
    materialize_after_write(&mut transaction, household_id, &input.household_timezone).await?;
    transaction.commit().await?;
    Ok(response)
}

pub async fn update_income_source(
    pool: &PgPool,
    household_id: Uuid,
    source_id: Uuid,
    input: IncomeSourceInput,
) -> Result<IncomeSourceDetails, RecordsStoreError> {
    let _existing =
        ensure_income_source_visible(pool, household_id, source_id, &input.allowed_scopes).await?;
    if !allowed_scope(&input.allowed_scopes, &input.owner_scope) {
        return Err(RecordsStoreError::Forbidden);
    }
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let row = sqlx::query_as!(
        IncomeSourceRecord,
        "UPDATE income_sources
         SET name = $3, source_type = $4, owner_scope = $5, started_on = $6,
             ended_on = $7, notes = $8, sort_order = $9, updated_at = now()
         WHERE household_id = $1 AND id = $2
         RETURNING id, name, source_type, owner_scope, started_on, ended_on,
                   notes, sort_order",
        household_id,
        source_id,
        input.name.trim(),
        &input.source_type,
        &input.owner_scope,
        input.started_on,
        input.ended_on,
        &input.notes,
        input.sort_order
    )
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(RecordsStoreError::NotFound)?;
    replace_income_source_details(&mut transaction, household_id, row.id, &input).await?;
    let response =
        load_income_source_details(&mut transaction, household_id, row, &input.allowed_scopes)
            .await?;
    materialize_after_write(&mut transaction, household_id, &input.household_timezone).await?;
    transaction.commit().await?;
    Ok(response)
}

pub async fn create_income_source_entry(
    pool: &PgPool,
    household_id: Uuid,
    source_id: Uuid,
    input: IncomeSourceEntryInput,
) -> Result<IncomeSourceDetails, RecordsStoreError> {
    let source =
        ensure_income_source_visible(pool, household_id, source_id, &input.allowed_scopes).await?;
    let owner_scope = input
        .owner_scope
        .clone()
        .unwrap_or_else(|| source.owner_scope.clone());
    if !allowed_scope(&input.allowed_scopes, &owner_scope) {
        return Err(RecordsStoreError::Forbidden);
    }
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let description = if input.description.trim().is_empty() {
        source.name.as_str()
    } else {
        input.description.trim()
    };
    sqlx::query!(
        "INSERT INTO ledger_entries
            (household_id, direction, status, amount, currency, entry_date,
             description, notes, owner_scope, data_source, income_source_id,
             source_key, extra_payload)
         VALUES ($1, 'income', 'actual', $2,
                 (SELECT base_currency FROM households WHERE id = $1),
                 $3, $4, $5, $6, 'app_manual', $7, $8, $9)",
        household_id,
        input.amount,
        input.entry_date,
        description,
        &input.notes,
        owner_scope,
        source_id,
        format!("app_manual:income-entry:{}", Uuid::now_v7()),
        input.extra_payload
    )
    .execute(&mut *transaction)
    .await?;
    let response = load_income_source_details(
        &mut transaction,
        household_id,
        source,
        &input.allowed_scopes,
    )
    .await?;
    materialize_after_write(&mut transaction, household_id, &input.household_timezone).await?;
    transaction.commit().await?;
    Ok(response)
}

pub async fn update_income_source_entry(
    pool: &PgPool,
    household_id: Uuid,
    source_id: Uuid,
    entry_id: Uuid,
    input: IncomeSourceEntryInput,
) -> Result<IncomeSourceDetails, RecordsStoreError> {
    let source =
        ensure_income_source_visible(pool, household_id, source_id, &input.allowed_scopes).await?;
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let existing_scope = sqlx::query!(
        "SELECT owner_scope FROM ledger_entries
         WHERE household_id = $1 AND id = $2 AND income_source_id = $3
           AND direction = 'income' AND status = 'actual'",
        household_id,
        entry_id,
        source_id
    )
    .fetch_optional(&mut *transaction)
    .await?
    .map(|row| row.owner_scope)
    .ok_or(RecordsStoreError::NotFound)?;
    if !allowed_scope(&input.allowed_scopes, &existing_scope) {
        return Err(RecordsStoreError::Forbidden);
    }
    let owner_scope = input
        .owner_scope
        .clone()
        .unwrap_or_else(|| source.owner_scope.clone());
    if !allowed_scope(&input.allowed_scopes, &owner_scope) {
        return Err(RecordsStoreError::Forbidden);
    }
    let description = if input.description.trim().is_empty() {
        source.name.as_str()
    } else {
        input.description.trim()
    };
    let result = sqlx::query!(
        "UPDATE ledger_entries
         SET amount = $4, entry_date = $5, description = $6, notes = $7,
             owner_scope = $8, extra_payload = $9, updated_at = now()
         WHERE household_id = $1 AND id = $2 AND income_source_id = $3
           AND direction = 'income' AND status = 'actual'",
        household_id,
        entry_id,
        source_id,
        input.amount,
        input.entry_date,
        description,
        &input.notes,
        owner_scope,
        input.extra_payload
    )
    .execute(&mut *transaction)
    .await?;
    if result.rows_affected() == 0 {
        return Err(RecordsStoreError::NotFound);
    }
    let response = load_income_source_details(
        &mut transaction,
        household_id,
        source,
        &input.allowed_scopes,
    )
    .await?;
    materialize_after_write(&mut transaction, household_id, &input.household_timezone).await?;
    transaction.commit().await?;
    Ok(response)
}

pub async fn delete_income_source(
    pool: &PgPool,
    household_id: Uuid,
    source_id: Uuid,
    allowed_scopes: &[String],
    household_timezone: &str,
) -> Result<(), RecordsStoreError> {
    let _source =
        ensure_income_source_visible(pool, household_id, source_id, allowed_scopes).await?;
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let result = sqlx::query!(
        "DELETE FROM income_sources WHERE household_id = $1 AND id = $2",
        household_id,
        source_id
    )
    .execute(&mut *transaction)
    .await?;
    if result.rows_affected() == 0 {
        return Err(RecordsStoreError::NotFound);
    }
    materialize_after_write(&mut transaction, household_id, household_timezone).await?;
    transaction.commit().await?;
    Ok(())
}

pub(crate) async fn category(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    kind: &str,
    name: &str,
    parent_id: Option<Uuid>,
) -> Result<Uuid, RecordsStoreError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(RecordsStoreError::Validation(
            "Category name is required.".to_owned(),
        ));
    }
    let normalized = name.to_lowercase();
    let existing = sqlx::query!(
        "SELECT id FROM categories
         WHERE household_id = $1 AND kind = $2
           AND parent_id IS NOT DISTINCT FROM $3
           AND normalized_name = $4",
        household_id,
        kind,
        parent_id,
        &normalized
    )
    .fetch_optional(&mut **transaction)
    .await?
    .map(|row| row.id);
    if let Some(id) = existing {
        return Ok(id);
    }
    Ok(sqlx::query!(
        "INSERT INTO categories
            (household_id, kind, name, normalized_name, parent_id, creation_origin)
         VALUES ($1, $2, $3, $4, $5, 'manual')
         RETURNING id",
        household_id,
        kind,
        name,
        normalized,
        parent_id
    )
    .fetch_one(&mut **transaction)
    .await?
    .id)
}

async fn ensure_income_source_visible(
    pool: &PgPool,
    household_id: Uuid,
    source_id: Uuid,
    allowed_scopes: &[String],
) -> Result<IncomeSourceRecord, RecordsStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let source = sqlx::query_as!(
        IncomeSourceRecord,
        "SELECT id, name, source_type, owner_scope, started_on, ended_on, notes, sort_order
         FROM income_sources
         WHERE household_id = $1 AND id = $2",
        household_id,
        source_id
    )
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(RecordsStoreError::NotFound)?;
    transaction.commit().await?;
    if !allowed_scope(allowed_scopes, &source.owner_scope) {
        return Err(RecordsStoreError::Forbidden);
    }
    Ok(source)
}

async fn replace_income_source_details(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    source_id: Uuid,
    input: &IncomeSourceInput,
) -> Result<(), RecordsStoreError> {
    sqlx::query!(
        "DELETE FROM income_source_custom_fields
         WHERE household_id = $1
           AND (income_source_id = $2 OR income_source_line_id IN (
               SELECT id FROM income_source_lines
               WHERE household_id = $1 AND income_source_id = $2
           ))",
        household_id,
        source_id
    )
    .execute(&mut **transaction)
    .await?;
    sqlx::query!(
        "DELETE FROM income_source_lines WHERE household_id = $1 AND income_source_id = $2",
        household_id,
        source_id
    )
    .execute(&mut **transaction)
    .await?;
    sqlx::query!(
        "DELETE FROM income_source_milestones
         WHERE household_id = $1 AND income_source_id = $2",
        household_id,
        source_id
    )
    .execute(&mut **transaction)
    .await?;

    for (index, line) in input.lines.iter().enumerate() {
        let sort_order = i32::try_from(index).map_err(|_| {
            RecordsStoreError::Validation("income source line index overflowed".to_owned())
        })?;
        let line_id = sqlx::query!(
            "INSERT INTO income_source_lines
                (household_id, income_source_id, label, amount, frequency,
                 owner_scope, category, started_on, ended_on, notes, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6::text, $7, $8, $9, $10, $11)
             RETURNING id",
            household_id,
            source_id,
            &line.label,
            line.amount,
            &line.frequency,
            line.owner_scope.as_deref(),
            &line.category,
            line.started_on,
            line.ended_on,
            &line.notes,
            sort_order
        )
        .fetch_one(&mut **transaction)
        .await?
        .id;
        for (field_index, field) in line.fields.iter().enumerate() {
            insert_field(
                transaction,
                household_id,
                None,
                Some(line_id),
                field,
                field_index,
            )
            .await?;
        }
    }
    for (index, field) in input.fields.iter().enumerate() {
        insert_field(
            transaction,
            household_id,
            Some(source_id),
            None,
            field,
            index,
        )
        .await?;
    }
    for (index, milestone) in input.milestones.iter().enumerate() {
        let sort_order = i32::try_from(index).map_err(|_| {
            RecordsStoreError::Validation("income source milestone index overflowed".to_owned())
        })?;
        sqlx::query!(
            "INSERT INTO income_source_milestones
                (household_id, income_source_id, label, milestone_date, sort_order)
             VALUES ($1, $2, $3, $4, $5)",
            household_id,
            source_id,
            &milestone.label,
            milestone.milestone_date,
            sort_order
        )
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

async fn insert_field(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    source_id: Option<Uuid>,
    line_id: Option<Uuid>,
    field: &IncomeCustomFieldInput,
    sort_order: usize,
) -> Result<(), RecordsStoreError> {
    let sort_order = i32::try_from(sort_order).map_err(|_| {
        RecordsStoreError::Validation("income source field index overflowed".to_owned())
    })?;
    sqlx::query!(
        "INSERT INTO income_source_custom_fields
            (household_id, income_source_id, income_source_line_id,
             label, value, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)",
        household_id,
        source_id,
        line_id,
        &field.label,
        &field.value,
        sort_order
    )
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn load_income_source_details(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    source: IncomeSourceRecord,
    allowed_scopes: &[String],
) -> Result<IncomeSourceDetails, RecordsStoreError> {
    let lines = sqlx::query_as!(
        IncomeLineRecord,
        "SELECT id, label, amount, frequency, owner_scope, category,
                started_on, ended_on, notes
         FROM income_source_lines
         WHERE household_id = $1 AND income_source_id = $2
         ORDER BY sort_order, created_at",
        household_id,
        source.id
    )
    .fetch_all(&mut **transaction)
    .await?;
    let fields = sqlx::query_as!(
        IncomeCustomFieldRecord,
        "SELECT income_source_id, income_source_line_id, label, value
         FROM income_source_custom_fields
         WHERE household_id = $1
           AND (income_source_id = $2 OR income_source_line_id IN (
               SELECT id FROM income_source_lines
               WHERE household_id = $1 AND income_source_id = $2
           ))
         ORDER BY sort_order, created_at",
        household_id,
        source.id
    )
    .fetch_all(&mut **transaction)
    .await?;
    let milestones = sqlx::query_as!(
        IncomeMilestoneRecord,
        "SELECT label, milestone_date
         FROM income_source_milestones
         WHERE household_id = $1 AND income_source_id = $2
         ORDER BY sort_order, created_at",
        household_id,
        source.id
    )
    .fetch_all(&mut **transaction)
    .await?;
    let entries = sqlx::query_as!(
        IncomeEntryRecord,
        r#"SELECT id, description, amount, entry_date, owner_scope, notes,
                  extra_payload AS "extra_payload!: Value"
         FROM ledger_entries
         WHERE household_id = $1 AND income_source_id = $2
           AND direction = 'income' AND status = 'actual'
           AND owner_scope = ANY($3)
         ORDER BY entry_date DESC, created_at DESC"#,
        household_id,
        source.id,
        allowed_scopes
    )
    .fetch_all(&mut **transaction)
    .await?;
    Ok(IncomeSourceDetails {
        source,
        lines,
        fields,
        milestones,
        entries,
    })
}

async fn materialize_after_write(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    timezone: &str,
) -> Result<(), RecordsStoreError> {
    let current_month = month_start_at(timezone, chrono::Utc::now())
        .map_err(|error| RecordsStoreError::Validation(format!("invalid timezone: {error}")))?;
    materialize_household_in_transaction(transaction, household_id, current_month)
        .await
        .map_err(|error| {
            RecordsStoreError::Validation(format!(
                "planning materialization after record write failed: {error}"
            ))
        })
        .map(|_| ())
}

fn allowed_scope(allowed_scopes: &[String], scope: &str) -> bool {
    allowed_scopes.iter().any(|allowed| allowed == scope)
}
