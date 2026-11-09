use crate::{
    ApiState,
    auth::{allowed_scope_values, authenticated, require_permission},
    error::ApiError,
    records::map_records_store_error,
};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use checkbook_application::{
    ApplicationError,
    clock::{Clock, SystemClock},
};
use checkbook_postgres::recurring_expenses::{self as store, RecurringExpenseInput};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct RecurringExpenseWrite {
    pub description: String,
    #[serde(with = "rust_decimal::serde::float")]
    #[schema(value_type = f64)]
    pub amount: Decimal,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
    #[serde(default = "monthly")]
    pub cadence: String,
    pub owner_scope: String,
    pub category_name: String,
    #[serde(default)]
    pub notes: String,
}
fn monthly() -> String {
    "monthly".to_owned()
}
impl From<RecurringExpenseWrite> for RecurringExpenseInput {
    fn from(p: RecurringExpenseWrite) -> Self {
        Self {
            description: p.description,
            amount: p.amount,
            start_date: p.start_date,
            end_date: p.end_date,
            cadence: p.cadence,
            owner_scope: p.owner_scope,
            category_name: p.category_name,
            notes: p.notes,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, utoipa::ToSchema)]
pub struct PriceHistoryEntry {
    #[serde(serialize_with = "rust_decimal::serde::float::serialize")]
    #[schema(value_type = f64)]
    pub amount: Decimal,
    pub changed_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct RecurringExpenseResponse {
    pub id: Uuid,
    pub description: String,
    #[serde(with = "rust_decimal::serde::float")]
    #[schema(value_type = f64)]
    pub amount: Decimal,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
    pub next_due_date: Option<NaiveDate>,
    pub cadence: String,
    pub owner_scope: String,
    pub category_id: Option<Uuid>,
    pub category_name: String,
    pub notes: String,
    pub is_active: bool,
    pub price_history: Vec<PriceHistoryEntry>,
}
impl TryFrom<store::RecurringExpense> for RecurringExpenseResponse {
    type Error = ApiError;
    fn try_from(p: store::RecurringExpense) -> Result<Self, ApiError> {
        Ok(Self {
            id: p.id,
            description: p.description,
            amount: p.amount,
            start_date: p.start_date,
            end_date: p.end_date,
            next_due_date: p.next_due_date,
            cadence: p.cadence,
            owner_scope: p.owner_scope,
            category_id: p.category_id,
            category_name: p.category_name,
            notes: p.notes,
            is_active: p.is_active,
            price_history: serde_json::from_value(p.price_history).map_err(|error| {
                tracing::error!(%error, "invalid recurring price history");
                ApiError(ApplicationError::Storage)
            })?,
        })
    }
}
pub(crate) fn today(timezone: &str) -> Result<NaiveDate, ApiError> {
    checkbook_domain::local_date_at(timezone, SystemClock.now())
        .map_err(|e| ApiError(ApplicationError::Validation(e.to_string())))
}

pub(crate) async fn refresh(
    state: &ApiState,
    household_id: Uuid,
    timezone: &str,
) -> Result<(), ApiError> {
    let storage_error = |error| {
        tracing::error!(%error, "recurring expense refresh failed");
        ApiError(ApplicationError::Storage)
    };
    let mut transaction = checkbook_postgres::tenant::begin(&state.pool, household_id, true)
        .await
        .map_err(storage_error)?;
    let schedules = store::load_in_transaction(&mut transaction, household_id)
        .await
        .map_err(map_records_store_error)?;
    transaction.commit().await.map_err(storage_error)?;
    if schedules.is_empty() {
        return Ok(());
    }
    checkbook_postgres::planning::materialize_household(
        &state.pool,
        household_id,
        today(timezone)?,
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, "recurring expense materialization failed");
        ApiError(ApplicationError::Storage)
    })?;
    Ok(())
}

#[utoipa::path(get, path="/api/household/expenses/recurring", operation_id="getRecurringExpenses", responses((status=200, body=[RecurringExpenseResponse]), (status=401, body=crate::error::ErrorBody)), security(("bearerAuth"=[])))]
pub async fn list(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RecurringExpenseResponse>>, ApiError> {
    let c = authenticated(&state, &headers).await?;
    let rows = store::list(
        &state.pool,
        c.household.id,
        &allowed_scope_values(&c),
        today(&c.household.timezone)?,
        &c.household.base_currency,
    )
    .await
    .map_err(map_records_store_error)?;
    Ok(Json(
        rows.into_iter()
            .map(TryInto::try_into)
            .collect::<Result<_, _>>()?,
    ))
}

#[utoipa::path(post, path="/api/household/expenses/recurring", operation_id="createRecurringExpense", request_body=RecurringExpenseWrite, responses((status=200, body=RecurringExpenseResponse), (status=401, body=crate::error::ErrorBody), (status=422, body=crate::error::ErrorBody)), security(("bearerAuth"=[])))]
pub async fn create(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<RecurringExpenseWrite>,
) -> Result<Json<RecurringExpenseResponse>, ApiError> {
    let c = authenticated(&state, &headers).await?;
    require_permission(&c, "records", "write")?;
    let row = store::create(
        &state.pool,
        c.household.id,
        &allowed_scope_values(&c),
        payload.into(),
        today(&c.household.timezone)?,
        &c.household.base_currency,
    )
    .await
    .map_err(map_records_store_error)?;
    Ok(Json(row.try_into()?))
}

#[utoipa::path(put, path="/api/household/expenses/recurring/{id}", operation_id="updateRecurringExpense", params(("id"=Uuid,Path)), request_body=RecurringExpenseWrite, responses((status=200, body=RecurringExpenseResponse), (status=401, body=crate::error::ErrorBody), (status=422, body=crate::error::ErrorBody)), security(("bearerAuth"=[])))]
pub async fn update(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<RecurringExpenseWrite>,
) -> Result<Json<RecurringExpenseResponse>, ApiError> {
    let c = authenticated(&state, &headers).await?;
    require_permission(&c, "records", "write")?;
    let row = store::update(
        &state.pool,
        c.household.id,
        &allowed_scope_values(&c),
        id,
        payload.into(),
        today(&c.household.timezone)?,
        &c.household.base_currency,
    )
    .await
    .map_err(map_records_store_error)?;
    Ok(Json(row.try_into()?))
}

#[utoipa::path(post, path="/api/household/expenses/recurring/{id}/expense-now", operation_id="expenseRecurringNow", params(("id"=Uuid,Path)), responses((status=200, body=RecurringExpenseResponse), (status=401, body=crate::error::ErrorBody), (status=422, body=crate::error::ErrorBody)), security(("bearerAuth"=[])))]
pub async fn expense_now(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<RecurringExpenseResponse>, ApiError> {
    let c = authenticated(&state, &headers).await?;
    require_permission(&c, "records", "write")?;
    let row = store::expense_now(
        &state.pool,
        c.household.id,
        &allowed_scope_values(&c),
        id,
        today(&c.household.timezone)?,
        &c.household.base_currency,
    )
    .await
    .map_err(map_records_store_error)?;
    Ok(Json(row.try_into()?))
}

#[utoipa::path(post, path="/api/household/expenses/recurring/{id}/retire", operation_id="retireRecurringExpense", params(("id"=Uuid,Path)), responses((status=200, body=RecurringExpenseResponse), (status=401, body=crate::error::ErrorBody), (status=422, body=crate::error::ErrorBody)), security(("bearerAuth"=[])))]
pub async fn retire(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<RecurringExpenseResponse>, ApiError> {
    let c = authenticated(&state, &headers).await?;
    require_permission(&c, "records", "write")?;
    let row = store::retire(
        &state.pool,
        c.household.id,
        &allowed_scope_values(&c),
        id,
        today(&c.household.timezone)?,
        &c.household.base_currency,
    )
    .await
    .map_err(map_records_store_error)?;
    Ok(Json(row.try_into()?))
}
