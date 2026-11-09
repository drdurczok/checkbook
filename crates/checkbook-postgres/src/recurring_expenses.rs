use checkbook_domain::{Money, recurring_date};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    records::{self, RecordsStoreError},
    tenant,
};

#[derive(Debug, Clone)]
pub struct RecurringExpenseInput {
    pub description: String,
    pub amount: Decimal,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
    pub cadence: String,
    pub owner_scope: String,
    pub category_name: String,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecurringExpense {
    pub id: Uuid,
    pub description: String,
    pub amount: Decimal,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
    pub next_due_date: Option<NaiveDate>,
    pub cadence: String,
    pub owner_scope: String,
    pub category_id: Option<Uuid>,
    pub category_name: String,
    pub notes: String,
    pub is_active: bool,
    pub price_history: Value,
}

#[derive(Debug, Clone)]
pub struct RecurringSchedule {
    pub record: RecurringExpense,
    pub next_index: i32,
    pub revision: Uuid,
}

fn invalid(message: impl ToString) -> RecordsStoreError {
    RecordsStoreError::Validation(message.to_string())
}

fn permitted(scopes: &[String], scope: &str) -> Result<(), RecordsStoreError> {
    if scopes.iter().any(|allowed| allowed == scope) {
        Ok(())
    } else {
        Err(RecordsStoreError::Forbidden)
    }
}

fn next_date(schedule: &RecurringSchedule) -> Result<Option<NaiveDate>, RecordsStoreError> {
    if !schedule.record.is_active {
        return Ok(None);
    }
    let index = u32::try_from(schedule.next_index).map_err(invalid)?;
    let date = recurring_date(schedule.record.start_date, &schedule.record.cadence, index)
        .map_err(invalid)?;
    Ok(Some(date).filter(|date| schedule.record.end_date.is_none_or(|end| *date <= end)))
}

pub async fn load_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
) -> Result<Vec<RecurringSchedule>, RecordsStoreError> {
    let rows = sqlx::query!(
        "SELECT r.id, r.description, r.amount, r.start_date, r.end_date,
                r.cadence, r.owner_scope, r.category_id,
                COALESCE(c.name, '') AS \"category_name!\", r.notes, r.is_active,
                r.price_history, r.next_index, r.revision
         FROM recurring_expenses r
         LEFT JOIN categories c ON c.household_id = r.household_id AND c.id = r.category_id
         WHERE r.household_id = $1 ORDER BY r.created_at, r.id",
        household_id
    )
    .fetch_all(&mut **transaction)
    .await?;
    rows.into_iter()
        .map(|row| {
            let mut schedule = RecurringSchedule {
                record: RecurringExpense {
                    id: row.id,
                    description: row.description,
                    amount: row.amount,
                    start_date: row.start_date,
                    end_date: row.end_date,
                    next_due_date: None,
                    cadence: row.cadence,
                    owner_scope: row.owner_scope,
                    category_id: row.category_id,
                    category_name: row.category_name,
                    notes: row.notes,
                    is_active: row.is_active,
                    price_history: row.price_history,
                },
                next_index: row.next_index,
                revision: row.revision,
            };
            schedule.record.next_due_date = next_date(&schedule)?;
            Ok(schedule)
        })
        .collect()
}

async fn find(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    scopes: &[String],
    id: Uuid,
) -> Result<RecurringSchedule, RecordsStoreError> {
    let schedule = load_in_transaction(transaction, household_id)
        .await?
        .into_iter()
        .find(|schedule| schedule.record.id == id)
        .ok_or(RecordsStoreError::NotFound)?;
    permitted(scopes, &schedule.record.owner_scope)?;
    Ok(schedule)
}

async fn emit(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    schedule: &mut RecurringSchedule,
    date: NaiveDate,
    currency: &str,
) -> Result<(), RecordsStoreError> {
    let money = Money::new(schedule.record.amount, currency).map_err(invalid)?;
    let source_key = format!(
        "app_recurring:{}:{}:{}",
        schedule.record.id, schedule.revision, schedule.next_index
    );
    sqlx::query!(
        "INSERT INTO ledger_entries
            (household_id, direction, status, amount, currency, entry_date,
             description, notes, owner_scope, data_source, category_id, source_key)
         VALUES ($1, 'expense', 'actual', $2, $3, $4, $5, $6, $7, 'app_recurring', $8, $9)
         ON CONFLICT (household_id, source_key) DO NOTHING",
        household_id,
        money.amount(),
        money.currency(),
        date,
        schedule.record.description,
        schedule.record.notes,
        schedule.record.owner_scope,
        schedule.record.category_id,
        source_key
    )
    .execute(&mut **transaction)
    .await?;
    schedule.next_index = schedule
        .next_index
        .checked_add(1)
        .ok_or_else(|| invalid("Recurring cursor overflow"))?;
    sqlx::query!(
        "UPDATE recurring_expenses SET next_index = $3, updated_at = now()
         WHERE household_id = $1 AND id = $2",
        household_id,
        schedule.record.id,
        schedule.next_index
    )
    .execute(&mut **transaction)
    .await?;
    schedule.record.next_due_date = next_date(schedule)?;
    Ok(())
}

async fn materialize_schedule(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    schedule: &mut RecurringSchedule,
    today: NaiveDate,
    currency: &str,
) -> Result<(), RecordsStoreError> {
    if next_date(schedule)?
        .is_some_and(|date| (today - date).num_days() > checkbook_domain::MAX_RECURRING_RANGE_DAYS)
    {
        return Err(invalid("Recurring backfill cannot exceed 100 years"));
    }
    while let Some(date) = next_date(schedule)?.filter(|date| *date <= today) {
        emit(transaction, household_id, schedule, date, currency).await?;
    }
    Ok(())
}

/// The caller must hold the household write transaction/advisory lock.
pub async fn materialize_due(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    today: NaiveDate,
    currency: &str,
) -> Result<(), RecordsStoreError> {
    for mut schedule in load_in_transaction(transaction, household_id).await? {
        materialize_schedule(transaction, household_id, &mut schedule, today, currency).await?;
    }
    Ok(())
}

pub async fn list(
    pool: &PgPool,
    household_id: Uuid,
    scopes: &[String],
    today: NaiveDate,
    currency: &str,
) -> Result<Vec<RecurringExpense>, RecordsStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    materialize_due(&mut transaction, household_id, today, currency).await?;
    let records = load_in_transaction(&mut transaction, household_id)
        .await?
        .into_iter()
        .filter(|schedule| scopes.contains(&schedule.record.owner_scope))
        .map(|schedule| schedule.record)
        .collect();
    transaction.commit().await?;
    Ok(records)
}

async fn validate(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    scopes: &[String],
    input: &RecurringExpenseInput,
    currency: &str,
) -> Result<(Decimal, Uuid), RecordsStoreError> {
    permitted(scopes, &input.owner_scope)?;
    if !["self", "spouse", "joint"].contains(&input.owner_scope.as_str()) {
        return Err(invalid("Invalid owner scope"));
    }
    let money = Money::new(input.amount, currency).map_err(invalid)?;
    if money.amount() <= Decimal::ZERO {
        return Err(invalid("Amount must be positive"));
    }
    if input.description.trim().is_empty() {
        return Err(invalid("Description is required"));
    }
    if input.end_date.is_some_and(|end| end < input.start_date) {
        return Err(invalid("End date must not precede start date"));
    }
    if !["weekly", "biweekly", "monthly", "quarterly", "yearly"].contains(&input.cadence.as_str()) {
        return Err(invalid("Invalid recurring cadence"));
    }
    recurring_date(input.start_date, &input.cadence, 0).map_err(invalid)?;
    let category_id = records::category(
        transaction,
        household_id,
        "expense",
        &input.category_name,
        None,
    )
    .await?;
    let active = sqlx::query!(
        "SELECT NOT c.is_retired AND c.kind = 'expense'
                AND (g.id IS NULL OR NOT g.is_retired) AS \"active!\"
         FROM categories c LEFT JOIN expense_groups g
           ON g.household_id = c.household_id AND g.id = c.expense_group_id
         WHERE c.household_id = $1 AND c.id = $2",
        household_id,
        category_id
    )
    .fetch_one(&mut **transaction)
    .await?
    .active;
    if !active {
        return Err(invalid("Category must be an active expense category"));
    }
    Ok((money.amount(), category_id))
}

pub async fn create(
    pool: &PgPool,
    household_id: Uuid,
    scopes: &[String],
    input: RecurringExpenseInput,
    today: NaiveDate,
    currency: &str,
) -> Result<RecurringExpense, RecordsStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let (amount, category_id) =
        validate(&mut transaction, household_id, scopes, &input, currency).await?;
    let id = sqlx::query!(
        "INSERT INTO recurring_expenses
            (household_id, description, amount, start_date, end_date, cadence, owner_scope, category_id, notes, price_history)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 jsonb_build_array(jsonb_build_object('amount', $3::numeric::text, 'changed_at', now()))) RETURNING id",
        household_id, input.description.trim(), amount, input.start_date, input.end_date,
        input.cadence, input.owner_scope, category_id, input.notes
    ).fetch_one(&mut *transaction).await?.id;
    let mut schedule = find(&mut transaction, household_id, scopes, id).await?;
    materialize_schedule(
        &mut transaction,
        household_id,
        &mut schedule,
        today,
        currency,
    )
    .await?;
    transaction.commit().await?;
    Ok(schedule.record)
}

pub async fn update(
    pool: &PgPool,
    household_id: Uuid,
    scopes: &[String],
    id: Uuid,
    input: RecurringExpenseInput,
    today: NaiveDate,
    currency: &str,
) -> Result<RecurringExpense, RecordsStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let mut old = find(&mut transaction, household_id, scopes, id).await?;
    let (amount, category_id) =
        validate(&mut transaction, household_id, scopes, &input, currency).await?;
    materialize_schedule(&mut transaction, household_id, &mut old, today, currency).await?;
    let reset = old.record.start_date != input.start_date || old.record.cadence != input.cadence;
    let revision = if reset { Uuid::new_v4() } else { old.revision };
    let next_index = if reset {
        // Schedule edits are prospective: old dues were settled above, not replayed.
        let mut low = 0_i32;
        let mut high = i32::MAX;
        while low < high {
            let middle = low + (high - low) / 2;
            if recurring_date(input.start_date, &input.cadence, middle as u32)
                .is_ok_and(|date| date <= today)
            {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        low
    } else {
        old.next_index
    };
    sqlx::query!(
        "UPDATE recurring_expenses SET description = $3, amount = $4, start_date = $5,
         end_date = $6, cadence = $7, owner_scope = $8, category_id = $9, notes = $10,
         next_index = $11, revision = $12, updated_at = now(),
         price_history = CASE WHEN amount <> $4 THEN price_history ||
             jsonb_build_array(jsonb_build_object('amount', $4::numeric::text, 'changed_at', now()))
             ELSE price_history END
         WHERE household_id = $1 AND id = $2",
        household_id,
        id,
        input.description.trim(),
        amount,
        input.start_date,
        input.end_date,
        input.cadence,
        input.owner_scope,
        category_id,
        input.notes,
        next_index,
        revision
    )
    .execute(&mut *transaction)
    .await?;
    let mut schedule = find(&mut transaction, household_id, scopes, id).await?;
    materialize_schedule(
        &mut transaction,
        household_id,
        &mut schedule,
        today,
        currency,
    )
    .await?;
    transaction.commit().await?;
    Ok(schedule.record)
}

pub async fn expense_now(
    pool: &PgPool,
    household_id: Uuid,
    scopes: &[String],
    id: Uuid,
    today: NaiveDate,
    currency: &str,
) -> Result<RecurringExpense, RecordsStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let mut schedule = find(&mut transaction, household_id, scopes, id).await?;
    materialize_schedule(
        &mut transaction,
        household_id,
        &mut schedule,
        today,
        currency,
    )
    .await?;
    if next_date(&schedule)?.is_none() {
        return Err(invalid("Schedule has no future expense"));
    }
    emit(
        &mut transaction,
        household_id,
        &mut schedule,
        today,
        currency,
    )
    .await?;
    transaction.commit().await?;
    Ok(schedule.record)
}

pub async fn retire(
    pool: &PgPool,
    household_id: Uuid,
    scopes: &[String],
    id: Uuid,
    today: NaiveDate,
    currency: &str,
) -> Result<RecurringExpense, RecordsStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let mut schedule = find(&mut transaction, household_id, scopes, id).await?;
    materialize_schedule(
        &mut transaction,
        household_id,
        &mut schedule,
        today,
        currency,
    )
    .await?;
    sqlx::query!(
        "UPDATE recurring_expenses SET is_active = false, updated_at = now()
        WHERE household_id = $1 AND id = $2",
        household_id,
        id
    )
    .execute(&mut *transaction)
    .await?;
    schedule.record.is_active = false;
    schedule.record.next_due_date = None;
    transaction.commit().await?;
    Ok(schedule.record)
}
