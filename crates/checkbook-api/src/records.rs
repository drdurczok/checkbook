use std::str::FromStr;

use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use checkbook_application::ApplicationError;
use checkbook_postgres::records::{
    IncomeCustomFieldInput, IncomeLineInput, IncomeMilestoneInput, IncomeSourceDetails,
    IncomeSourceEntryInput, IncomeSourceInput, LedgerDirection, ManualLedgerEntryInput,
    RecordsStoreError, create_income_source as store_create_income_source,
    create_income_source_entry as store_create_income_source_entry, create_manual_ledger_entry,
    delete_income_source as store_delete_income_source,
    list_income_sources as store_list_income_sources,
    update_income_source as store_update_income_source,
    update_income_source_entry as store_update_income_source_entry,
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde_json::Value;
use uuid::Uuid;

use crate::{
    ApiState,
    auth::{allowed_scope_values, authenticated, require_permission, require_scope_access},
    dto::{
        IncomeCustomField, IncomeLine, IncomeMilestone, IncomeSourceEntryPayload,
        IncomeSourceEntryResponse, IncomeSourcePayload, IncomeSourceResponse, ManualExpenseCreate,
        ManualIncomeCreate, ManualRecordResponse,
    },
    error::ApiError,
};

pub async fn create_expense(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<ManualExpenseCreate>,
) -> Result<Json<ManualRecordResponse>, ApiError> {
    validate_amount_and_text(payload.amount, &payload.description)?;
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    require_scope_access(&context, &payload.owner_scope)?;
    let id = create_manual_ledger_entry(
        &state.pool,
        context.household.id,
        ManualLedgerEntryInput {
            direction: LedgerDirection::Expense,
            amount: payload.amount,
            currency: context.household.base_currency.clone(),
            entry_date: Some(payload.entry_date),
            description: payload.description.trim().to_owned(),
            notes: payload.notes,
            owner_scope: payload.owner_scope,
            category_name: payload.category_name,
            subcategory_name: payload.subcategory_name,
            income_source_id: None,
            allowed_scopes: allowed_scope_values(&context),
            household_timezone: context.household.timezone.clone(),
        },
    )
    .await
    .map_err(map_records_store_error)?;
    Ok(Json(ManualRecordResponse {
        id,
        record_type: "expense".to_owned(),
        name: payload.description,
    }))
}

pub async fn create_income(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<ManualIncomeCreate>,
) -> Result<Json<ManualRecordResponse>, ApiError> {
    validate_amount_and_text(payload.amount, &payload.description)?;
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    require_scope_access(&context, &payload.owner_scope)?;
    let id = create_manual_ledger_entry(
        &state.pool,
        context.household.id,
        ManualLedgerEntryInput {
            direction: LedgerDirection::Income,
            amount: payload.amount,
            currency: context.household.base_currency.clone(),
            entry_date: Some(payload.entry_date),
            description: payload.description.trim().to_owned(),
            notes: payload.notes,
            owner_scope: payload.owner_scope,
            category_name: payload.category_name,
            subcategory_name: payload.subcategory_name,
            income_source_id: payload.income_source_id,
            allowed_scopes: allowed_scope_values(&context),
            household_timezone: context.household.timezone.clone(),
        },
    )
    .await
    .map_err(map_records_store_error)?;
    Ok(Json(ManualRecordResponse {
        id,
        record_type: "income".to_owned(),
        name: payload.description,
    }))
}

pub async fn income_sources(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<IncomeSourceResponse>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let scopes = allowed_scope_values(&context);
    let responses = store_list_income_sources(&state.pool, context.household.id, &scopes)
        .await
        .map_err(map_records_store_error)?
        .into_iter()
        .map(|details| income_source_response(details, &scopes))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(responses))
}

pub async fn create_income_source(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<IncomeSourcePayload>,
) -> Result<Json<IncomeSourceResponse>, ApiError> {
    validate_income_source(&payload)?;
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    require_scope_access(&context, &payload.owner_scope)?;
    require_line_scope_access(&context, &payload.lines)?;
    let scopes = allowed_scope_values(&context);
    let input = income_source_input(payload, &context)?;
    let response = income_source_response(
        store_create_income_source(&state.pool, context.household.id, input)
            .await
            .map_err(map_records_store_error)?,
        &scopes,
    )?;
    Ok(Json(response))
}

pub async fn update_income_source(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(source_id): Path<Uuid>,
    Json(payload): Json<IncomeSourcePayload>,
) -> Result<Json<IncomeSourceResponse>, ApiError> {
    validate_income_source(&payload)?;
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    require_scope_access(&context, &payload.owner_scope)?;
    require_line_scope_access(&context, &payload.lines)?;
    let scopes = allowed_scope_values(&context);
    let input = income_source_input(payload, &context)?;
    let response = income_source_response(
        store_update_income_source(&state.pool, context.household.id, source_id, input)
            .await
            .map_err(map_records_store_error)?,
        &scopes,
    )?;
    Ok(Json(response))
}

pub async fn create_income_source_entry(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(source_id): Path<Uuid>,
    Json(payload): Json<IncomeSourceEntryPayload>,
) -> Result<Json<IncomeSourceResponse>, ApiError> {
    validate_amount_and_text(payload.amount, "income entry")?;
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let scopes = allowed_scope_values(&context);
    if let Some(scope) = payload.owner_scope.as_deref() {
        require_scope_access(&context, scope)?;
    }
    let input = income_source_entry_input(payload, &context);
    let response = income_source_response(
        store_create_income_source_entry(&state.pool, context.household.id, source_id, input)
            .await
            .map_err(map_records_store_error)?,
        &scopes,
    )?;
    Ok(Json(response))
}

pub async fn update_income_source_entry(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((source_id, entry_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<IncomeSourceEntryPayload>,
) -> Result<Json<IncomeSourceResponse>, ApiError> {
    validate_amount_and_text(payload.amount, "income entry")?;
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let scopes = allowed_scope_values(&context);
    if let Some(scope) = payload.owner_scope.as_deref() {
        require_scope_access(&context, scope)?;
    }
    let input = income_source_entry_input(payload, &context);
    let response = income_source_response(
        store_update_income_source_entry(
            &state.pool,
            context.household.id,
            source_id,
            entry_id,
            input,
        )
        .await
        .map_err(map_records_store_error)?,
        &scopes,
    )?;
    Ok(Json(response))
}

pub async fn delete_income_source(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(source_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "delete")?;
    let scopes = allowed_scope_values(&context);
    store_delete_income_source(
        &state.pool,
        context.household.id,
        source_id,
        &scopes,
        &context.household.timezone,
    )
    .await
    .map_err(map_records_store_error)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn income_source_input(
    payload: IncomeSourcePayload,
    context: &checkbook_postgres::auth::SessionContext,
) -> Result<IncomeSourceInput, ApiError> {
    Ok(IncomeSourceInput {
        name: payload.name.trim().to_owned(),
        source_type: payload.source_type,
        owner_scope: payload.owner_scope,
        started_on: payload.started_on,
        ended_on: payload.ended_on,
        notes: payload.notes,
        sort_order: payload.sort_order,
        lines: payload
            .lines
            .into_iter()
            .map(|line| IncomeLineInput {
                label: line.label,
                amount: line.amount,
                frequency: line.frequency,
                owner_scope: line.owner_scope,
                category: line.category,
                started_on: line.started_on,
                ended_on: line.ended_on,
                notes: line.notes,
                fields: line.fields.into_iter().map(custom_field_input).collect(),
            })
            .collect(),
        fields: payload.fields.into_iter().map(custom_field_input).collect(),
        milestones: payload
            .milestones
            .into_iter()
            .map(|milestone| {
                let milestone_date = NaiveDate::from_str(&milestone.date).map_err(|_| {
                    ApiError(ApplicationError::Validation(
                        "Income milestone date must be an ISO date.".to_owned(),
                    ))
                })?;
                Ok(IncomeMilestoneInput {
                    label: milestone.label,
                    milestone_date,
                })
            })
            .collect::<Result<Vec<_>, ApiError>>()?,
        allowed_scopes: allowed_scope_values(context),
        household_timezone: context.household.timezone.clone(),
    })
}

fn custom_field_input(field: IncomeCustomField) -> IncomeCustomFieldInput {
    IncomeCustomFieldInput {
        label: field.label,
        value: field.value,
    }
}

fn income_source_entry_input(
    payload: IncomeSourceEntryPayload,
    context: &checkbook_postgres::auth::SessionContext,
) -> IncomeSourceEntryInput {
    IncomeSourceEntryInput {
        amount: payload.amount,
        entry_date: Some(payload.entry_date),
        description: payload.description.trim().to_owned(),
        notes: payload.notes,
        owner_scope: payload.owner_scope,
        extra_payload: payload.extra_payload,
        allowed_scopes: allowed_scope_values(context),
        household_timezone: context.household.timezone.clone(),
    }
}

fn income_source_response(
    details: IncomeSourceDetails,
    scopes: &[String],
) -> Result<IncomeSourceResponse, ApiError> {
    let source = details.source;
    let mut line_responses = Vec::with_capacity(details.lines.len());
    for line in details.lines.iter().filter(|line| {
        let scope = line.owner_scope.as_deref().unwrap_or(&source.owner_scope);
        scopes.iter().any(|allowed| allowed == scope)
    }) {
        line_responses.push(IncomeLine {
            label: line.label.clone(),
            amount: line.amount,
            frequency: line.frequency.clone(),
            owner_scope: line.owner_scope.clone(),
            category: line.category.clone(),
            started_on: line.started_on,
            ended_on: line.ended_on,
            notes: line.notes.clone(),
            fields: details
                .fields
                .iter()
                .filter(|field| field.income_source_line_id == Some(line.id))
                .map(|field| IncomeCustomField {
                    label: field.label.clone(),
                    value: field.value.clone(),
                })
                .collect(),
        });
    }
    let annual_total = line_responses.iter().fold(Decimal::ZERO, |total, line| {
        total + line.amount * frequency_multiplier(&line.frequency)
    });
    let actual_total = details
        .entries
        .iter()
        .fold(Decimal::ZERO, |total, entry| total + entry.amount);
    Ok(IncomeSourceResponse {
        id: source.id,
        name: source.name,
        source_type: source.source_type,
        owner_scope: source.owner_scope,
        started_on: source.started_on,
        ended_on: source.ended_on,
        notes: source.notes,
        line_count: line_responses.len(),
        lines: line_responses,
        fields: details
            .fields
            .iter()
            .filter(|field| field.income_source_id == Some(source.id))
            .map(|field| IncomeCustomField {
                label: field.label.clone(),
                value: field.value.clone(),
            })
            .collect(),
        milestones: details
            .milestones
            .into_iter()
            .map(|milestone| IncomeMilestone {
                label: milestone.label,
                date: milestone.milestone_date.to_string(),
            })
            .collect(),
        sort_order: source.sort_order,
        annual_total: annual_total.round_dp(2),
        actual_total: actual_total.round_dp(2),
        entries: details
            .entries
            .into_iter()
            .map(|entry| IncomeSourceEntryResponse {
                id: entry.id,
                description: entry.description,
                amount: entry.amount,
                entry_date: entry.entry_date,
                owner_scope: entry.owner_scope,
                notes: entry.notes,
                extra_payload: entry.extra_payload,
            })
            .collect(),
    })
}

fn frequency_multiplier(frequency: &str) -> Decimal {
    match frequency {
        "weekly" => Decimal::from(52),
        "biweekly" => Decimal::from(26),
        "monthly" => Decimal::from(12),
        "quarterly" => Decimal::from(4),
        "yearly" | "one_off" => Decimal::ONE,
        _ => Decimal::ZERO,
    }
}

fn validate_income_source(payload: &IncomeSourcePayload) -> Result<(), ApiError> {
    if payload.name.trim().is_empty() {
        return Err(ApiError(ApplicationError::Validation(
            "Income source name is required.".to_owned(),
        )));
    }
    require_valid_scope(&payload.owner_scope)?;
    if payload
        .ended_on
        .zip(payload.started_on)
        .is_some_and(|(end, start)| end < start)
    {
        return Err(ApiError(ApplicationError::Validation(
            "End date must not be before start date.".to_owned(),
        )));
    }
    for line in &payload.lines {
        if line.amount.is_sign_negative()
            || !matches!(
                line.frequency.as_str(),
                "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly" | "one_off"
            )
        {
            return Err(ApiError(ApplicationError::Validation(
                "Income source line is invalid.".to_owned(),
            )));
        }
        if let Some(scope) = &line.owner_scope {
            require_valid_scope(scope)?;
        }
    }
    Ok(())
}

fn validate_amount_and_text(amount: Decimal, text: &str) -> Result<(), ApiError> {
    if amount <= Decimal::ZERO || text.trim().is_empty() {
        return Err(ApiError(ApplicationError::Validation(
            "Description and a positive amount are required.".to_owned(),
        )));
    }
    Ok(())
}

fn require_valid_scope(scope: &str) -> Result<(), ApiError> {
    if matches!(scope, "self" | "spouse" | "joint") {
        Ok(())
    } else {
        Err(ApiError(ApplicationError::Validation(
            "Invalid ownership scope.".to_owned(),
        )))
    }
}

fn require_line_scope_access(
    context: &checkbook_postgres::auth::SessionContext,
    lines: &[IncomeLine],
) -> Result<(), ApiError> {
    for line in lines {
        if let Some(scope) = line.owner_scope.as_deref() {
            require_scope_access(context, scope)?;
        }
    }
    Ok(())
}

pub(crate) fn map_records_store_error(error: RecordsStoreError) -> ApiError {
    match error {
        RecordsStoreError::Validation(detail) => ApiError(ApplicationError::Validation(detail)),
        RecordsStoreError::Forbidden => ApiError(ApplicationError::Forbidden),
        RecordsStoreError::NotFound => ApiError(ApplicationError::NotFound),
        RecordsStoreError::Database(error) => {
            if let Some(validation) = crate::error::expense_source_validation(&error) {
                return validation;
            }
            tracing::error!(%error, "records database operation failed");
            ApiError(ApplicationError::Storage)
        }
    }
}
