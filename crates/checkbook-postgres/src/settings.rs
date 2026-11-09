use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::tenant;

#[derive(Debug, Clone)]
pub struct HouseholdSettingsPatch {
    pub privacy_mode: Option<String>,
    pub allow_cross_member_visibility: Option<bool>,
    pub projection_baseline_window_months: Option<i32>,
    pub projection_horizon_months: Option<i32>,
    pub savings_allocation_strategy: Option<String>,
    pub role_permissions: Option<Value>,
    pub actor_user_id: Uuid,
}

#[derive(Debug, Clone)]
pub struct BackupConfigRecord {
    pub path: String,
    pub retention: i32,
}

pub async fn update_household_settings(
    pool: &PgPool,
    household_id: Uuid,
    patch: HouseholdSettingsPatch,
) -> Result<(), sqlx::Error> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    sqlx::query!(
        "UPDATE household_settings
         SET privacy_mode = COALESCE($2, privacy_mode),
             allow_cross_member_visibility = COALESCE($3, allow_cross_member_visibility),
             projection_baseline_window_months = COALESCE($4, projection_baseline_window_months),
             projection_horizon_months = COALESCE($5, projection_horizon_months),
             savings_allocation_strategy = COALESCE($6, savings_allocation_strategy),
             updated_at = now()
         WHERE household_id = $1",
        household_id,
        patch.privacy_mode,
        patch.allow_cross_member_visibility,
        patch.projection_baseline_window_months,
        patch.projection_horizon_months,
        patch.savings_allocation_strategy
    )
    .execute(&mut *transaction)
    .await?;
    if let Some(permissions) = patch.role_permissions.as_ref() {
        update_permissions(&mut transaction, household_id, permissions).await?;
        sqlx::query!(
            "INSERT INTO audit_events
                (household_id, actor_user_id, event_type, resource_type, payload)
             VALUES ($1,$2,'role_permissions_updated','household_settings',$3)",
            household_id,
            patch.actor_user_id,
            permissions
        )
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await
}

pub async fn load_backup_config(
    pool: &PgPool,
    household_id: Uuid,
) -> Result<BackupConfigRecord, sqlx::Error> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let config = sqlx::query!(
        "SELECT backup_path, backup_retention
         FROM household_settings
         WHERE household_id = $1",
        household_id
    )
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(BackupConfigRecord {
        path: config.backup_path,
        retention: config.backup_retention,
    })
}

pub async fn update_backup_config(
    pool: &PgPool,
    household_id: Uuid,
    path: &str,
    retention: i32,
) -> Result<(), sqlx::Error> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    sqlx::query!(
        "UPDATE household_settings
         SET backup_path = $2, backup_retention = $3, updated_at = now()
         WHERE household_id = $1",
        household_id,
        path,
        retention
    )
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await
}

async fn update_permissions(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    household_id: Uuid,
    permissions: &Value,
) -> Result<(), sqlx::Error> {
    for module in ["planning", "settings", "imports", "records"] {
        for role in ["owner", "contributor"] {
            let Some(values) = permissions.get(module).and_then(|module| module.get(role)) else {
                continue;
            };
            let read = values.get("read").and_then(Value::as_bool);
            let write = values.get("write").and_then(Value::as_bool);
            let delete = values.get("delete").and_then(Value::as_bool);
            sqlx::query!(
                "UPDATE role_permissions
                 SET can_read = COALESCE($4, can_read),
                     can_write = COALESCE($5, can_write),
                     can_delete = COALESCE($6, can_delete),
                     updated_at = now()
                 WHERE household_id = $1 AND module = $2 AND role = $3",
                household_id,
                module,
                role,
                read,
                write,
                delete
            )
            .execute(&mut **transaction)
            .await?;
        }
    }
    Ok(())
}
