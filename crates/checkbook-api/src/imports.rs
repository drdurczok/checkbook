use axum::{Json, extract::State, http::HeaderMap};
use checkbook_application::ApplicationError;
use checkbook_postgres::bulk_import::{BulkImportError, BulkImportRequest, run_bulk_import};
use checkbook_postgres::imports::{
    DataLoadHistoryRecord, RawDataTableRecord, data_load_history, raw_data as load_raw_data,
};
use serde_json::{Value, json};

use crate::{
    ApiState,
    auth::{authenticated, require_permission},
    dto::{ImportRunResponse, RawDataColumn, RawDataResponse, RawDataTable},
    error::ApiError,
};

#[utoipa::path(
    get,
    path = "/api/imports/history",
    responses((status = 200, body = [ImportRunResponse]))
)]
pub async fn history(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ImportRunResponse>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "imports", "read")?;
    let rows = data_load_history(&state.pool, context.household.id)
        .await
        .map_err(storage)?;
    Ok(Json(rows.into_iter().map(import_response).collect()))
}

#[utoipa::path(
    get,
    path = "/api/imports/raw-data",
    responses((status = 200, body = RawDataResponse))
)]
pub async fn raw_data(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<RawDataResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "imports", "read")?;
    let tables = load_raw_data(&state.pool, context.household.id)
        .await
        .map_err(storage)?
        .into_iter()
        .map(raw_table_response)
        .collect();
    Ok(Json(RawDataResponse { tables }))
}

/// Generic typed bulk-import endpoint. Integration-agnostic: callers submit
/// already-normalised, typed domain records. No source-specific connector is
/// exposed yet; this is the single entry point future integration plugins target.
///
/// Documented via the `API_OPERATIONS` table (see `lib.rs`) rather than a
/// `#[utoipa::path]` macro, so the typed request body does not need `ToSchema`.
pub async fn bulk(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<BulkImportRequest>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "imports", "write")?;
    let outcome = run_bulk_import(&state.pool, context.household.id, payload)
        .await
        .map_err(map_bulk_error)?;
    Ok(Json(json!({
        "run_id": outcome.run_id,
        "counts": outcome.counts,
    })))
}

fn map_bulk_error(error: BulkImportError) -> ApiError {
    match error {
        BulkImportError::Validation(detail) => ApiError(ApplicationError::Validation(detail)),
        other => {
            tracing::error!(error = %other, "bulk import failed");
            ApiError(ApplicationError::Storage)
        }
    }
}

fn raw_table_response(table: RawDataTableRecord) -> RawDataTable {
    RawDataTable {
        key: table.key,
        label: table.label,
        count: table.count,
        columns: table
            .columns
            .into_iter()
            .map(|column| RawDataColumn {
                key: column.key,
                label: column.label,
            })
            .collect(),
        rows: table.rows,
    }
}

fn import_response(row: DataLoadHistoryRecord) -> ImportRunResponse {
    ImportRunResponse {
        id: row.id,
        source_type: "bulk_archive".to_owned(),
        status: row.status,
        counts: row.counts,
        warnings: row.warnings,
        started_at: row.started_at,
        finished_at: row.finished_at,
    }
}

fn storage(error: sqlx::Error) -> ApiError {
    tracing::error!(%error, "import API database operation failed");
    ApiError(ApplicationError::Storage)
}
