use checkbook_domain::local_date_at;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::planning::{PlanningStoreError, materialize_household};
use crate::tenant;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct MaintenanceResult {
    pub households_processed: u64,
    pub planning_changes: u64,
    pub sessions_deleted: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum MaintenanceError {
    #[error("database error")]
    Database(#[from] sqlx::Error),
    #[error("planning maintenance failed")]
    Planning(#[from] PlanningStoreError),
    #[error("household timezone is invalid")]
    TimeZone,
}

pub async fn run_once(pool: &PgPool) -> Result<MaintenanceResult, MaintenanceError> {
    run_once_at(pool, Utc::now()).await
}

pub async fn run_once_at(
    pool: &PgPool,
    now: DateTime<Utc>,
) -> Result<MaintenanceResult, MaintenanceError> {
    let sessions_deleted = sqlx::query!(
        "DELETE FROM sessions
         WHERE expires_at <= now() OR revoked_at IS NOT NULL"
    )
    .execute(pool)
    .await?
    .rows_affected();
    sqlx::query!(
        "DELETE FROM auth_rate_limits
         WHERE updated_at < now() - interval '10 minutes'"
    )
    .execute(pool)
    .await?;
    let households = sqlx::query!(
        r#"SELECT maintenance_household_ids AS "household_id!"
           FROM app.maintenance_household_ids()"#
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| row.household_id)
    .collect::<Vec<Uuid>>();
    let mut result = MaintenanceResult {
        households_processed: u64::try_from(households.len()).unwrap_or(u64::MAX),
        sessions_deleted,
        ..MaintenanceResult::default()
    };
    for household_id in households {
        let mut transaction = tenant::begin(pool, household_id, true).await?;
        let timezone = sqlx::query!(
            "SELECT timezone FROM households WHERE id = $1",
            household_id
        )
        .fetch_one(&mut *transaction)
        .await?
        .timezone;
        transaction.commit().await?;
        let today = local_date_at(&timezone, now).map_err(|_| MaintenanceError::TimeZone)?;
        result.planning_changes = result.planning_changes.saturating_add(
            materialize_household(pool, household_id, today)
                .await?
                .total_changes(),
        );
    }
    Ok(result)
}
