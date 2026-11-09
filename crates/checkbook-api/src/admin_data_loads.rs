use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use checkbook_application::ApplicationError;
use checkbook_postgres::{
    archive::{ARCHIVE_FORMAT, parse_archive},
    backup::{BACKUP_FORMAT_VERSION, BACKUP_SCHEMA_VERSION, BACKUP_TABLES},
    data_loads::{
        DataLoadRunRecord, DataLoadStoreError, NewDataLoadRun, archive_schema_columns,
        commit_validated_run, create_validated_run, discard_run, load_by_idempotency,
        load_commit_candidate, load_row, snapshot_counts, validate_staged_snapshot,
    },
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::error::{ApiError, ErrorBody};

const MAX_DATA_LOAD_BYTES: usize = 64 * 1024 * 1024;
const IDEMPOTENCY_HEADER: &str = "idempotency-key";

#[derive(Clone)]
pub struct AdminApiState {
    pool: PgPool,
    token_hash: [u8; 32],
    staging_root: PathBuf,
}

impl AdminApiState {
    #[must_use]
    pub fn new(pool: PgPool, service_token: &str, staging_root: PathBuf) -> Self {
        Self {
            pool,
            token_hash: Sha256::digest(service_token.as_bytes()).into(),
            staging_root,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct DataLoadResponse {
    id: Uuid,
    household_id: Uuid,
    idempotency_key: String,
    status: String,
    archive_version: i32,
    counts: Value,
    warnings: Value,
    errors: Value,
    archive_sha256: String,
    committed_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
struct CommitResponse {
    load: DataLoadResponse,
    restored: BTreeMap<String, u64>,
}

#[derive(Debug, Serialize)]
struct ArchiveSchemaResponse {
    format: &'static str,
    format_version: u32,
    schema_version: i64,
    maximum_archive_bytes: usize,
    multipart_field: &'static str,
    idempotency_header: &'static str,
    manifest_path: &'static str,
    table_json_path_pattern: &'static str,
    table_csv_path_pattern: &'static str,
    tables: Vec<ArchiveTableSchema>,
}

#[derive(Debug, Serialize)]
struct ArchiveTableSchema {
    name: String,
    json_path: String,
    csv_path: String,
    columns: Vec<ArchiveColumnSchema>,
}

#[derive(Debug, Serialize)]
struct ArchiveColumnSchema {
    name: String,
    data_type: String,
    nullable: bool,
}

pub fn router(state: AdminApiState) -> Router {
    Router::new()
        .route("/api/admin/v1/archive-schema", get(archive_schema))
        .route("/api/admin/v1/data-loads", post(stage))
        .route(
            "/api/admin/v1/data-loads/{load_id}",
            get(status).delete(discard),
        )
        .route("/api/admin/v1/data-loads/{load_id}/commit", post(commit))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            authenticate_admin,
        ))
        .layer(axum::middleware::from_fn(observe_data_load_operation))
        .layer(DefaultBodyLimit::max(MAX_DATA_LOAD_BYTES))
        .with_state(state)
}

async fn observe_data_load_operation(request: Request, next: Next) -> Response {
    let mutating = matches!(
        *request.method(),
        Method::POST | Method::DELETE | Method::PUT | Method::PATCH
    );
    let response = next.run(request).await;
    if mutating {
        crate::metrics::observe_data_load_operation(response.status().is_success());
    }
    response
}

async fn authenticate_admin(
    State(state): State<AdminApiState>,
    request: Request,
    next: Next,
) -> Response {
    let supplied = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty());
    let valid = supplied.is_some_and(|token| {
        let hash: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        bool::from(hash.ct_eq(&state.token_hash))
    });
    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                detail: "Admin authentication required.".to_owned(),
            }),
        )
            .into_response();
    }
    next.run(request).await
}

async fn archive_schema(
    State(state): State<AdminApiState>,
) -> Result<Json<ArchiveSchemaResponse>, ApiError> {
    let rows = archive_schema_columns(&state.pool)
        .await
        .map_err(map_data_load_error)?;
    let mut columns = BTreeMap::<String, Vec<ArchiveColumnSchema>>::new();
    for row in rows {
        columns
            .entry(row.table_name)
            .or_default()
            .push(ArchiveColumnSchema {
                name: row.column_name,
                data_type: row.data_type,
                nullable: row.is_nullable == "YES",
            });
    }
    let tables = BACKUP_TABLES
        .iter()
        .map(|name| ArchiveTableSchema {
            name: (*name).to_owned(),
            json_path: format!("tables/{name}.json"),
            csv_path: format!("csv/{name}.csv"),
            columns: columns.remove(*name).unwrap_or_default(),
        })
        .collect();
    Ok(Json(ArchiveSchemaResponse {
        format: ARCHIVE_FORMAT,
        format_version: BACKUP_FORMAT_VERSION,
        schema_version: BACKUP_SCHEMA_VERSION,
        maximum_archive_bytes: MAX_DATA_LOAD_BYTES,
        multipart_field: "file",
        idempotency_header: "Idempotency-Key",
        manifest_path: "manifest.json",
        table_json_path_pattern: "tables/{table}.json",
        table_csv_path_pattern: "csv/{table}.csv",
        tables,
    }))
}

async fn stage(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<DataLoadResponse>, ApiError> {
    let idempotency_key = headers
        .get(IDEMPOTENCY_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 200)
        .ok_or_else(|| validation("A valid Idempotency-Key header is required."))?
        .to_owned();
    let bytes = multipart_bytes(&mut multipart).await?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let parse_bytes = bytes.clone();
    let snapshot = {
        let _permit = crate::blocking_permit().await?;
        tokio::task::spawn_blocking(move || parse_archive(&parse_bytes))
            .await
            .map_err(task_failure)?
            .map_err(|error| validation(format!("Data-load archive is invalid: {error}")))?
    };
    validate_staged_snapshot(&state.pool, &snapshot)
        .await
        .map_err(map_data_load_error)?;
    if let Some(existing) =
        load_by_idempotency(&state.pool, snapshot.household_id, &idempotency_key)
            .await
            .map_err(map_data_load_error)?
    {
        if existing.archive_sha256 != digest {
            return Err(conflict(
                "The idempotency key already belongs to a different archive.",
            ));
        }
        return Ok(Json(response(existing)));
    }

    let load_id = Uuid::now_v7();
    let path = staging_path(&state.staging_root, snapshot.household_id, load_id)?;
    let cleanup_path = path.clone();
    let archive_path = path.to_string_lossy().into_owned();
    {
        let _permit = crate::blocking_permit().await?;
        tokio::task::spawn_blocking(move || write_staged_file(&path, &bytes))
            .await
            .map_err(task_failure)?
            .map_err(storage_io)?;
    }

    let run = NewDataLoadRun {
        id: load_id,
        household_id: snapshot.household_id,
        idempotency_key,
        archive_version: i32::try_from(snapshot.format_version).unwrap_or(i32::MAX),
        counts: snapshot_counts(&snapshot),
        archive_path,
        archive_sha256: digest,
    };
    let row = match create_validated_run(&state.pool, run).await {
        Ok(row) => row,
        Err(error) => {
            remove_staged_file(cleanup_path).await;
            return Err(map_data_load_error(error));
        }
    };
    Ok(Json(response(row)))
}

async fn status(
    State(state): State<AdminApiState>,
    AxumPath(load_id): AxumPath<Uuid>,
) -> Result<Json<DataLoadResponse>, ApiError> {
    Ok(Json(response(
        load_row(&state.pool, load_id)
            .await
            .map_err(map_data_load_error)?,
    )))
}

async fn commit(
    State(state): State<AdminApiState>,
    AxumPath(load_id): AxumPath<Uuid>,
) -> Result<Json<CommitResponse>, ApiError> {
    let (row, archive_path) = load_commit_candidate(&state.pool, load_id)
        .await
        .map_err(map_data_load_error)?;
    if row.status == "committed" {
        return Ok(Json(CommitResponse {
            load: response(row),
            restored: BTreeMap::new(),
        }));
    }
    if row.status != "validated" {
        return Err(conflict("Only a validated data load can be committed."));
    }
    let path = checked_staging_path(&state.staging_root, &archive_path)?;
    let _permit = crate::blocking_permit().await?;
    let bytes = tokio::task::spawn_blocking(move || fs::read(path))
        .await
        .map_err(task_failure)?
        .map_err(storage_io)?;
    if format!("{:x}", Sha256::digest(&bytes)) != row.archive_sha256 {
        return Err(conflict(
            "The staged archive no longer matches its validated checksum.",
        ));
    }
    let _permit = crate::blocking_permit().await?;
    let snapshot = tokio::task::spawn_blocking(move || parse_archive(&bytes))
        .await
        .map_err(task_failure)?
        .map_err(|error| validation(format!("Data-load archive is invalid: {error}")))?;
    if snapshot.household_id != row.household_id {
        return Err(conflict("The staged archive household has changed."));
    }
    validate_staged_snapshot(&state.pool, &snapshot)
        .await
        .map_err(map_data_load_error)?;
    let result = commit_validated_run(&state.pool, load_id, &row.archive_sha256, &snapshot)
        .await
        .map_err(map_data_load_error)?;
    Ok(Json(CommitResponse {
        load: response(result.row),
        restored: result.restored,
    }))
}

async fn discard(
    State(state): State<AdminApiState>,
    AxumPath(load_id): AxumPath<Uuid>,
) -> Result<Json<DataLoadResponse>, ApiError> {
    let (row, archive_path) = discard_run(&state.pool, load_id)
        .await
        .map_err(map_data_load_error)?;
    let path = checked_staging_path(&state.staging_root, &archive_path)?;
    let _permit = crate::blocking_permit().await?;
    tokio::task::spawn_blocking(move || match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    })
    .await
    .map_err(task_failure)?
    .map_err(storage_io)?;
    Ok(Json(response(row)))
}

async fn multipart_bytes(multipart: &mut Multipart) -> Result<Vec<u8>, ApiError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| validation("The data-load upload is not valid multipart data."))?
    {
        if field.name() == Some("file") {
            let bytes = field
                .bytes()
                .await
                .map_err(|_| validation("The data-load archive could not be read."))?;
            if bytes.is_empty() {
                return Err(validation("The data-load archive is empty."));
            }
            return Ok(bytes.to_vec());
        }
    }
    Err(validation("A multipart field named 'file' is required."))
}

fn staging_path(root: &Path, household_id: Uuid, load_id: Uuid) -> Result<PathBuf, ApiError> {
    let directory = root.join(household_id.to_string());
    let path = directory.join(format!("{load_id}.zip"));
    checked_staging_path(root, &path.to_string_lossy())
}

fn checked_staging_path(root: &Path, value: &str) -> Result<PathBuf, ApiError> {
    let path = PathBuf::from(value);
    if !path.is_absolute() || !path.starts_with(root) {
        return Err(validation("The staged archive path is invalid."));
    }
    Ok(path)
}

fn write_staged_file(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let Some(parent) = path.parent() else {
        return Err(std::io::Error::other("staging path has no parent"));
    };
    fs::create_dir_all(parent)?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

async fn remove_staged_file(path: PathBuf) {
    let Ok(_permit) = crate::blocking_permit().await else {
        return;
    };
    let _ = tokio::task::spawn_blocking(move || fs::remove_file(path)).await;
}

fn response(row: DataLoadRunRecord) -> DataLoadResponse {
    DataLoadResponse {
        id: row.id,
        household_id: row.household_id,
        idempotency_key: row.idempotency_key,
        status: row.status,
        archive_version: row.archive_version,
        counts: row.counts,
        warnings: row.warnings,
        errors: row.errors,
        archive_sha256: row.archive_sha256,
        committed_at: row.committed_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn validation(detail: impl Into<String>) -> ApiError {
    ApiError(ApplicationError::Validation(detail.into()))
}

fn conflict(detail: impl Into<String>) -> ApiError {
    ApiError(ApplicationError::ConflictMessage(detail.into()))
}

fn map_data_load_error(error: DataLoadStoreError) -> ApiError {
    match error {
        DataLoadStoreError::Validation(detail) => validation(detail),
        DataLoadStoreError::Conflict(detail) => conflict(detail),
        DataLoadStoreError::NotFound => ApiError(ApplicationError::NotFoundMessage(
            "Data load not found.".to_owned(),
        )),
        DataLoadStoreError::Database(error) => {
            tracing::error!(%error, "data-load database operation failed");
            ApiError(ApplicationError::Storage)
        }
    }
}

fn storage_io(error: std::io::Error) -> ApiError {
    tracing::error!(%error, "data-load staging filesystem operation failed");
    ApiError(ApplicationError::Storage)
}

fn task_failure(error: tokio::task::JoinError) -> ApiError {
    tracing::error!(%error, "data-load blocking task failed");
    ApiError(ApplicationError::Storage)
}
