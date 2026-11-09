use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use checkbook_application::ApplicationError;
use checkbook_domain::{local_date_at, month_start_at};
use checkbook_postgres::utilities::{
    ManualUtilityInput, TrackedFieldRecord, UtilityBoardMonthRecord, UtilityBoardRecord,
    UtilityBoardSubjectRecord, UtilityEntryFormFieldRecord, UtilityEntryFormRecord,
    UtilityEntryValueInput, UtilityFieldStateRecord, UtilitySeriesPointRecord, UtilityStoreError,
    UtilityUpsertInput, board as store_board, create_manual as store_create_manual,
    field_catalog as store_field_catalog, form as store_form, upsert as store_upsert,
};
use checkbook_postgres::utility_contracts;
use chrono::{NaiveDate, Utc};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::{
    ApiState,
    auth::{allowed_scope_values, authenticated, require_permission, require_scope_access},
    dto::{
        ManualRecordResponse, ManualUtilityCreate, TrackedField, UtilityBoardMonth,
        UtilityBoardResponse, UtilityBoardSubject, UtilityEntriesUpsert, UtilityEntryFormField,
        UtilityEntryFormResponse, UtilityFieldLinkRequest, UtilityFieldState,
        UtilityReassignRequest, UtilitySeriesPoint,
    },
    error::ApiError,
};

#[derive(Debug, Default, Deserialize)]
pub struct SubjectQuery {
    property_id: Option<Uuid>,
    group_id: Option<Uuid>,
    months: Option<i32>,
    month: Option<String>,
}

pub async fn field_catalog(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<TrackedField>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let fields = store_field_catalog(&state.pool, context.household.id)
        .await
        .map_err(map_utility_store_error)?
        .into_iter()
        .map(tracked_field)
        .collect();
    Ok(Json(fields))
}

pub async fn board(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<SubjectQuery>,
) -> Result<Json<UtilityBoardResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let current_month = household_current_month(&context.household.timezone)?;
    let scopes = allowed_scope_values(&context);
    let response = store_board(
        &state.pool,
        context.household.id,
        query.property_id,
        query.group_id,
        query.months.unwrap_or(12),
        current_month,
        &scopes,
    )
    .await
    .map_err(map_utility_store_error)
    .map(board_response)?;
    Ok(Json(response))
}

pub async fn form(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<SubjectQuery>,
) -> Result<Json<UtilityEntryFormResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let current_month = household_current_month(&context.household.timezone)?;
    let scopes = allowed_scope_values(&context);
    let month = query
        .month
        .unwrap_or_else(|| current_month.format("%Y-%m").to_string());
    let month_start = parse_month(&month)?;
    let response = store_form(
        &state.pool,
        context.household.id,
        query.property_id,
        query.group_id,
        month,
        month_start,
        &scopes,
    )
    .await
    .map_err(map_utility_store_error)
    .map(form_response)?;
    Ok(Json(response))
}

pub async fn upsert(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<SubjectQuery>,
    Json(payload): Json<UtilityEntriesUpsert>,
) -> Result<Json<UtilityBoardResponse>, ApiError> {
    let month_start = parse_month(&payload.month)?;
    for entry in &payload.entries {
        if entry.amount.is_some_and(|amount| amount.is_sign_negative())
            || entry
                .meter_reading
                .is_some_and(|reading| reading.is_sign_negative())
        {
            return Err(ApiError(ApplicationError::Validation(
                "Utility values must not be negative.".to_owned(),
            )));
        }
    }
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let current_month = household_current_month(&context.household.timezone)?;
    let scopes = allowed_scope_values(&context);
    let response = store_upsert(
        &state.pool,
        context.household.id,
        query.property_id,
        query.group_id,
        UtilityUpsertInput {
            month: payload.month,
            completed: payload.completed,
            month_start,
            entries: payload
                .entries
                .into_iter()
                .map(|entry| UtilityEntryValueInput {
                    amount_source: entry.amount_source,
                    usage_amount: entry.usage_amount,
                    field_key: entry.field_key,
                    amount: entry.amount,
                    meter_reading: entry.meter_reading,
                })
                .collect(),
            base_currency: context.household.base_currency.clone(),
            household_timezone: context.household.timezone.clone(),
        },
        current_month,
        &scopes,
    )
    .await
    .map_err(map_utility_store_error)
    .map(board_response)?;
    Ok(Json(response))
}

pub async fn track_field(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(_payload): Json<UtilityFieldLinkRequest>,
) -> Result<Json<UtilityBoardResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    Err(legacy_configuration_error())
}

pub async fn untrack_field(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(_payload): Json<UtilityFieldLinkRequest>,
) -> Result<Json<UtilityBoardResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "delete")?;
    Err(legacy_configuration_error())
}

pub async fn reassign(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(_payload): Json<UtilityReassignRequest>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    Err(ApiError(ApplicationError::Validation(
        "Utility contract property ownership is immutable; create a new contract for another property."
            .to_owned(),
    )))
}

pub async fn create_manual(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<ManualUtilityCreate>,
) -> Result<Json<ManualRecordResponse>, ApiError> {
    if payload.description.trim().is_empty()
        || payload.amount.is_sign_negative()
        || payload
            .usage_amount
            .is_some_and(|value| value.is_sign_negative())
        || payload
            .meter_reading
            .is_some_and(|value| value.is_sign_negative())
    {
        return Err(ApiError(ApplicationError::Validation(
            "Utility details are invalid.".to_owned(),
        )));
    }
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    require_scope_access(&context, &payload.owner_scope)?;
    let record = store_create_manual(
        &state.pool,
        context.household.id,
        ManualUtilityInput {
            provider: payload.provider,
            description: payload.description.trim().to_owned(),
            amount: payload.amount,
            charge_date: payload.charge_date,
            owner_scope: payload.owner_scope,
            property_id: payload.property_id,
            group_id: payload.group_id,
            service_key: payload.service_key,
            usage_amount: payload.usage_amount,
            usage_unit: payload.usage_unit,
            meter_reading: payload.meter_reading,
            notes: payload.notes,
            base_currency: context.household.base_currency.clone(),
            household_timezone: context.household.timezone.clone(),
        },
    )
    .await
    .map_err(map_utility_store_error)?;
    Ok(Json(ManualRecordResponse {
        id: record.id,
        record_type: "utility".to_owned(),
        name: record.name,
    }))
}

fn board_response(record: UtilityBoardRecord) -> UtilityBoardResponse {
    UtilityBoardResponse {
        subject: board_subject(record.subject),
        trend: record.trend.into_iter().map(series_point).collect(),
        months: record.months.into_iter().map(board_month).collect(),
    }
}

fn board_subject(record: UtilityBoardSubjectRecord) -> UtilityBoardSubject {
    UtilityBoardSubject {
        id: record.id,
        kind: record.kind,
        name: record.name,
        group_type: record.group_type,
        started_on: record.started_on,
        ended_on: record.ended_on,
        notes: record.notes,
        tracked_fields: record
            .tracked_fields
            .into_iter()
            .map(tracked_field)
            .collect(),
    }
}

fn board_month(record: UtilityBoardMonthRecord) -> UtilityBoardMonth {
    UtilityBoardMonth {
        month: record.month,
        completed: record.completed,
        values: record
            .values
            .into_iter()
            .map(|(key, value)| (key, field_state(value)))
            .collect(),
        total: record.total,
    }
}

fn series_point(record: UtilitySeriesPointRecord) -> UtilitySeriesPoint {
    UtilitySeriesPoint {
        period: record.period,
        values: record.values,
        usage: record.usage,
        units: record.units,
        total: record.total,
    }
}

fn form_response(record: UtilityEntryFormRecord) -> UtilityEntryFormResponse {
    UtilityEntryFormResponse {
        month: record.month,
        completed: record.completed,
        fields: record.fields.into_iter().map(form_field).collect(),
    }
}

fn form_field(record: UtilityEntryFormFieldRecord) -> UtilityEntryFormField {
    UtilityEntryFormField {
        contract_id: record.contract_id,
        property_id: record.property_id,
        start_date: record.start_date,
        end_date: record.end_date,
        tracking_mode: record.tracking_mode,
        amount_source: record.amount_source,
        color: record.color,
        entry_mode: record.entry_mode,
        unit_rate: record.unit_rate,
        key: record.key,
        label: record.label,
        kind: record.kind,
        unit: record.unit,
        usage_amount: record.usage_amount,
        amount: record.amount,
        meter_reading: record.meter_reading,
        previous_amount: record.previous_amount,
        previous_meter_reading: record.previous_meter_reading,
        previous_usage: record.previous_usage,
    }
}

fn field_state(record: UtilityFieldStateRecord) -> UtilityFieldState {
    UtilityFieldState {
        amount: record.amount,
        meter_reading: record.meter_reading,
        usage_amount: record.usage_amount,
    }
}

fn tracked_field(record: TrackedFieldRecord) -> TrackedField {
    TrackedField {
        contract_id: record.contract_id,
        property_id: record.property_id,
        start_date: record.start_date,
        end_date: record.end_date,
        tracking_mode: record.tracking_mode,
        color: record.color,
        retired: record.retired,
        hidden: record.hidden,
        has_data: record.has_data,
        entry_mode: record.entry_mode,
        unit_rate: record.unit_rate,
        key: record.key,
        label: record.label,
        kind: record.kind,
        unit: record.unit,
    }
}

fn parse_month(value: &str) -> Result<NaiveDate, ApiError> {
    NaiveDate::parse_from_str(&format!("{value}-01"), "%Y-%m-%d").map_err(|_| {
        ApiError(ApplicationError::Validation(
            "Month must be YYYY-MM.".to_owned(),
        ))
    })
}

fn household_current_month(timezone: &str) -> Result<NaiveDate, ApiError> {
    month_start_at(timezone, Utc::now()).map_err(|error| {
        tracing::error!(%error, %timezone, "household timezone is invalid");
        ApiError(ApplicationError::Storage)
    })
}

fn map_utility_store_error(error: UtilityStoreError) -> ApiError {
    match error {
        UtilityStoreError::NotFound => ApiError(ApplicationError::NotFound),
        UtilityStoreError::Validation(detail) => ApiError(ApplicationError::Validation(detail)),
        UtilityStoreError::Database(error) => {
            tracing::error!(error = %error, "utility storage operation failed");
            ApiError(ApplicationError::Storage)
        }
    }
}

#[utoipa::path(post, path="/api/household/utility-field-order", operation_id="reorderUtilityFields",
    request_body=crate::dto::UtilityOrderPayload,
    responses((status=200,body=Vec<TrackedField>),(status=422,description="Invalid catalog permutation"),
    (status=401,description="Authentication required"),(status=403,description="Settings write denied")))]
pub async fn reorder_fields(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(_payload): Json<crate::dto::UtilityOrderPayload>,
) -> Result<Json<Vec<TrackedField>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "settings", "write")?;
    Err(legacy_configuration_error())
}

#[utoipa::path(post,path="/api/household/utility-field-catalog",operation_id="createUtilityField",request_body=crate::dto::UtilityConfigCreate,
    responses((status=200,body=TrackedField),(status=422,description="Legacy writes disabled; use property-owned utility contracts"),(status=401,description="Authentication required"),(status=403,description="Settings write denied")))]
pub async fn create_config(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(_payload): Json<crate::dto::UtilityConfigCreate>,
) -> Result<Json<TrackedField>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "settings", "write")?;
    Err(legacy_configuration_error())
}

#[utoipa::path(put,path="/api/household/utility-field-catalog/{key}",operation_id="updateUtilityField",request_body=crate::dto::UtilityConfigPayload,
    params(("key"=String,Path)),responses((status=200,body=TrackedField),(status=422,description="Legacy writes disabled; use property-owned utility contracts"),(status=401,description="Authentication required"),(status=403,description="Settings write denied")))]
pub async fn update_config(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(_key): Path<String>,
    Json(_payload): Json<crate::dto::UtilityConfigPayload>,
) -> Result<Json<TrackedField>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "settings", "write")?;
    Err(legacy_configuration_error())
}

#[utoipa::path(get,path="/api/household/utility-field-catalog/{key}/audit",operation_id="listUtilityFieldAudit",
    params(("key"=String,Path)),responses((status=200,body=Vec<crate::dto::UtilityConfigAuditResponse>),(status=401,description="Authentication required"),(status=403,description="Settings read denied")))]
pub async fn config_audit(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Result<Json<Vec<crate::dto::UtilityConfigAuditResponse>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "settings", "read")?;
    Ok(Json(
        checkbook_postgres::utilities::config_audit(&state.pool, context.household.id, &key)
            .await
            .map_err(map_utility_store_error)?
            .into_iter()
            .map(|record| crate::dto::UtilityConfigAuditResponse {
                id: record.id,
                actor_user_id: record.actor_user_id,
                created_at: record.created_at,
                old_config: record.old_config,
                new_config: record.new_config,
            })
            .collect(),
    ))
}

#[utoipa::path(patch,path="/api/household/utility-field-catalog/{key}/lifecycle",operation_id="updateUtilityFieldLifecycle",request_body=crate::dto::UtilityLifecyclePayload,
    params(("key"=String,Path)),responses((status=200,body=TrackedField),(status=422,description="Legacy writes disabled; use property-owned utility contracts"),(status=401,description="Authentication required"),(status=403,description="Settings write denied")))]
pub async fn update_lifecycle(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(_key): Path<String>,
    Json(_payload): Json<crate::dto::UtilityLifecyclePayload>,
) -> Result<Json<TrackedField>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "settings", "write")?;
    Err(legacy_configuration_error())
}

#[utoipa::path(delete,path="/api/household/utility-field-catalog/{key}",operation_id="deleteUtilityField",
    params(("key"=String,Path)),responses((status=204,description="Utility deleted"),(status=422,description="Legacy writes disabled; use property-owned utility contracts"),(status=401,description="Authentication required"),(status=403,description="Settings delete denied")))]
pub async fn delete_config(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(_key): Path<String>,
) -> Result<axum::http::StatusCode, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "settings", "delete")?;
    Err(legacy_configuration_error())
}

#[derive(Debug, Deserialize)]
pub struct ContractQuery {
    property_id: Uuid,
}

#[utoipa::path(get, path="/api/household/utilities/contracts", operation_id="listUtilityContracts",
    params(("property_id"=Uuid, Query)),
    responses((status=200,body=Vec<crate::dto::UtilityContract>),(status=401,description="Authentication required"),(status=403,description="Settings read denied")))]
pub async fn list_contracts(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<ContractQuery>,
) -> Result<Json<Vec<crate::dto::UtilityContract>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "settings", "read")?;
    let today = local_date_at(&context.household.timezone, Utc::now()).map_err(|error| {
        tracing::error!(%error, "household timezone is invalid");
        ApiError(ApplicationError::Storage)
    })?;
    let records =
        utility_contracts::list(&state.pool, context.household.id, query.property_id, today)
            .await
            .map_err(map_utility_store_error)?;
    Ok(Json(records.into_iter().map(contract_response).collect()))
}

#[utoipa::path(post, path="/api/household/utilities/contracts", operation_id="createUtilityContract",
    request_body=crate::dto::UtilityContractCreate,
    responses((status=200,body=crate::dto::UtilityContract),(status=422,description="Invalid contract"),(status=401,description="Authentication required"),(status=403,description="Settings write denied")))]
pub async fn create_contract(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<crate::dto::UtilityContractCreate>,
) -> Result<Json<crate::dto::UtilityContract>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "settings", "write")?;
    let record = utility_contracts::create(
        &state.pool,
        context.household.id,
        context.user.id,
        utility_contracts::ContractCreate {
            color: payload.color,
            property_id: payload.property_id,
            label: payload.label,
            tracking_mode: payload.tracking_mode,
            unit: payload.unit,
            start_date: payload.start_date,
            end_date: payload.end_date,
            initial_price: payload.initial_price,
        },
    )
    .await
    .map_err(map_utility_store_error)?;
    Ok(Json(contract_response(record)))
}

#[utoipa::path(put, path="/api/household/utilities/contracts/{id}", operation_id="updateUtilityContract",
    params(("id"=Uuid, Path)), request_body=crate::dto::UtilityContractUpdate,
    responses((status=200,body=crate::dto::UtilityContract),(status=422,description="Invalid contract or immutable property ownership"),(status=401,description="Authentication required"),(status=403,description="Settings write denied")))]
pub async fn update_contract(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<crate::dto::UtilityContractUpdate>,
) -> Result<Json<crate::dto::UtilityContract>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "settings", "write")?;
    let record = utility_contracts::update(
        &state.pool,
        context.household.id,
        context.user.id,
        id,
        utility_contracts::ContractUpdate {
            color: payload.color,
            label: payload.label,
            tracking_mode: payload.tracking_mode,
            unit: payload.unit,
            start_date: payload.start_date,
            end_date: payload.end_date,
        },
    )
    .await
    .map_err(map_utility_store_error)?;
    Ok(Json(contract_response(record)))
}

#[utoipa::path(post, path="/api/household/utilities/contracts/reorder", operation_id="reorderUtilityContracts",
    request_body=crate::dto::UtilityContractReorder,
    responses((status=200,body=Vec<crate::dto::UtilityContract>),(status=422,description="Incomplete order"),(status=401,description="Authentication required"),(status=403,description="Settings write denied")))]
pub async fn reorder_contracts(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<crate::dto::UtilityContractReorder>,
) -> Result<Json<Vec<crate::dto::UtilityContract>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "settings", "write")?;
    let records = utility_contracts::reorder(
        &state.pool,
        context.household.id,
        context.user.id,
        utility_contracts::ContractReorder {
            property_id: payload.property_id,
            ordered_ids: payload.ordered_ids,
        },
    )
    .await
    .map_err(map_utility_store_error)?;
    Ok(Json(records.into_iter().map(contract_response).collect()))
}

#[utoipa::path(get, path="/api/household/utilities/contracts/{id}/prices", operation_id="listUtilityContractPrices",
    params(("id"=Uuid, Path)),
    responses((status=200,body=Vec<crate::dto::UtilityContractPrice>),(status=401,description="Authentication required"),(status=403,description="Settings read denied")))]
pub async fn list_contract_prices(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<crate::dto::UtilityContractPrice>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "settings", "read")?;
    let records = utility_contracts::prices(&state.pool, context.household.id, id)
        .await
        .map_err(map_utility_store_error)?;
    Ok(Json(
        records.into_iter().map(contract_price_response).collect(),
    ))
}

#[utoipa::path(post, path="/api/household/utilities/contracts/{id}/prices", operation_id="createUtilityContractPrice",
    params(("id"=Uuid, Path)), request_body=crate::dto::UtilityContractPriceInput,
    responses((status=200,body=crate::dto::UtilityContractPrice),(status=422,description="Invalid price"),(status=401,description="Authentication required"),(status=403,description="Settings write denied")))]
pub async fn create_contract_price(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<crate::dto::UtilityContractPriceInput>,
) -> Result<Json<crate::dto::UtilityContractPrice>, ApiError> {
    save_contract_price(state, headers, id, None, payload).await
}

#[utoipa::path(put, path="/api/household/utilities/contracts/{id}/prices/{price_id}", operation_id="updateUtilityContractPrice",
    params(("id"=Uuid, Path),("price_id"=Uuid, Path)), request_body=crate::dto::UtilityContractPriceInput,
    responses((status=200,body=crate::dto::UtilityContractPrice),(status=422,description="Invalid price"),(status=401,description="Authentication required"),(status=403,description="Settings write denied")))]
pub async fn update_contract_price(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((id, price_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<crate::dto::UtilityContractPriceInput>,
) -> Result<Json<crate::dto::UtilityContractPrice>, ApiError> {
    save_contract_price(state, headers, id, Some(price_id), payload).await
}

async fn save_contract_price(
    state: ApiState,
    headers: HeaderMap,
    id: Uuid,
    price_id: Option<Uuid>,
    payload: crate::dto::UtilityContractPriceInput,
) -> Result<Json<crate::dto::UtilityContractPrice>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "settings", "write")?;
    let record = utility_contracts::save_price(
        &state.pool,
        context.household.id,
        context.user.id,
        id,
        price_id,
        utility_contracts::PriceInput {
            effective_on: payload.effective_on,
            price: payload.price,
        },
    )
    .await
    .map_err(map_utility_store_error)?;
    Ok(Json(contract_price_response(record)))
}

fn contract_response(record: utility_contracts::ContractRecord) -> crate::dto::UtilityContract {
    crate::dto::UtilityContract {
        color: record.color,
        id: record.id,
        property_id: record.property_id,
        key: record.key,
        label: record.label,
        tracking_mode: record.tracking_mode,
        unit: record.unit,
        start_date: record.start_date,
        end_date: record.end_date,
        retired: record.retired,
        sort_order: record.sort_order,
    }
}

fn contract_price_response(
    record: utility_contracts::PriceRecord,
) -> crate::dto::UtilityContractPrice {
    crate::dto::UtilityContractPrice {
        id: record.id,
        effective_on: record.effective_on,
        price: record.price,
    }
}

fn legacy_configuration_error() -> ApiError {
    ApiError(ApplicationError::Validation(
        "Legacy utility configuration is disabled; use property-owned utility contracts and their price timeline.".to_owned(),
    ))
}
