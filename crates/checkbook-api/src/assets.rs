use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use checkbook_application::ApplicationError;
use checkbook_domain::{compounded_value, local_date_at, months_between, simulate_loan_payoff};
use checkbook_postgres::assets::{
    AccountHoldingInput, AssetDetails, AssetInput, AssetStoreError, CreateLoanInput, HoldingsRow,
    ItemRow, LoanRow, UpdateLoanInput, ValuationRow, create_asset as store_create_asset,
    create_loan as store_create_loan, create_own_category as store_create_own_category,
    create_property_valuation as store_create_property_valuation,
    delete_asset as store_delete_asset,
    delete_property_valuation as store_delete_property_valuation, list_assets as store_list_assets,
    list_loans as store_list_loans, list_property_valuations as store_list_property_valuations,
    update_asset as store_update_asset, update_loan as store_update_loan,
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    ApiState,
    auth::{allowed_scope_values, authenticated, require_permission, require_scope_access},
    dto::{
        AccountHoldingPayload, AccountHoldingResponse, AssetAccountRegistration, AssetAccountType,
        AssetSummary, AssetUpdatePayload, AssetWritePayload, LoanSummary, LoanUpdatePayload,
        ManualLoanCreate, ManualRecordResponse, PropertyValuation, PropertyValuationCreate,
    },
    error::ApiError,
};

pub async fn create_loan(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<ManualLoanCreate>,
) -> Result<Json<ManualRecordResponse>, ApiError> {
    validate_loan(&payload)?;
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    require_scope_access(&context, &payload.owner_scope)?;
    let record = store_create_loan(
        &state.pool,
        context.household.id,
        CreateLoanInput {
            name: payload.name.trim().to_owned(),
            liability_type: payload.liability_type.clone(),
            owner_scope: payload.owner_scope.clone(),
            current_balance: payload.current_balance,
            monthly_payment: payload.monthly_payment,
            interest_rate: payload.interest_rate,
            original_balance: payload.original_balance,
            start_date: payload.start_date,
            end_date: payload.end_date,
            notes: payload.notes.clone(),
            linked_property_id: payload.linked_property_id,
            base_currency: context.household.base_currency.clone(),
            household_timezone: context.household.timezone.clone(),
        },
    )
    .await
    .map_err(map_asset_store_error)?;
    Ok(Json(ManualRecordResponse {
        id: record.id,
        record_type: "loan".to_owned(),
        name: record.name,
    }))
}

#[utoipa::path(
    put,
    path = "/api/household/loans/{loan_id}",
    operation_id = "updateLoan",
    params(("loan_id" = Uuid, Path, description = "Existing loan id")),
    request_body = LoanUpdatePayload,
    responses(
        (status = 200, description = "Updated loan", body = LoanSummary),
        (status = 401, description = "Authentication required", body = crate::error::ErrorBody),
        (status = 403, description = "Permission denied", body = crate::error::ErrorBody),
        (status = 404, description = "Loan not found", body = crate::error::ErrorBody),
        (status = 422, description = "Invalid loan details", body = crate::error::ErrorBody)
    ),
    security(("bearerAuth" = []))
)]
pub async fn update_loan(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(loan_id): Path<Uuid>,
    payload: Result<Json<LoanUpdatePayload>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<LoanSummary>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let Json(payload) = payload.map_err(|_| {
        ApiError(ApplicationError::Validation(
            "Loan details are invalid.".to_owned(),
        ))
    })?;
    validate_loan_fields(LoanValidation {
        name: &payload.name,
        current_balance: payload.current_balance.unwrap_or_default(),
        monthly_payment: payload.monthly_payment.unwrap_or_default(),
        original_balance: payload.original_balance,
        interest_rate: payload.interest_rate,
        start_date: payload.start_date,
        end_date: payload.end_date,
    })?;
    let scopes = allowed_scope_values(&context);
    let row = store_update_loan(
        &state.pool,
        context.household.id,
        loan_id,
        &scopes,
        UpdateLoanInput {
            name: payload.name.trim().to_owned(),
            current_balance: payload.current_balance,
            monthly_payment: payload.monthly_payment,
            interest_rate: payload.interest_rate,
            original_balance: payload.original_balance,
            start_date: payload.start_date,
            end_date: payload.end_date,
            notes: payload.notes,
            linked_property_id: payload.linked_property_id,
            actor_user_id: context.user.id,
            household_timezone: context.household.timezone.clone(),
            payment_schedule: payload
                .payment_schedule
                .map(|schedule| schedule.into_iter().map(Into::into).collect()),
        },
    )
    .await
    .map_err(map_asset_store_error)?;
    Ok(Json(loan_summary(row)))
}

pub async fn list_loans(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<LoanSummary>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let scopes = allowed_scope_values(&context);
    let rows = store_list_loans(&state.pool, context.household.id, &scopes)
        .await
        .map_err(map_asset_store_error)?;
    Ok(Json(rows.into_iter().map(loan_summary).collect()))
}

pub async fn create_asset(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<AssetWritePayload>,
) -> Result<Json<ManualRecordResponse>, ApiError> {
    validate_asset(AssetValidation {
        name: &payload.name,
        total_cost: payload.total_cost,
        status: &payload.status,
        kind: &payload.kind,
        category: &payload.category,
        account_type: payload.account_type,
        account_registration: payload.account_registration,
        holdings: payload.holdings.as_deref(),
        depreciation_rate: payload.depreciation_rate,
        started_on: payload.started_on,
        ended_on: payload.ended_on,
    })?;
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let record = store_create_asset(
        &state.pool,
        context.household.id,
        asset_input(
            &payload,
            &context.household.base_currency,
            &context.household.timezone,
        ),
    )
    .await
    .map_err(map_asset_store_error)?;
    Ok(Json(ManualRecordResponse {
        id: record.id,
        record_type: "asset".to_owned(),
        name: record.name,
    }))
}

pub async fn list_assets(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AssetSummary>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let today = household_today(&context.household.timezone)?;
    let rows = store_list_assets(&state.pool, context.household.id)
        .await
        .map_err(map_asset_store_error)?;
    Ok(Json(
        rows.into_iter()
            .map(|row| asset_response(row, today))
            .collect(),
    ))
}

pub async fn update_asset(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(asset_id): Path<Uuid>,
    Json(payload): Json<AssetUpdatePayload>,
) -> Result<Json<AssetSummary>, ApiError> {
    validate_asset(AssetValidation {
        name: &payload.name,
        total_cost: payload.total_cost,
        status: &payload.status,
        kind: "project",
        category: &payload.category,
        account_type: payload.account_type,
        account_registration: payload.account_registration,
        holdings: payload.holdings.as_deref(),
        depreciation_rate: payload.depreciation_rate,
        started_on: payload.started_on,
        ended_on: payload.ended_on,
    })?;
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let today = household_today(&context.household.timezone)?;
    let response = store_update_asset(
        &state.pool,
        context.household.id,
        asset_id,
        asset_update_input(
            &payload,
            &context.household.base_currency,
            &context.household.timezone,
        ),
    )
    .await
    .map_err(map_asset_store_error)
    .map(|details| asset_response(details, today))?;
    Ok(Json(response))
}

fn household_today(timezone: &str) -> Result<NaiveDate, ApiError> {
    local_date_at(timezone, chrono::Utc::now()).map_err(|error| {
        ApiError(ApplicationError::Validation(format!(
            "invalid timezone: {error}"
        )))
    })
}

pub async fn delete_asset(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(asset_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "delete")?;
    store_delete_asset(
        &state.pool,
        context.household.id,
        asset_id,
        &context.household.timezone,
    )
    .await
    .map_err(map_asset_store_error)?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn create_own_category(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(asset_id): Path<Uuid>,
) -> Result<Json<AssetSummary>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    let today = household_today(&context.household.timezone)?;
    let response = store_create_own_category(&state.pool, context.household.id, asset_id)
        .await
        .map_err(map_asset_store_error)
        .map(|details| asset_response(details, today))?;
    Ok(Json(response))
}

pub async fn list_property_valuations(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(asset_id): Path<Uuid>,
) -> Result<Json<Vec<PropertyValuation>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let rows = store_list_property_valuations(&state.pool, context.household.id, asset_id)
        .await
        .map_err(map_asset_store_error)?;
    Ok(Json(rows.into_iter().map(valuation_response).collect()))
}

pub async fn create_property_valuation(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(asset_id): Path<Uuid>,
    Json(payload): Json<PropertyValuationCreate>,
) -> Result<Json<PropertyValuation>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    if payload.value <= Decimal::ZERO {
        return Err(ApiError(ApplicationError::Validation(
            "Valuation value must be greater than zero.".to_owned(),
        )));
    }
    let row = store_create_property_valuation(
        &state.pool,
        context.household.id,
        asset_id,
        payload.value,
        payload.effective_date,
        &context.household.base_currency,
    )
    .await
    .map_err(map_asset_store_error)?;
    Ok(Json(valuation_response(row)))
}

pub async fn delete_property_valuation(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((asset_id, valuation_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "delete")?;
    store_delete_property_valuation(&state.pool, context.household.id, asset_id, valuation_id)
        .await
        .map_err(map_asset_store_error)?;
    Ok(Json(json!({ "ok": true })))
}

fn valuation_response(row: ValuationRow) -> PropertyValuation {
    PropertyValuation {
        id: row.id,
        value: row.value,
        effective_date: row.effective_date,
    }
}

fn asset_input(payload: &AssetWritePayload, base_currency: &str, timezone: &str) -> AssetInput {
    let registration = account_registration_value(&payload.category, payload.account_registration);
    AssetInput {
        name: payload.name.trim().to_owned(),
        total_cost: payload.total_cost,
        valuation_date: payload.valuation_date,
        status: payload.status.clone(),
        started_on: payload.started_on,
        ended_on: payload.ended_on,
        notes: payload.notes.clone(),
        kind: payload.kind.clone(),
        category: payload.category.clone(),
        account_type: payload.account_type.map(|value| value.as_str().to_owned()),
        account_registration: registration.map(str::to_owned),
        holdings: payload
            .holdings
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(holding_input)
            .collect(),
        depreciation_rate: payload.depreciation_rate,
        depreciation_enabled: payload.depreciation_enabled,
        utilities_enabled: payload.utilities_enabled,
        projects_enabled: payload.projects_enabled,
        expenses_enabled: payload.expenses_enabled,
        linked_category_ids: payload.linked_category_ids.clone(),
        details: payload.details.clone(),
        base_currency: base_currency.to_owned(),
        household_timezone: timezone.to_owned(),
    }
}

fn asset_update_input(
    payload: &AssetUpdatePayload,
    base_currency: &str,
    timezone: &str,
) -> AssetInput {
    let registration = account_registration_value(&payload.category, payload.account_registration);
    AssetInput {
        name: payload.name.trim().to_owned(),
        total_cost: payload.total_cost,
        valuation_date: payload.valuation_date,
        status: payload.status.clone(),
        started_on: payload.started_on,
        ended_on: payload.ended_on,
        notes: payload.notes.clone(),
        kind: "project".to_owned(),
        category: payload.category.clone(),
        account_type: payload.account_type.map(|value| value.as_str().to_owned()),
        account_registration: registration.map(str::to_owned),
        holdings: payload
            .holdings
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(holding_input)
            .collect(),
        depreciation_rate: payload.depreciation_rate,
        depreciation_enabled: payload.depreciation_enabled,
        utilities_enabled: payload.utilities_enabled,
        projects_enabled: payload.projects_enabled,
        expenses_enabled: payload.expenses_enabled,
        linked_category_ids: payload.linked_category_ids.clone(),
        details: payload.details.clone(),
        base_currency: base_currency.to_owned(),
        household_timezone: timezone.to_owned(),
    }
}

/// Registration defaults to 'regular' when an account payload omits or nulls
/// it; non-account categories must not carry it (validation rejects that).
fn account_registration_value(
    category: &str,
    registration: Option<AssetAccountRegistration>,
) -> Option<&'static str> {
    if category == "account" {
        Some(
            registration
                .map(AssetAccountRegistration::as_str)
                .unwrap_or("regular"),
        )
    } else {
        None
    }
}

fn holding_input(payload: &AccountHoldingPayload) -> AccountHoldingInput {
    AccountHoldingInput {
        name: payload.name.trim().to_owned(),
        ticker: payload
            .ticker
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_ascii_uppercase),
        quantity: payload.quantity,
        unit_price: payload.unit_price,
        value: payload.value,
        purchased_on: payload.purchased_on,
        sold_on: payload.sold_on,
        sell_value: payload.sell_value,
        notes: payload.notes.clone(),
    }
}

fn holding_response(row: HoldingsRow) -> AccountHoldingResponse {
    AccountHoldingResponse {
        id: row.id,
        name: row.name,
        ticker: row.ticker,
        quantity: row.quantity,
        unit_price: row.unit_price,
        value: row.value,
        purchased_on: row.purchased_on,
        sold_on: row.sold_on,
        sell_value: row.sell_value,
        notes: row.notes,
    }
}

fn asset_response(details: AssetDetails, today: NaiveDate) -> AssetSummary {
    let row = details.row;
    let linked_asset_name = details.linked_asset_name;
    let linked_category_ids = details.linked_category_ids;
    let linked_expense_total = details.linked_expense_total;
    let holdings_responses = details
        .holdings
        .into_iter()
        .map(holding_response)
        .collect::<Vec<_>>();
    let months = months_between(row.valuation_date, today);
    let effective_rate = if row.depreciation_enabled {
        row.depreciation_rate
    } else {
        Decimal::ZERO
    };
    let current_total_cost =
        compounded_value(row.total_cost, effective_rate, months).unwrap_or(row.total_cost);
    let (details_json, item_count, completed_count, completed_cost, total_items) =
        details_from_items(&details.items, &row.kind, row.linked_asset_id);
    let derived_status = if item_count == 0 {
        row.status.clone()
    } else if completed_count == item_count {
        "completed".to_owned()
    } else if completed_count > 0 {
        "active".to_owned()
    } else {
        "planned".to_owned()
    };
    let completion_percent = if total_items > Decimal::ZERO {
        (completed_cost / total_items * Decimal::from(100)).round_dp(1)
    } else if item_count > 0 {
        (Decimal::from(completed_count) / Decimal::from(item_count) * Decimal::from(100))
            .round_dp(1)
    } else if derived_status == "completed" {
        Decimal::from(100)
    } else {
        Decimal::ZERO
    };
    AssetSummary {
        id: row.id,
        name: row.name,
        total_cost: current_total_cost,
        valuation_date: row.valuation_date,
        status: derived_status.clone(),
        started_on: row.started_on,
        ended_on: row.ended_on,
        notes: row.notes,
        details: details_json,
        item_count,
        completed_item_count: completed_count,
        completed_cost,
        completion_percent,
        derived_status: Some(derived_status),
        kind: row.kind,
        category: row.category,
        account_type: row
            .account_type
            .as_deref()
            .and_then(AssetAccountType::parse),
        account_registration: row
            .account_registration
            .as_deref()
            .and_then(AssetAccountRegistration::parse),
        holdings: holdings_responses,
        account_id: row.account_id,
        linked_asset_id: row.linked_asset_id,
        linked_asset_name,
        depreciation_rate: row.depreciation_rate,
        depreciation_enabled: row.depreciation_enabled,
        original_total_cost: row.total_cost,
        utilities_enabled: row.utilities_enabled,
        projects_enabled: row.projects_enabled,
        expenses_enabled: row.expenses_enabled,
        linked_category_ids,
        linked_expense_total,
    }
}

fn loan_summary(row: LoanRow) -> LoanSummary {
    let payoff = simulate_loan_payoff(
        row.current_balance,
        row.interest_rate,
        row.monthly_payment,
        Decimal::ZERO,
    )
    .ok();
    LoanSummary {
        id: row.id,
        name: row.name,
        current_balance: row.current_balance,
        monthly_payment: row.monthly_payment,
        interest_rate: row.interest_rate,
        original_balance: Some(row.original_balance),
        start_date: row.start_date,
        end_date: row.end_date,
        notes: row.notes,
        projected_payoff_months: payoff.as_ref().map(|value| value.months),
        interest_remaining: payoff.map(|value| value.interest),
        details: row.terms_payload,
        linked_property_id: row.linked_property_id,
    }
}

fn details_from_items(
    items: &[ItemRow],
    kind: &str,
    linked_asset_id: Option<Uuid>,
) -> (Value, usize, usize, Decimal, Decimal) {
    let mut rooms = Vec::<Value>::new();
    let mut item_count = 0_usize;
    let mut completed_count = 0_usize;
    let mut completed_cost = Decimal::ZERO;
    let mut total_items = Decimal::ZERO;
    for item in items {
        item_count += 1;
        total_items += item.total_cost;
        if item.completed {
            completed_count += 1;
            completed_cost += item.total_cost;
        }
        let room_position = rooms
            .iter()
            .position(|room| room["id"] == item.room_id.to_string());
        let room_index = room_position.unwrap_or_else(|| {
            rooms.push(json!({
                "id": item.room_id,
                "name": item.room_name,
                "notes": item.room_notes,
                "_sort": item.room_sort,
                "sections": []
            }));
            rooms.len() - 1
        });
        let Some(sections) = rooms[room_index]["sections"].as_array_mut() else {
            continue;
        };
        let section_position = sections
            .iter()
            .position(|section| section["id"] == item.section_id.to_string());
        let section_index = section_position.unwrap_or_else(|| {
            sections.push(json!({
                "id": item.section_id,
                "name": item.section_name,
                "notes": item.section_notes,
                "_sort": item.section_sort,
                "items": []
            }));
            sections.len() - 1
        });
        if let Some(section_items) = sections[section_index]["items"].as_array_mut() {
            section_items.push(json!({
                "name": item.item_name,
                "unit_price": item.unit_price,
                "quantity": item.quantity,
                "total_cost": item.total_cost,
                "completed": item.completed,
                "notes": item.item_notes,
                "_sort": item.item_sort
            }));
        }
    }
    for room in &mut rooms {
        if let Some(object) = room.as_object_mut() {
            object.remove("id");
            object.remove("_sort");
            if let Some(sections) = object.get_mut("sections").and_then(Value::as_array_mut) {
                for section in sections {
                    if let Some(section_object) = section.as_object_mut() {
                        section_object.remove("id");
                        section_object.remove("_sort");
                        if let Some(section_items) = section_object
                            .get_mut("items")
                            .and_then(Value::as_array_mut)
                        {
                            for item in section_items {
                                if let Some(item_object) = item.as_object_mut() {
                                    item_object.remove("_sort");
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    (
        json!({
            "rooms": rooms,
            "kind": kind,
            "linked_asset_id": linked_asset_id
        }),
        item_count,
        completed_count,
        completed_cost.round_dp(2),
        total_items.round_dp(2),
    )
}

fn validate_loan(payload: &ManualLoanCreate) -> Result<(), ApiError> {
    if !matches!(
        payload.liability_type.as_str(),
        "debt" | "loan" | "mortgage"
    ) {
        return Err(ApiError(ApplicationError::Validation(
            "Loan details are invalid.".to_owned(),
        )));
    }
    validate_loan_fields(LoanValidation {
        name: &payload.name,
        current_balance: payload.current_balance,
        monthly_payment: payload.monthly_payment,
        original_balance: payload.original_balance,
        interest_rate: payload.interest_rate,
        start_date: payload.start_date,
        end_date: payload.end_date,
    })
}

struct LoanValidation<'a> {
    name: &'a str,
    current_balance: Decimal,
    monthly_payment: Decimal,
    original_balance: Option<Decimal>,
    interest_rate: Decimal,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
}

fn validate_loan_fields(payload: LoanValidation<'_>) -> Result<(), ApiError> {
    if payload.name.trim().is_empty()
        || payload.current_balance.is_sign_negative()
        || payload.monthly_payment.is_sign_negative()
        || payload
            .original_balance
            .is_some_and(|value| value.is_sign_negative())
        || payload.interest_rate.is_sign_negative()
        || payload.interest_rate > Decimal::ONE
    {
        return Err(ApiError(ApplicationError::Validation(
            "Loan details are invalid.".to_owned(),
        )));
    }
    if payload
        .end_date
        .zip(payload.start_date)
        .is_some_and(|(end, start)| end < start)
    {
        return Err(ApiError(ApplicationError::Validation(
            "End date must not be before start date.".to_owned(),
        )));
    }
    Ok(())
}

struct AssetValidation<'a> {
    name: &'a str,
    total_cost: Decimal,
    status: &'a str,
    kind: &'a str,
    category: &'a str,
    account_type: Option<AssetAccountType>,
    account_registration: Option<AssetAccountRegistration>,
    holdings: Option<&'a [AccountHoldingPayload]>,
    depreciation_rate: Decimal,
    started_on: Option<NaiveDate>,
    ended_on: Option<NaiveDate>,
}

fn validate_asset(input: AssetValidation<'_>) -> Result<(), ApiError> {
    let account_details_valid = if input.category == "account" {
        // Accounts require a subtype; registration is optional here because
        // the input mapping defaults it to 'regular'.
        input.account_type.is_some()
            && input
                .holdings
                .is_none_or(|holdings| holdings.iter().all(validate_holding))
    } else {
        input.account_type.is_none()
            && input.account_registration.is_none()
            && input.holdings.is_none()
    };
    if input.name.trim().is_empty()
        || input.total_cost.is_sign_negative()
        || !matches!(input.status, "planned" | "active" | "completed")
        || !matches!(input.kind, "asset" | "project")
        || !matches!(input.category, "property" | "vehicle" | "other" | "account")
        || input.depreciation_rate < -Decimal::ONE
        || input.depreciation_rate > Decimal::ONE
        || !account_details_valid
    {
        return Err(ApiError(ApplicationError::Validation(
            "Asset or project details are invalid.".to_owned(),
        )));
    }
    if input
        .ended_on
        .zip(input.started_on)
        .is_some_and(|(end, start)| end < start)
    {
        return Err(ApiError(ApplicationError::Validation(
            "End date must not be before start date.".to_owned(),
        )));
    }
    Ok(())
}

/// A holding's value may be zero, but quantities must be strictly positive
/// and dates must not be inverted; amounts must never be negative.
fn validate_holding(holding: &AccountHoldingPayload) -> bool {
    checkbook_domain::holding_prices::normalize_ticker(holding.ticker.as_deref()).is_ok()
        && !holding.name.trim().is_empty()
        && !holding.value.is_sign_negative()
        && holding
            .quantity
            .is_none_or(|quantity| quantity > Decimal::ZERO)
        && holding
            .unit_price
            .is_none_or(|price| !price.is_sign_negative())
        && holding
            .sell_value
            .is_none_or(|value| !value.is_sign_negative())
        && holding
            .sold_on
            .zip(holding.purchased_on)
            .is_none_or(|(sold, purchased)| sold >= purchased)
}

pub(crate) fn map_asset_store_error(error: AssetStoreError) -> ApiError {
    match error {
        AssetStoreError::NotFound => ApiError(ApplicationError::NotFound),
        AssetStoreError::Validation(detail) => ApiError(ApplicationError::Validation(detail)),
        AssetStoreError::Database(error) => {
            if let Some(validation) = crate::error::expense_source_validation(&error) {
                return validation;
            }
            tracing::error!(error = %error, "asset storage operation failed");
            ApiError(ApplicationError::Storage)
        }
    }
}
