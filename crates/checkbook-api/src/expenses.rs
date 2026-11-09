use std::collections::HashMap;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use checkbook_application::ApplicationError;
use checkbook_postgres::expenses::{
    ExpenseCategoryInput, ExpenseCategoryRecord, ExpenseCategoryStatsRow, ExpenseEntryUpdateInput,
    ExpenseGroupInput, ExpenseGroupRecord, create_category as store_create_category,
    create_group as store_create_group, delete_category as store_delete_category,
    delete_expense_entry as store_delete_expense_entry, delete_group as store_delete_group,
    load_board as store_load_board, load_category_detail as store_load_category_detail,
    update_category as store_update_category, update_expense_entry as store_update_expense_entry,
    update_group as store_update_group,
};
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::{
    ApiState,
    auth::{allowed_scope_values, authenticated, require_permission, require_scope_access},
    dto::{
        ExpenseCategoryDetailResponse, ExpenseCategoryMonthlyPointResponse,
        ExpenseCategorySummaryResponse, ExpenseCategoryWritePayload, ExpenseEntryResponse,
        ExpenseEntryUpdatePayload, ExpenseGroupResponse, ExpenseGroupWritePayload,
        ExpenseMonthlyPointResponse, ExpenseSubcategoryResponse, ExpensesBoardResponse,
    },
    error::ApiError,
    records::map_records_store_error,
};

/// Optional date window for the expenses board, mirroring the dashboard
/// overview range picker. Absent bounds mean "all time" (the default).
#[derive(Debug, Default, Deserialize)]
pub struct ExpensesBoardQuery {
    pub start_date: Option<chrono::NaiveDate>,
    pub end_date: Option<chrono::NaiveDate>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ExpenseNameSuggestionsQuery {
    #[serde(default)]
    pub query: String,
}

#[utoipa::path(
    get,
    path = "/api/household/expenses/suggestions",
    operation_id = "getExpenseNameSuggestions",
    params(("query" = String, Query, description = "Expense name fragment; 2 to 120 characters")),
    responses(
        (status = 200, body = [crate::dto::ExpenseNameSuggestion]),
        (status = 401, body = crate::error::ErrorBody),
        (status = 422, body = crate::error::ErrorBody)
    ),
    security(("bearerAuth" = []))
)]
pub async fn name_suggestions(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<ExpenseNameSuggestionsQuery>,
) -> Result<Json<Vec<crate::dto::ExpenseNameSuggestion>>, ApiError> {
    use checkbook_application::clock::{Clock, SystemClock};

    let context = authenticated(&state, &headers).await?;
    let today =
        checkbook_domain::time::local_date_at(&context.household.timezone, SystemClock.now())
            .map_err(|error| ApiError(ApplicationError::Validation(error.to_string())))?;
    let suggestions = checkbook_postgres::expenses::load_name_suggestions(
        &state.pool,
        context.household.id,
        &allowed_scope_values(&context),
        &query.query,
        today,
    )
    .await
    .map_err(map_records_store_error)?;
    Ok(Json(
        suggestions
            .into_iter()
            .map(|row| crate::dto::ExpenseNameSuggestion {
                description: row.description,
                category_id: row.category_id,
                category_name: row.category_name,
                expense_group_id: row.expense_group_id,
            })
            .collect(),
    ))
}

pub async fn board(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<ExpensesBoardQuery>,
) -> Result<Json<ExpensesBoardResponse>, ApiError> {
    if query
        .end_date
        .zip(query.start_date)
        .is_some_and(|(end, start)| end < start)
    {
        return Err(ApiError(ApplicationError::Validation(
            "end_date must not be before start_date.".to_owned(),
        )));
    }
    let context = authenticated(&state, &headers).await?;
    crate::recurring_expenses::refresh(&state, context.household.id, &context.household.timezone)
        .await?;
    let scopes = allowed_scope_values(&context);
    let board = store_load_board(
        &state.pool,
        context.household.id,
        &scopes,
        query.start_date,
        query.end_date,
    )
    .await
    .map_err(map_records_store_error)?;
    // Only actual activity extends all categories' averaging windows. Future
    // loan schedules extend their own category's window, not historical spending.
    let household_last_entry = board.last_actual_entry_date;
    let stats: HashMap<Uuid, ExpenseCategoryStatsRow> = board
        .stats
        .into_iter()
        .map(|row| (row.category_id, row))
        .collect();
    Ok(Json(ExpensesBoardResponse {
        monthly_totals: board
            .monthly_totals
            .into_iter()
            .map(|row| ExpenseCategoryMonthlyPointResponse {
                category_id: row.category_id,
                period: row.period.format("%Y-%m").to_string(),
                value: row.amount,
            })
            .collect(),
        groups: board.groups.into_iter().map(group_response).collect(),
        categories: board
            .categories
            .into_iter()
            .map(|category| {
                let stat = stats.get(&category.id).cloned();
                let utility_property_id = board
                    .utility_property_ids
                    .contains(&category.id)
                    .then_some(category.id);
                let mut summary = category_summary(category, stat, household_last_entry);
                summary.utility_property_id = utility_property_id;
                summary
            })
            .collect(),
    }))
}

pub async fn create_group(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<ExpenseGroupWritePayload>,
) -> Result<Json<ExpenseGroupResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let record = store_create_group(&state.pool, context.household.id, group_input(payload))
        .await
        .map_err(map_records_store_error)?;
    Ok(Json(group_response(record)))
}

pub async fn update_group(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(group_id): Path<Uuid>,
    Json(payload): Json<ExpenseGroupWritePayload>,
) -> Result<Json<ExpenseGroupResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let record = store_update_group(
        &state.pool,
        context.household.id,
        group_id,
        group_input(payload),
    )
    .await
    .map_err(map_records_store_error)?;
    Ok(Json(group_response(record)))
}

pub async fn delete_group(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(group_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "delete")?;
    store_delete_group(&state.pool, context.household.id, group_id)
        .await
        .map_err(map_records_store_error)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn create_category(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<ExpenseCategoryWritePayload>,
) -> Result<Json<ExpenseCategorySummaryResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let record = store_create_category(&state.pool, context.household.id, category_input(payload))
        .await
        .map_err(map_records_store_error)?;
    Ok(Json(category_summary(record, None, None)))
}

pub async fn update_category(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(category_id): Path<Uuid>,
    Json(payload): Json<ExpenseCategoryWritePayload>,
) -> Result<Json<ExpenseCategorySummaryResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let record = store_update_category(
        &state.pool,
        context.household.id,
        category_id,
        category_input(payload),
    )
    .await
    .map_err(map_records_store_error)?;
    Ok(Json(category_summary(record, None, None)))
}

pub async fn delete_category(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(category_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "delete")?;
    store_delete_category(&state.pool, context.household.id, category_id)
        .await
        .map_err(map_records_store_error)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn category_detail(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(category_id): Path<Uuid>,
) -> Result<Json<ExpenseCategoryDetailResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let scopes = allowed_scope_values(&context);
    let detail =
        store_load_category_detail(&state.pool, context.household.id, category_id, &scopes)
            .await
            .map_err(map_records_store_error)?;
    Ok(Json(ExpenseCategoryDetailResponse {
        id: detail.category.id,
        name: detail.category.name,
        expense_group_id: detail.category.expense_group_id,
        is_system: detail.category.is_system,
        sort_order: detail.category.sort_order,
        is_retired: detail.category.is_retired,
        can_delete: detail.category.can_delete,
        is_source_linked: detail.category.is_source_linked,
        subcategories: detail
            .subcategories
            .into_iter()
            .map(|subcategory| ExpenseSubcategoryResponse {
                id: subcategory.id,
                name: subcategory.name,
                sort_order: subcategory.sort_order,
            })
            .collect(),
        monthly_totals: detail
            .monthly_totals
            .into_iter()
            .map(|row| ExpenseMonthlyPointResponse {
                period: row.period.format("%Y-%m").to_string(),
                value: row.amount,
            })
            .collect(),
        entries: detail
            .entries
            .into_iter()
            .map(|entry| ExpenseEntryResponse {
                id: entry.id,
                description: entry.description,
                amount: entry.amount,
                entry_date: entry.entry_date,
                owner_scope: entry.owner_scope,
                notes: entry.notes,
                data_source: entry.data_source,
                category_id: entry.category_id,
                subcategory_id: entry.subcategory_id,
                extra_payload: entry.extra_payload,
            })
            .collect(),
    }))
}

pub async fn update_entry(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(entry_id): Path<Uuid>,
    Json(payload): Json<ExpenseEntryUpdatePayload>,
) -> Result<Json<Value>, ApiError> {
    if payload.amount <= Decimal::ZERO || payload.description.trim().is_empty() {
        return Err(ApiError(
            checkbook_application::ApplicationError::Validation(
                "Description and a positive amount are required.".to_owned(),
            ),
        ));
    }
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    require_scope_access(&context, &payload.owner_scope)?;
    store_update_expense_entry(
        &state.pool,
        context.household.id,
        entry_id,
        ExpenseEntryUpdateInput {
            amount: payload.amount,
            entry_date: Some(payload.entry_date),
            description: payload.description,
            notes: payload.notes,
            owner_scope: payload.owner_scope,
            category_id: payload.category_id,
            subcategory_id: payload.subcategory_id,
            allowed_scopes: allowed_scope_values(&context),
        },
    )
    .await
    .map_err(map_records_store_error)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn delete_entry(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(entry_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "delete")?;
    let scopes = allowed_scope_values(&context);
    store_delete_expense_entry(&state.pool, context.household.id, entry_id, &scopes)
        .await
        .map_err(map_records_store_error)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn group_input(payload: ExpenseGroupWritePayload) -> ExpenseGroupInput {
    ExpenseGroupInput {
        name: payload.name,
        color: payload.color,
        notes: payload.notes,
        sort_order: payload.sort_order,
        is_retired: payload.is_retired,
    }
}

fn category_input(payload: ExpenseCategoryWritePayload) -> ExpenseCategoryInput {
    ExpenseCategoryInput {
        name: payload.name,
        expense_group_id: payload.expense_group_id,
        sort_order: payload.sort_order,
        is_retired: payload.is_retired,
    }
}

fn group_response(record: ExpenseGroupRecord) -> ExpenseGroupResponse {
    ExpenseGroupResponse {
        id: record.id,
        name: record.name,
        color: record.color,
        notes: record.notes,
        sort_order: record.sort_order,
        is_retired: record.is_retired,
        can_delete: record.can_delete,
        is_source_linked: record.is_source_linked,
    }
}

fn category_summary(
    category: ExpenseCategoryRecord,
    stats: Option<ExpenseCategoryStatsRow>,
    household_last_entry: Option<chrono::NaiveDate>,
) -> ExpenseCategorySummaryResponse {
    let (total_amount, entry_count, first_entry_date, last_entry_date) = stats
        .map(|row| {
            (
                row.total_amount,
                row.entry_count,
                row.first_entry_date,
                row.last_entry_date,
            )
        })
        .unwrap_or((Decimal::ZERO, 0, None, None));
    // Spread historical purchases through the household's latest actual activity;
    // scheduled loans additionally cover their own future payment months.
    let average_end = household_last_entry.max(last_entry_date);
    let month_span = first_entry_date.zip(average_end).map(|(first, last)| {
        use chrono::Datelike;
        let months = (i64::from(last.year()) - i64::from(first.year())) * 12
            + i64::from(last.month())
            - i64::from(first.month())
            + 1;
        months.max(1)
    });
    let monthly_average = match month_span {
        Some(months) if total_amount > Decimal::ZERO => {
            (total_amount / Decimal::from(months)).round_dp(2)
        }
        _ => Decimal::ZERO,
    };
    ExpenseCategorySummaryResponse {
        id: category.id,
        name: category.name,
        parent_id: category.parent_id,
        expense_group_id: category.expense_group_id,
        is_system: category.is_system,
        sort_order: category.sort_order,
        is_retired: category.is_retired,
        can_delete: category.can_delete,
        is_source_linked: category.is_source_linked,
        total_amount,
        monthly_average,
        entry_count,
        first_entry_date,
        last_entry_date,
        utility_property_id: None,
    }
}
