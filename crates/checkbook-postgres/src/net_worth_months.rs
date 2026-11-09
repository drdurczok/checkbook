use chrono::NaiveDate;
use rust_decimal::Decimal;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::assets::AssetStoreError;
use crate::tenant;

pub use checkbook_domain::net_worth::NetWorthComponent as NetWorthComponentInput;

/// A curated month as stored: components grouped per net worth group.
#[derive(Debug, Clone)]
pub struct NetWorthMonthRecord {
    pub period: NaiveDate,
    pub completed: bool,
    pub components: Vec<NetWorthComponentInput>,
}

/// Order-insensitive comparison key: labels identify a component within its
/// group, so payloads that only reshuffle rows stay identical to the store.
fn canonical_components(components: &[NetWorthComponentInput]) -> Vec<(String, String, Decimal)> {
    let mut keyed = components
        .iter()
        .map(|component| {
            (
                component.group_key.clone(),
                component.label.clone(),
                component.value,
            )
        })
        .collect::<Vec<_>>();
    keyed.sort();
    keyed
}

pub(crate) async fn load_month_records(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
) -> Result<Vec<NetWorthMonthRecord>, sqlx::Error> {
    let months = sqlx::query!(
        "SELECT id, period, completed FROM net_worth_months
         WHERE household_id = $1 ORDER BY period",
        household_id
    )
    .fetch_all(&mut **tx)
    .await?;
    let mut records = Vec::with_capacity(months.len());
    for month in months {
        let components = load_month_components(tx, household_id, month.id).await?;
        records.push(NetWorthMonthRecord {
            period: month.period,
            completed: month.completed,
            components,
        });
    }
    Ok(records)
}

/// Upsert the canonical record for one month. A previously completed record
/// only accepts an identical payload (idempotent save) or an explicit reopen
/// (`completed = false`); any other change is rejected until it is reopened.
pub async fn upsert_month(
    pool: &PgPool,
    household_id: Uuid,
    period: NaiveDate,
    completed: bool,
    components: Vec<NetWorthComponentInput>,
) -> Result<NetWorthMonthRecord, AssetStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let record = upsert_month_in_transaction(
        &mut transaction,
        household_id,
        period,
        completed,
        components,
    )
    .await?;
    transaction.commit().await?;
    Ok(record)
}

pub(crate) async fn upsert_month_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    period: NaiveDate,
    completed: bool,
    components: Vec<NetWorthComponentInput>,
) -> Result<NetWorthMonthRecord, AssetStoreError> {
    let components = checkbook_domain::net_worth::validate_month(period, components)
        .map_err(|message| AssetStoreError::Validation(message.to_owned()))?;
    let prior = sqlx::query_scalar!(
        "SELECT completed FROM net_worth_months WHERE household_id = $1 AND period = $2",
        household_id,
        period
    )
    .fetch_optional(&mut **tx)
    .await?;
    if prior == Some(true) {
        let existing = load_stored_components(tx, household_id, period).await?;
        if completed && canonical_components(&existing) != canonical_components(&components) {
            return Err(AssetStoreError::Validation(
                "Completed months are read-only until they are reopened.".to_owned(),
            ));
        }
    }
    let month_id = sqlx::query_scalar!(
        r#"INSERT INTO net_worth_months (household_id, period, completed)
           VALUES ($1, $2, $3)
           ON CONFLICT (household_id, period)
           DO UPDATE SET completed = EXCLUDED.completed, updated_at = now()
           RETURNING id AS "id!""#,
        household_id,
        period,
        completed
    )
    .fetch_one(&mut **tx)
    .await?;
    replace_components(tx, household_id, month_id, &components).await?;
    Ok(NetWorthMonthRecord {
        period,
        completed,
        components,
    })
}

async fn load_stored_components(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    period: NaiveDate,
) -> Result<Vec<NetWorthComponentInput>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT c.group_key AS "group_key!", c.label AS "label!", c.value AS "value!: Decimal"
           FROM net_worth_month_components c
           JOIN net_worth_months m ON m.household_id = c.household_id AND m.id = c.month_id
           WHERE c.household_id = $1 AND m.period = $2
           ORDER BY c.group_key, c.sort_order, c.label"#,
        household_id,
        period
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| NetWorthComponentInput {
            group_key: row.group_key,
            label: row.label,
            value: row.value,
        })
        .collect())
}

async fn load_month_components(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    month_id: Uuid,
) -> Result<Vec<NetWorthComponentInput>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT group_key AS "group_key!", label AS "label!", value AS "value!: Decimal"
           FROM net_worth_month_components
           WHERE household_id = $1 AND month_id = $2
           ORDER BY group_key, sort_order, label"#,
        household_id,
        month_id
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| NetWorthComponentInput {
            group_key: row.group_key,
            label: row.label,
            value: row.value,
        })
        .collect())
}

async fn replace_components(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    month_id: Uuid,
    components: &[NetWorthComponentInput],
) -> Result<(), AssetStoreError> {
    sqlx::query!(
        "DELETE FROM net_worth_month_components WHERE household_id = $1 AND month_id = $2",
        household_id,
        month_id
    )
    .execute(&mut **tx)
    .await?;
    for (index, component) in components.iter().enumerate() {
        let order = i32::try_from(index)
            .map_err(|_| AssetStoreError::Validation("Too many components.".to_owned()))?;
        sqlx::query!(
            "INSERT INTO net_worth_month_components
                 (household_id, month_id, group_key, label, value, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6)",
            household_id,
            month_id,
            component.group_key,
            component.label,
            component.value,
            order
        )
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}
