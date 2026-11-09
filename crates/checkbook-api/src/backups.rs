use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path as FilePath, PathBuf},
};

use axum::{
    Json,
    extract::{DefaultBodyLimit, Multipart, Path, State},
    http::{
        HeaderMap, HeaderValue,
        header::{CONTENT_DISPOSITION, CONTENT_TYPE},
    },
    response::{IntoResponse, Response},
};
use checkbook_application::ApplicationError;
use checkbook_postgres::{
    archive::{BackupArchiveError, build_archive, parse_archive},
    backup::{BackupStoreError, restore_household, snapshot_household},
    settings::{load_backup_config, update_backup_config},
};
use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::{
    ApiState,
    auth::{authenticated, require_permission},
    dto::{
        BackupConfigPayload, BackupConfigResponse, BackupEntry, BackupRestoreResponse,
        BackupTestResponse,
    },
    error::ApiError,
};

const MAX_BACKUP_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
const MAX_CONFIG_PATH_BYTES: usize = 4096;

pub fn import_body_limit() -> DefaultBodyLimit {
    DefaultBodyLimit::max(MAX_BACKUP_UPLOAD_BYTES)
}

#[utoipa::path(
    get,
    path = "/api/backups/config",
    responses((status = 200, body = BackupConfigResponse))
)]
pub async fn get_config(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<BackupConfigResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    Ok(Json(load_config(&state, context.household.id).await?))
}

#[utoipa::path(
    put,
    path = "/api/backups/config",
    request_body = BackupConfigPayload,
    responses((status = 200, body = BackupConfigResponse))
)]
pub async fn update_config(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<BackupConfigPayload>,
) -> Result<Json<BackupConfigResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let payload = normalize_config(payload)?;
    let admin_root = require_admin_root(&state)?;
    let configured_path = payload.path.clone();
    let _blocking_permit = crate::blocking_permit().await?;
    tokio::task::spawn_blocking(move || {
        resolve_configured_root(&admin_root, &configured_path, false)
    })
    .await
    .map_err(task_failure)?
    .map_err(backup_bad_request)?;
    update_backup_config(
        &state.pool,
        context.household.id,
        &payload.path,
        payload.retention,
    )
    .await
    .map_err(storage)?;
    Ok(Json(payload))
}

#[utoipa::path(
    post,
    path = "/api/backups/test",
    request_body = BackupConfigPayload,
    responses((status = 200, body = BackupTestResponse))
)]
pub async fn test_location(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<BackupConfigPayload>,
) -> Result<Json<BackupTestResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let payload = normalize_config(payload)?;
    let Some(admin_root) = state.backup_admin_root.clone() else {
        return Ok(Json(BackupTestResponse {
            ok: false,
            message: "Backup storage is not configured by the server administrator.".to_owned(),
        }));
    };
    let configured_path = payload.path;
    let household_id = context.household.id;
    let _blocking_permit = crate::blocking_permit().await?;
    let result = tokio::task::spawn_blocking(move || {
        let directory =
            resolve_household_directory(&admin_root, &configured_path, household_id, true)?;
        let probe = directory.join(format!(".checkbook-write-test-{}", Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .map_err(BackupFileError::Io)?;
        file.write_all(b"ok").map_err(BackupFileError::Io)?;
        file.sync_all().map_err(BackupFileError::Io)?;
        fs::remove_file(&probe).map_err(BackupFileError::Io)?;
        Ok::<_, BackupFileError>(directory)
    })
    .await
    .map_err(task_failure)?;
    Ok(Json(match result {
        Ok(directory) => BackupTestResponse {
            ok: true,
            message: format!(
                "Connected — backups will be stored in {}",
                directory.display()
            ),
        },
        Err(error) => BackupTestResponse {
            ok: false,
            message: error.to_string(),
        },
    }))
}

#[utoipa::path(
    get,
    path = "/api/backups",
    responses((status = 200, body = [BackupEntry]))
)]
pub async fn list(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<BackupEntry>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let config = load_config(&state, context.household.id).await?;
    let admin_root = require_admin_root(&state)?;
    let _blocking_permit = crate::blocking_permit().await?;
    let entries = tokio::task::spawn_blocking(move || {
        let directory =
            resolve_household_directory(&admin_root, &config.path, context.household.id, false)?;
        list_backup_files(&directory)
    })
    .await
    .map_err(task_failure)?
    .map_err(backup_bad_request)?;
    Ok(Json(entries))
}

#[utoipa::path(
    post,
    path = "/api/backups",
    responses((status = 200, body = BackupEntry))
)]
pub async fn create(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<BackupEntry>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let config = load_config(&state, context.household.id).await?;
    let snapshot = snapshot_household(&state.pool, context.household.id)
        .await
        .map_err(map_store_error)?;
    let _blocking_permit = crate::blocking_permit().await?;
    let archive = tokio::task::spawn_blocking(move || build_archive(&snapshot))
        .await
        .map_err(task_failure)?
        .map_err(map_archive_error)?;
    let admin_root = require_admin_root(&state)?;
    let _blocking_permit = crate::blocking_permit().await?;
    let entry = tokio::task::spawn_blocking(move || {
        let directory =
            resolve_household_directory(&admin_root, &config.path, context.household.id, true)?;
        let entry = write_backup(&directory, &archive)?;
        prune_backups(&directory, config.retention)?;
        Ok::<_, BackupFileError>(entry)
    })
    .await
    .map_err(task_failure)?
    .map_err(|error| {
        crate::metrics::observe_backup(false);
        backup_bad_request(error)
    })?;
    crate::metrics::observe_backup(true);
    Ok(Json(entry))
}

pub async fn export_csv(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let snapshot = snapshot_household(&state.pool, context.household.id)
        .await
        .map_err(map_store_error)?;
    let _blocking_permit = crate::blocking_permit().await?;
    let archive = tokio::task::spawn_blocking(move || build_archive(&snapshot))
        .await
        .map_err(task_failure)?
        .map_err(map_archive_error)?;
    let short_id = context
        .household
        .id
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>();
    download_response(
        archive,
        &format!("checkbook-export-{short_id}.zip"),
        "application/zip",
    )
}

pub async fn download(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Response, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let config = load_config(&state, context.household.id).await?;
    let admin_root = require_admin_root(&state)?;
    let download_name = name.clone();
    let _blocking_permit = crate::blocking_permit().await?;
    let bytes = tokio::task::spawn_blocking(move || {
        let directory =
            resolve_household_directory(&admin_root, &config.path, context.household.id, false)?;
        read_backup(&directory, &name)
    })
    .await
    .map_err(task_failure)?
    .map_err(map_file_read_error)?;
    download_response(bytes, &download_name, "application/zip")
}

pub async fn delete(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<BackupRestoreResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let config = load_config(&state, context.household.id).await?;
    let admin_root = require_admin_root(&state)?;
    let _blocking_permit = crate::blocking_permit().await?;
    tokio::task::spawn_blocking(move || {
        let directory =
            resolve_household_directory(&admin_root, &config.path, context.household.id, false)?;
        delete_backup(&directory, &name)
    })
    .await
    .map_err(task_failure)?
    .map_err(backup_bad_request)?;
    Ok(Json(BackupRestoreResponse {
        ok: true,
        restored: BTreeMap::new(),
    }))
}

pub async fn restore(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<BackupRestoreResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let config = load_config(&state, context.household.id).await?;
    let admin_root = require_admin_root(&state)?;
    let _blocking_permit = crate::blocking_permit().await?;
    let bytes = tokio::task::spawn_blocking(move || {
        let directory =
            resolve_household_directory(&admin_root, &config.path, context.household.id, false)?;
        read_backup(&directory, &name)
    })
    .await
    .map_err(task_failure)?
    .map_err(map_file_read_error)?;
    restore_bytes(&state, &context, bytes, "Restore failed").await
}

pub async fn import(
    State(state): State<ApiState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<BackupRestoreResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let mut upload = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| bad_request("Import failed: invalid multipart upload."))?
    {
        if field.name() == Some("file") {
            let bytes = field
                .bytes()
                .await
                .map_err(|_| bad_request("Import failed: uploaded file could not be read."))?;
            upload = Some(bytes);
            break;
        }
    }
    let bytes = upload.ok_or_else(|| bad_request("The uploaded file is empty."))?;
    if bytes.is_empty() {
        return Err(bad_request("The uploaded file is empty."));
    }
    restore_bytes(&state, &context, bytes.to_vec(), "Import failed").await
}

async fn restore_bytes(
    state: &ApiState,
    context: &checkbook_postgres::auth::SessionContext,
    bytes: Vec<u8>,
    operation: &str,
) -> Result<Json<BackupRestoreResponse>, ApiError> {
    let _blocking_permit = crate::blocking_permit().await?;
    let snapshot = tokio::task::spawn_blocking(move || parse_archive(&bytes))
        .await
        .map_err(task_failure)?
        .map_err(|error| bad_request(format!("{operation}: {error}")))?;
    let restored = restore_household(
        &state.pool,
        context.household.id,
        context.user.id,
        &snapshot,
    )
    .await
    .map_err(|error| {
        crate::metrics::observe_backup(false);
        match error {
            BackupStoreError::Validation(detail) => bad_request(format!("{operation}: {detail}")),
            BackupStoreError::Database(error) => {
                tracing::error!(%error, "backup restore failed");
                ApiError(ApplicationError::Storage)
            }
        }
    })?;
    crate::metrics::observe_backup(true);
    Ok(Json(BackupRestoreResponse { ok: true, restored }))
}

async fn load_config(
    state: &ApiState,
    household_id: Uuid,
) -> Result<BackupConfigResponse, ApiError> {
    let config = load_backup_config(&state.pool, household_id)
        .await
        .map_err(storage)?;
    Ok(BackupConfigResponse {
        path: config.path,
        retention: config.retention,
    })
}

fn normalize_config(mut payload: BackupConfigPayload) -> Result<BackupConfigResponse, ApiError> {
    payload.path = payload.path.trim().to_owned();
    if payload.path.len() > MAX_CONFIG_PATH_BYTES {
        return Err(ApiError(ApplicationError::Validation(
            "Backup path is too long.".to_owned(),
        )));
    }
    if !(0..=365).contains(&payload.retention) {
        return Err(ApiError(ApplicationError::Validation(
            "Backup retention must be between 0 and 365.".to_owned(),
        )));
    }
    Ok(payload)
}

fn require_admin_root(state: &ApiState) -> Result<PathBuf, ApiError> {
    state
        .backup_admin_root
        .clone()
        .ok_or_else(|| bad_request("Backup storage is not configured by the server administrator."))
}

fn resolve_household_directory(
    admin_root: &FilePath,
    configured_path: &str,
    household_id: Uuid,
    create: bool,
) -> Result<PathBuf, BackupFileError> {
    let root = resolve_configured_root(admin_root, configured_path, create)?;
    let directory = root.join(household_id.to_string());
    if create {
        fs::create_dir_all(&directory).map_err(BackupFileError::Io)?;
        ensure_canonical_within(admin_root, &directory)?;
    }
    Ok(directory)
}

fn resolve_configured_root(
    admin_root: &FilePath,
    configured_path: &str,
    create: bool,
) -> Result<PathBuf, BackupFileError> {
    let admin_root = admin_root.canonicalize().map_err(BackupFileError::Io)?;
    let supplied = FilePath::new(configured_path);
    if supplied
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(BackupFileError::InvalidPath);
    }
    let candidate = if configured_path.is_empty() {
        admin_root.clone()
    } else if supplied.is_absolute() {
        supplied.to_owned()
    } else {
        admin_root.join(supplied)
    };
    ensure_existing_ancestor_within(&admin_root, &candidate)?;
    if create {
        fs::create_dir_all(&candidate).map_err(BackupFileError::Io)?;
        ensure_canonical_within(&admin_root, &candidate)?;
    }
    Ok(candidate)
}

fn ensure_existing_ancestor_within(
    admin_root: &FilePath,
    candidate: &FilePath,
) -> Result<(), BackupFileError> {
    let mut ancestor = candidate;
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or(BackupFileError::InvalidPath)?;
    }
    ensure_canonical_within(admin_root, ancestor)
}

fn ensure_canonical_within(
    admin_root: &FilePath,
    candidate: &FilePath,
) -> Result<(), BackupFileError> {
    let canonical = candidate.canonicalize().map_err(BackupFileError::Io)?;
    if canonical.starts_with(admin_root) {
        Ok(())
    } else {
        Err(BackupFileError::OutsideAdminRoot)
    }
}

fn list_backup_files(directory: &FilePath) -> Result<Vec<BackupEntry>, BackupFileError> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for item in fs::read_dir(directory).map_err(BackupFileError::Io)? {
        let item = item.map_err(BackupFileError::Io)?;
        let name = item.file_name().to_string_lossy().into_owned();
        if !valid_backup_name(&name) {
            continue;
        }
        let file_type = item.file_type().map_err(BackupFileError::Io)?;
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let metadata = item.metadata().map_err(BackupFileError::Io)?;
        let created_at = metadata
            .modified()
            .map(DateTime::<Utc>::from)
            .map_err(BackupFileError::Io)?
            .to_rfc3339();
        entries.push(BackupEntry {
            name,
            size: metadata.len(),
            created_at,
        });
    }
    entries.sort_by(|left, right| right.name.cmp(&left.name));
    Ok(entries)
}

fn write_backup(directory: &FilePath, bytes: &[u8]) -> Result<BackupEntry, BackupFileError> {
    let suffix = Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>();
    let name = format!(
        "checkbook-backup-{}-{suffix}.zip",
        Utc::now().format("%Y%m%d-%H%M%S")
    );
    let path = directory.join(&name);
    let temporary = directory.join(format!(".{name}.{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(BackupFileError::Io)?;
    file.write_all(bytes).map_err(BackupFileError::Io)?;
    file.sync_all().map_err(BackupFileError::Io)?;
    fs::rename(&temporary, &path).map_err(BackupFileError::Io)?;
    let metadata = fs::metadata(&path).map_err(BackupFileError::Io)?;
    Ok(BackupEntry {
        name,
        size: metadata.len(),
        created_at: metadata
            .modified()
            .map(DateTime::<Utc>::from)
            .map_err(BackupFileError::Io)?
            .to_rfc3339(),
    })
}

fn prune_backups(directory: &FilePath, retention: i32) -> Result<(), BackupFileError> {
    if retention <= 0 {
        return Ok(());
    }
    let entries = list_backup_files(directory)?;
    for entry in entries
        .into_iter()
        .skip(usize::try_from(retention).map_err(|_| BackupFileError::InvalidRetention)?)
    {
        fs::remove_file(directory.join(entry.name)).map_err(BackupFileError::Io)?;
    }
    Ok(())
}

fn read_backup(directory: &FilePath, name: &str) -> Result<Vec<u8>, BackupFileError> {
    if !valid_backup_name(name) {
        return Err(BackupFileError::InvalidName);
    }
    let path = directory.join(name);
    let metadata = checked_backup_file(directory, &path).map_err(|error| {
        if matches!(
            &error,
            BackupFileError::Io(io_error)
                if io_error.kind() == std::io::ErrorKind::NotFound
        ) {
            BackupFileError::NotFound
        } else {
            error
        }
    })?;
    if metadata.len() > MAX_BACKUP_UPLOAD_BYTES as u64 {
        return Err(BackupFileError::Limit);
    }
    fs::read(path).map_err(BackupFileError::Io)
}

fn checked_backup_file(
    directory: &FilePath,
    path: &FilePath,
) -> Result<std::fs::Metadata, BackupFileError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            BackupFileError::NotFound
        } else {
            BackupFileError::Io(error)
        }
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(BackupFileError::InvalidPath);
    }
    let directory = directory.canonicalize().map_err(BackupFileError::Io)?;
    let canonical = path.canonicalize().map_err(BackupFileError::Io)?;
    if !canonical.starts_with(directory) {
        return Err(BackupFileError::OutsideAdminRoot);
    }
    Ok(metadata)
}

fn delete_backup(directory: &FilePath, name: &str) -> Result<(), BackupFileError> {
    if !valid_backup_name(name) {
        return Err(BackupFileError::InvalidName);
    }
    let path = directory.join(name);
    match checked_backup_file(directory, &path) {
        Ok(_) => {}
        Err(BackupFileError::NotFound) => return Ok(()),
        Err(error) => return Err(error),
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(BackupFileError::Io(error)),
    }
}

fn valid_backup_name(name: &str) -> bool {
    let Some(body) = name
        .strip_prefix("checkbook-backup-")
        .and_then(|name| name.strip_suffix(".zip"))
    else {
        return false;
    };
    let parts = body.split('-').collect::<Vec<_>>();
    parts.len() == 3
        && parts[0].len() == 8
        && parts[0].bytes().all(|byte| byte.is_ascii_digit())
        && parts[1].len() == 6
        && parts[1].bytes().all(|byte| byte.is_ascii_digit())
        && parts[2].len() == 8
        && parts[2].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn download_response(bytes: Vec<u8>, name: &str, mime: &str) -> Result<Response, ApiError> {
    let disposition = HeaderValue::from_str(&format!("attachment; filename=\"{name}\""))
        .map_err(|_| ApiError(ApplicationError::Storage))?;
    let content_type =
        HeaderValue::from_str(mime).map_err(|_| ApiError(ApplicationError::Storage))?;
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, content_type);
    headers.insert(CONTENT_DISPOSITION, disposition);
    Ok((headers, bytes).into_response())
}

fn map_store_error(error: BackupStoreError) -> ApiError {
    match error {
        BackupStoreError::Validation(detail) => bad_request(detail),
        BackupStoreError::Database(error) => {
            tracing::error!(%error, "backup database operation failed");
            ApiError(ApplicationError::Storage)
        }
    }
}

fn map_archive_error(error: BackupArchiveError) -> ApiError {
    tracing::error!(%error, "backup archive operation failed");
    ApiError(ApplicationError::Storage)
}

fn map_file_read_error(error: BackupFileError) -> ApiError {
    match error {
        BackupFileError::NotFound => ApiError(ApplicationError::NotFoundMessage(
            "Backup not found.".to_owned(),
        )),
        error => backup_bad_request(error),
    }
}

fn backup_bad_request(error: BackupFileError) -> ApiError {
    bad_request(error.to_string())
}

fn bad_request(detail: impl Into<String>) -> ApiError {
    ApiError(ApplicationError::BadRequest(detail.into()))
}

fn storage(error: sqlx::Error) -> ApiError {
    tracing::error!(%error, "backup API database operation failed");
    ApiError(ApplicationError::Storage)
}

fn task_failure(error: tokio::task::JoinError) -> ApiError {
    tracing::error!(%error, "backup blocking task failed");
    ApiError(ApplicationError::Storage)
}

#[derive(Debug, thiserror::Error)]
enum BackupFileError {
    #[error("Invalid backup path.")]
    InvalidPath,
    #[error("Backup path must stay within the administrator-approved root.")]
    OutsideAdminRoot,
    #[error("Invalid backup name.")]
    InvalidName,
    #[error("Backup not found.")]
    NotFound,
    #[error("Backup exceeds the 64 MiB compressed size limit.")]
    Limit,
    #[error("Backup retention is invalid.")]
    InvalidRetention,
    #[error("Backup storage operation failed: {0}")]
    Io(std::io::Error),
}

#[cfg(test)]
mod tests {
    use super::valid_backup_name;

    #[cfg(unix)]
    use super::{BackupFileError, delete_backup, list_backup_files, read_backup};
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use uuid::Uuid;

    #[test]
    fn backup_names_cannot_escape_the_household_directory() {
        assert!(valid_backup_name(
            "checkbook-backup-20260622-070000-a1b2c3d4.zip"
        ));
        assert!(!valid_backup_name(
            "../checkbook-backup-20260622-070000.zip"
        ));
        assert!(!valid_backup_name(
            "checkbook-backup-20260622-070000-a1b2c3d4.json"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn backup_file_operations_reject_symlinks_with_valid_names()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = std::env::temp_dir().join(format!("checkbook-backup-test-{}", Uuid::new_v4()));
        let directory = root.join("household");
        fs::create_dir_all(&directory)?;
        let outside = root.join("outside.zip");
        fs::write(&outside, b"outside")?;
        let link_name = "checkbook-backup-20260622-070000-a1b2c3d4.zip";
        let link_path = directory.join(link_name);
        std::os::unix::fs::symlink(&outside, &link_path)?;

        assert!(list_backup_files(&directory)?.is_empty());
        assert!(matches!(
            read_backup(&directory, link_name),
            Err(BackupFileError::InvalidPath)
        ));
        assert!(matches!(
            delete_backup(&directory, link_name),
            Err(BackupFileError::InvalidPath)
        ));
        assert!(link_path.exists());

        fs::remove_dir_all(root)?;
        Ok(())
    }
}
