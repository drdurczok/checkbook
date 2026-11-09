use std::collections::BTreeMap;

use checkbook_domain::month_start_at;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    backup::{
        BACKUP_TABLES, HouseholdSnapshot, replace_household_data, upgrade_snapshot_schema,
        validate_snapshot, validate_snapshot_rows,
    },
    planning::materialize_household_in_transaction,
    tenant,
};

#[derive(Debug, Clone)]
pub struct DataLoadRunRecord {
    pub id: Uuid,
    pub household_id: Uuid,
    pub idempotency_key: String,
    pub status: String,
    pub archive_version: i32,
    pub counts: Value,
    pub warnings: Value,
    pub errors: Value,
    pub archive_sha256: String,
    pub committed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct ArchiveColumnRecord {
    pub table_name: String,
    pub column_name: String,
    pub data_type: String,
    pub is_nullable: String,
}

#[derive(Debug, Clone)]
pub struct NewDataLoadRun {
    pub id: Uuid,
    pub household_id: Uuid,
    pub idempotency_key: String,
    pub archive_version: i32,
    pub counts: Value,
    pub archive_path: String,
    pub archive_sha256: String,
}

#[derive(Debug, Clone)]
pub struct CommitDataLoadResult {
    pub row: DataLoadRunRecord,
    pub restored: BTreeMap<String, u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum DataLoadStoreError {
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    Conflict(String),
    #[error("Data load not found.")]
    NotFound,
    #[error("database error")]
    Database(#[from] sqlx::Error),
}

pub async fn archive_schema_columns(
    pool: &PgPool,
) -> Result<Vec<ArchiveColumnRecord>, DataLoadStoreError> {
    let backup_tables = BACKUP_TABLES
        .iter()
        .map(|table| (*table).to_owned())
        .collect::<Vec<_>>();
    Ok(sqlx::query_as!(
        ArchiveColumnRecord,
        r#"SELECT table_name AS "table_name!", column_name AS "column_name!",
                CASE
                    WHEN data_type = 'USER-DEFINED' THEN udt_name
                    ELSE data_type
                END AS "data_type!",
                is_nullable AS "is_nullable!"
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ANY($1)
         ORDER BY table_name, ordinal_position"#,
        &backup_tables
    )
    .fetch_all(pool)
    .await?)
}

pub async fn validate_staged_snapshot(
    pool: &PgPool,
    snapshot: &HouseholdSnapshot,
) -> Result<(), DataLoadStoreError> {
    let snapshot = upgrade_snapshot_schema(snapshot)
        .map_err(|error| DataLoadStoreError::Validation(error.to_string()))?;
    validate_snapshot(&snapshot, snapshot.household_id)
        .map_err(|error| DataLoadStoreError::Validation(error.to_string()))?;
    let mut transaction = tenant::begin(pool, snapshot.household_id, true).await?;
    let exists = sqlx::query!(
        r#"SELECT EXISTS(SELECT 1 FROM households WHERE id = $1) AS "exists!""#,
        snapshot.household_id
    )
    .fetch_one(&mut *transaction)
    .await?
    .exists;
    if exists {
        validate_snapshot_rows(&mut transaction, &snapshot)
            .await
            .map_err(|error| DataLoadStoreError::Validation(error.to_string()))?;
    }
    transaction.commit().await?;
    if !exists {
        return Err(DataLoadStoreError::Validation(
            "The target household does not exist.".to_owned(),
        ));
    }
    Ok(())
}

pub async fn load_by_idempotency(
    pool: &PgPool,
    household_id: Uuid,
    idempotency_key: &str,
) -> Result<Option<DataLoadRunRecord>, DataLoadStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let row = select_by_idempotency(&mut transaction, household_id, idempotency_key).await?;
    transaction.commit().await?;
    Ok(row)
}

pub async fn create_validated_run(
    pool: &PgPool,
    run: NewDataLoadRun,
) -> Result<DataLoadRunRecord, DataLoadStoreError> {
    let mut transaction = tenant::begin(pool, run.household_id, false).await?;
    let inserted = sqlx::query_as!(
        DataLoadRunRecord,
        r#"INSERT INTO data_load_runs
            (id, household_id, idempotency_key, status, archive_version,
             counts, warnings, errors, archive_path, archive_sha256)
         VALUES ($1,$2,$3,'validated',$4,$5,'[]'::jsonb,'[]'::jsonb,$6,$7)
         ON CONFLICT (household_id, idempotency_key) DO NOTHING
         RETURNING id, household_id, idempotency_key, status, archive_version,
                   counts AS "counts!: Value", warnings AS "warnings!: Value",
                   errors AS "errors!: Value", archive_sha256, committed_at,
                   created_at, updated_at"#,
        run.id,
        run.household_id,
        &run.idempotency_key,
        run.archive_version,
        &run.counts,
        &run.archive_path,
        &run.archive_sha256
    )
    .fetch_optional(&mut *transaction)
    .await?;
    let row = if let Some(row) = inserted {
        row
    } else {
        let row = select_by_idempotency(&mut transaction, run.household_id, &run.idempotency_key)
            .await?
            .ok_or(DataLoadStoreError::Database(sqlx::Error::RowNotFound))?;
        if row.archive_sha256 != run.archive_sha256 {
            return Err(DataLoadStoreError::Conflict(
                "The idempotency key already belongs to a different archive.".to_owned(),
            ));
        }
        row
    };
    transaction.commit().await?;
    Ok(row)
}

pub async fn load_row(
    pool: &PgPool,
    load_id: Uuid,
) -> Result<DataLoadRunRecord, DataLoadStoreError> {
    let household_id = load_household_id(pool, load_id).await?;
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let row = select_by_id(&mut transaction, household_id, load_id)
        .await?
        .ok_or(DataLoadStoreError::NotFound)?;
    transaction.commit().await?;
    Ok(row)
}

pub async fn load_commit_candidate(
    pool: &PgPool,
    load_id: Uuid,
) -> Result<(DataLoadRunRecord, String), DataLoadStoreError> {
    let household_id = load_household_id(pool, load_id).await?;
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let row = select_by_id(&mut transaction, household_id, load_id)
        .await?
        .ok_or(DataLoadStoreError::NotFound)?;
    let archive_path = sqlx::query!(
        r#"SELECT archive_path AS "archive_path!"
         FROM data_load_runs
         WHERE household_id = $1 AND id = $2"#,
        household_id,
        load_id
    )
    .fetch_one(&mut *transaction)
    .await?
    .archive_path;
    transaction.commit().await?;
    Ok((row, archive_path))
}

pub async fn commit_validated_run(
    pool: &PgPool,
    load_id: Uuid,
    expected_archive_sha256: &str,
    snapshot: &HouseholdSnapshot,
) -> Result<CommitDataLoadResult, DataLoadStoreError> {
    if snapshot.household_id != load_household_id(pool, load_id).await? {
        return Err(DataLoadStoreError::Conflict(
            "The staged archive household has changed.".to_owned(),
        ));
    }
    let household_id = snapshot.household_id;
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    tenant::advisory_lock(&mut transaction, household_id).await?;
    let current = sqlx::query_as!(
        DataLoadRunRecord,
        r#"SELECT id, household_id, idempotency_key, status, archive_version,
                counts AS "counts!: Value", warnings AS "warnings!: Value",
                errors AS "errors!: Value", archive_sha256, committed_at,
                created_at, updated_at
         FROM data_load_runs
         WHERE household_id = $1 AND id = $2
         FOR UPDATE"#,
        household_id,
        load_id
    )
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(DataLoadStoreError::NotFound)?;
    if current.status == "committed" {
        transaction.commit().await?;
        return Ok(CommitDataLoadResult {
            row: current,
            restored: BTreeMap::new(),
        });
    }
    if current.status != "validated" {
        return Err(DataLoadStoreError::Conflict(
            "Only a validated data load can be committed.".to_owned(),
        ));
    }
    if current.archive_sha256 != expected_archive_sha256 {
        return Err(DataLoadStoreError::Conflict(
            "The staged data-load record changed.".to_owned(),
        ));
    }
    let restored = replace_household_data(&mut transaction, household_id, snapshot)
        .await
        .map_err(|error| DataLoadStoreError::Validation(error.to_string()))?;
    let timezone = sqlx::query!(
        r#"SELECT timezone AS "timezone!" FROM households WHERE id = $1"#,
        household_id
    )
    .fetch_one(&mut *transaction)
    .await?
    .timezone;
    let current_month = month_start_at(&timezone, Utc::now()).map_err(|error| {
        DataLoadStoreError::Validation(format!("household timezone is invalid: {error}"))
    })?;
    materialize_household_in_transaction(&mut transaction, household_id, current_month)
        .await
        .map_err(|error| {
            DataLoadStoreError::Validation(format!(
                "planning materialization after data-load failed: {error}"
            ))
        })?;
    let row = sqlx::query_as!(
        DataLoadRunRecord,
        r#"UPDATE data_load_runs
         SET status = 'committed', committed_at = now(), updated_at = now()
         WHERE household_id = $1 AND id = $2 AND status = 'validated'
         RETURNING id, household_id, idempotency_key, status, archive_version,
                   counts AS "counts!: Value", warnings AS "warnings!: Value",
                   errors AS "errors!: Value", archive_sha256, committed_at,
                   created_at, updated_at"#,
        household_id,
        load_id
    )
    .fetch_one(&mut *transaction)
    .await?;
    let actor_user_id = household_owner_in_transaction(&mut transaction, household_id).await?;
    let payload = json!({"restored": restored});
    sqlx::query!(
        "INSERT INTO audit_events
            (household_id, actor_user_id, event_type, resource_type, resource_id, payload)
         VALUES ($1,$2,'data_load_committed','data_load_run',$3,$4)",
        household_id,
        actor_user_id,
        load_id,
        payload
    )
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(CommitDataLoadResult { row, restored })
}

pub async fn discard_run(
    pool: &PgPool,
    load_id: Uuid,
) -> Result<(DataLoadRunRecord, String), DataLoadStoreError> {
    let household_id = load_household_id(pool, load_id).await?;
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let archive_path = sqlx::query!(
        r#"SELECT archive_path AS "archive_path!"
         FROM data_load_runs
         WHERE household_id = $1 AND id = $2 AND status IN ('staged','validated','failed')"#,
        household_id,
        load_id
    )
    .fetch_optional(&mut *transaction)
    .await?
    .map(|row| row.archive_path)
    .ok_or_else(|| {
        DataLoadStoreError::Conflict("Committed or deleted data loads cannot be discarded.".into())
    })?;
    let row = sqlx::query_as!(
        DataLoadRunRecord,
        r#"UPDATE data_load_runs
         SET status = 'deleted', updated_at = now()
         WHERE household_id = $1 AND id = $2
         RETURNING id, household_id, idempotency_key, status, archive_version,
                   counts AS "counts!: Value", warnings AS "warnings!: Value",
                   errors AS "errors!: Value", archive_sha256, committed_at,
                   created_at, updated_at"#,
        household_id,
        load_id
    )
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok((row, archive_path))
}

pub fn snapshot_counts(snapshot: &HouseholdSnapshot) -> Value {
    Value::Object(
        snapshot
            .tables
            .iter()
            .map(|(table, rows)| (table.clone(), json!(rows.as_array().map_or(0, Vec::len))))
            .collect(),
    )
}

async fn load_household_id(pool: &PgPool, load_id: Uuid) -> Result<Uuid, DataLoadStoreError> {
    sqlx::query!(
        r#"SELECT app.data_load_household_id($1) AS "household_id?: Uuid""#,
        load_id
    )
    .fetch_optional(pool)
    .await?
    .and_then(|row| row.household_id)
    .ok_or(DataLoadStoreError::NotFound)
}

async fn select_by_idempotency(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    household_id: Uuid,
    idempotency_key: &str,
) -> Result<Option<DataLoadRunRecord>, sqlx::Error> {
    sqlx::query_as!(
        DataLoadRunRecord,
        r#"SELECT id, household_id, idempotency_key, status, archive_version,
                counts AS "counts!: Value", warnings AS "warnings!: Value",
                errors AS "errors!: Value", archive_sha256, committed_at,
                created_at, updated_at
         FROM data_load_runs
         WHERE household_id = $1 AND idempotency_key = $2"#,
        household_id,
        idempotency_key
    )
    .fetch_optional(&mut **transaction)
    .await
}

async fn select_by_id(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    household_id: Uuid,
    load_id: Uuid,
) -> Result<Option<DataLoadRunRecord>, sqlx::Error> {
    sqlx::query_as!(
        DataLoadRunRecord,
        r#"SELECT id, household_id, idempotency_key, status, archive_version,
                counts AS "counts!: Value", warnings AS "warnings!: Value",
                errors AS "errors!: Value", archive_sha256, committed_at,
                created_at, updated_at
         FROM data_load_runs
         WHERE household_id = $1 AND id = $2"#,
        household_id,
        load_id
    )
    .fetch_optional(&mut **transaction)
    .await
}

async fn household_owner_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    household_id: Uuid,
) -> Result<Uuid, DataLoadStoreError> {
    sqlx::query!(
        r#"SELECT user_id
         FROM household_memberships
         WHERE household_id = $1 AND is_active
         ORDER BY CASE WHEN relationship_kind = 'owner' THEN 0 ELSE 1 END, created_at
         LIMIT 1"#,
        household_id
    )
    .fetch_optional(&mut **transaction)
    .await?
    .map(|row| row.user_id)
    .ok_or_else(|| {
        DataLoadStoreError::Validation("The target household has no active member.".to_owned())
    })
}
