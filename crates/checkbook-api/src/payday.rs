use std::collections::BTreeMap;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use checkbook_application::{ApplicationError, Clock, SystemClock};
use checkbook_domain::{
    month_start_at,
    payday::{self, Allocation, ExpenseBucket},
    shift_month_start,
};
use checkbook_postgres::{payday as store, planning::PlanningStoreError};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    ApiState,
    auth::{allowed_scope_values, authenticated, require_permission},
    error::ApiError,
};

#[derive(Debug, Deserialize, ToSchema)]
pub struct MonthQuery {
    pub month: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct Payload {
    /// Lower positions appear first within a section; omitted updates preserve the position.
    #[schema(minimum = 0)]
    pub position: Option<i32>,
    pub month: Option<String>,
    pub title: String,
    pub section: String,
    pub kind: String,
    pub expense_group_id: Option<Uuid>,
    pub category_id: Option<Uuid>,
    pub subcategory_id: Option<Uuid>,
    pub amount: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub completed: bool,
    /// Set to enable or disable future recurrence; omit to preserve existing behavior.
    pub recurring: Option<bool>,
    pub template_id: Option<Uuid>,
    pub key: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ApplyPayload {
    pub month: String,
    pub items: Vec<Payload>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct Item {
    pub position: i32,
    pub id: Uuid,
    pub template_id: Option<Uuid>,
    pub title: String,
    pub section: String,
    pub kind: String,
    pub expense_group_id: Option<Uuid>,
    pub category_id: Option<Uuid>,
    pub subcategory_id: Option<Uuid>,
    pub expense_group_name: Option<String>,
    pub category_name: Option<String>,
    pub subcategory_name: Option<String>,
    pub amount: String,
    pub notes: String,
    pub source: String,
    pub completed: bool,
    pub completed_at: Option<String>,
    pub actual_amount: Option<String>,
    pub difference: Option<String>,
    pub percentage: Option<String>,
}
#[derive(Debug, Serialize, ToSchema)]
pub struct Suggestion {
    pub key: String,
    pub title: String,
    pub section: String,
    pub kind: String,
    pub expense_group_id: Option<Uuid>,
    pub category_id: Option<Uuid>,
    pub subcategory_id: Option<Uuid>,
    pub expense_group_name: Option<String>,
    pub category_name: Option<String>,
    pub subcategory_name: Option<String>,
    pub amount: String,
    pub notes: String,
    pub reason: String,
    pub template_id: Option<Uuid>,
}
#[derive(Debug, Serialize, ToSchema)]
pub struct UnplannedActual {
    pub expense_group_id: Option<Uuid>,
    pub category_id: Option<Uuid>,
    pub subcategory_id: Option<Uuid>,
    pub expense_group_name: Option<String>,
    pub category_name: Option<String>,
    pub subcategory_name: Option<String>,
    pub amount: String,
}
#[derive(Debug, Serialize, ToSchema)]
pub struct Response {
    pub month: String,
    pub current_month: String,
    pub provisional: bool,
    pub currency: String,
    pub income: String,
    pub total_allocated: String,
    pub remaining: String,
    pub completed_total: String,
    pub actual_total: String,
    pub unplanned_actual_total: String,
    pub allocations: Vec<Item>,
    pub templates: Vec<Item>,
    pub suggestions: Vec<Suggestion>,
    pub unplanned_actuals: Vec<UnplannedActual>,
}
#[derive(Debug, Serialize, ToSchema)]
pub struct SuggestionsResponse {
    pub month: String,
    pub suggestions: Vec<Suggestion>,
}

fn validation(message: impl Into<String>) -> ApiError {
    ApiError(ApplicationError::Validation(message.into()))
}
fn map_error(error: PlanningStoreError) -> ApiError {
    match error {
        PlanningStoreError::NotFound(name) => {
            ApiError(ApplicationError::NotFoundMessage(name.into()))
        }
        PlanningStoreError::Forbidden => ApiError(ApplicationError::Forbidden),
        PlanningStoreError::Validation(message) | PlanningStoreError::BadRequest(message) => {
            validation(message)
        }
        _ => ApiError(ApplicationError::Storage),
    }
}
fn parse_month(month: Option<&str>, current: NaiveDate) -> Result<NaiveDate, ApiError> {
    match month {
        None => Ok(current),
        Some(value) if value.len() == 7 => {
            NaiveDate::parse_from_str(&format!("{value}-01"), "%Y-%m-%d")
                .map_err(|_| validation("invalid month"))
        }
        _ => Err(validation("month must be YYYY-MM")),
    }
}
fn decimal(value: Decimal) -> String {
    value.round_dp(2).to_string()
}
fn input(payload: &Payload, suggestion: bool) -> Result<store::Input, ApiError> {
    let amount = payload
        .amount
        .parse::<Decimal>()
        .map_err(|_| validation("invalid decimal amount"))?;
    if suggestion
        && payload
            .key
            .as_ref()
            .is_none_or(|key| key.trim().is_empty() || key.len() > 300)
    {
        return Err(validation("suggestion key required"));
    }
    if payload.position.is_some_and(|position| position < 0) {
        return Err(validation("position must be nonnegative"));
    }
    Ok(store::Input {
        position: payload.position,
        title: payload.title.clone(),
        section: payload.section.clone(),
        kind: payload.kind.clone(),
        expense_group_id: payload.expense_group_id,
        category_id: payload.category_id,
        subcategory_id: payload.subcategory_id,
        amount,
        notes: payload.notes.clone(),
        completed: payload.completed,
        recurring: payload.recurring,
        template_id: payload.template_id,
        source_key: if suggestion {
            payload.key.clone()
        } else {
            None
        },
    })
}
fn item(row: store::Item, comparison: Option<&payday::Comparison>) -> Item {
    Item {
        id: row.id,
        position: row.position,
        template_id: row.template_id,
        title: row.title,
        section: row.section,
        kind: row.kind,
        expense_group_id: row.expense_group_id,
        expense_group_name: row.expense_group_name.clone(),
        category_id: row.category_id,
        subcategory_id: row.subcategory_id,
        category_name: row.category_name,
        subcategory_name: row.subcategory_name,
        amount: decimal(row.amount),
        notes: row.notes,
        source: row.source,
        completed: row.completed_at.is_some(),
        completed_at: row.completed_at.map(|time| time.to_rfc3339()),
        actual_amount: comparison.and_then(|r| r.actual).map(decimal),
        difference: comparison.and_then(|r| r.difference).map(decimal),
        percentage: comparison.and_then(|r| r.percentage).map(decimal),
    }
}

fn suggestions(records: &store::Records, month: NaiveDate, current: NaiveDate) -> Vec<Suggestion> {
    let end = month.min(current);
    let mut result = BTreeMap::<String, Suggestion>::new();
    let existing = records
        .allocations
        .iter()
        .filter_map(|row| row.source_key.as_ref())
        .collect::<Vec<_>>();
    for actual in records.actuals.iter().filter(|actual| actual.month < end) {
        let Some(category) = actual.category_id else {
            continue;
        };
        let key = format!(
            "expense:{category}:{}",
            actual
                .subcategory_id
                .map(|id| id.to_string())
                .unwrap_or_default()
        );
        if existing.contains(&&key)
            || records.allocations.iter().any(|row| {
                row.kind == "expense"
                    && ((row.category_id == actual.category_id
                        && (row.subcategory_id.is_none()
                            || row.subcategory_id == actual.subcategory_id))
                        || (row.category_id.is_none()
                            && row.expense_group_id.is_some()
                            && row.expense_group_id == actual.expense_group_id))
            })
        {
            continue;
        }
        let values = std::array::from_fn(|index| {
            let previous = shift_month_start(end, -(index as i32) - 1).ok();
            records
                .actuals
                .iter()
                .filter(|row| {
                    Some(row.month) == previous
                        && row.category_id == actual.category_id
                        && row.subcategory_id == actual.subcategory_id
                })
                .map(|row| row.amount)
                .sum()
        });
        let template = records.templates.iter().find(|row| {
            row.kind == "expense"
                && row.category_id == actual.category_id
                && row.subcategory_id == actual.subcategory_id
        });
        let decision = payday::suggest(values, None, None, template.map(|row| row.amount), true);
        let section = match decision.section {
            payday::SuggestedSection::Mandatory => "mandatory",
            payday::SuggestedSection::Monthly => "monthly",
            payday::SuggestedSection::Flexible => "flexible",
        };
        result.insert(key.clone(),Suggestion {key,title:actual.subcategory_name.clone().or(actual.category_name.clone()).unwrap_or_else(||"Expense".into()),section:section.into(),kind:"expense".into(),expense_group_id:actual.expense_group_id,expense_group_name:actual.expense_group_name.clone(),category_id:actual.category_id,subcategory_id:actual.subcategory_id,category_name:actual.category_name.clone(),subcategory_name:actual.subcategory_name.clone(),amount:decimal(decision.amount),notes:String::new(),reason:format!("Average actual spending across the last three completed months (including zero months); observed in {} months",decision.recurring_months),template_id:template.map(|row|row.id)});
    }
    for (_, row) in &records.history {
        let key = row.source_key.clone().unwrap_or_else(|| {
            format!(
                "history:{}:{}:{}:{}",
                row.kind,
                row.expense_group_id
                    .map(|id| id.to_string())
                    .unwrap_or_default(),
                row.category_id.map(|id| id.to_string()).unwrap_or_default(),
                row.title.to_lowercase()
            )
        });
        if existing.contains(&&key)
            || result.contains_key(&key)
            || records.allocations.iter().any(|existing| {
                existing.kind == row.kind
                    && existing.expense_group_id == row.expense_group_id
                    && existing.category_id == row.category_id
                    && existing.subcategory_id == row.subcategory_id
                    && existing.title.eq_ignore_ascii_case(&row.title)
            })
        {
            continue;
        }
        // Actual expense evidence outranks historical planned/completed amounts.
        if row.kind == "expense"
            && result.values().any(|s| {
                s.expense_group_id == row.expense_group_id
                    && s.category_id == row.category_id
                    && s.subcategory_id == row.subcategory_id
            })
        {
            continue;
        }
        let completed = records
            .history
            .iter()
            .map(|(_, candidate)| candidate)
            .find(|candidate| {
                candidate.completed_at.is_some()
                    && candidate.kind == row.kind
                    && candidate.expense_group_id == row.expense_group_id
                    && candidate.category_id == row.category_id
                    && candidate.subcategory_id == row.subcategory_id
                    && candidate.title.eq_ignore_ascii_case(&row.title)
            });
        let decision = payday::suggest(
            [Decimal::ZERO; 3],
            Some(row.amount),
            completed.map(|row| row.amount),
            None,
            row.kind == "expense",
        );
        result.insert(
            key.clone(),
            Suggestion {
                key,
                title: row.title.clone(),
                section: row.section.clone(),
                kind: row.kind.clone(),
                expense_group_id: row.expense_group_id,
                expense_group_name: row.expense_group_name.clone(),
                category_id: row.category_id,
                subcategory_id: row.subcategory_id,
                category_name: row.category_name.clone(),
                subcategory_name: row.subcategory_name.clone(),
                amount: decimal(decision.amount),
                notes: row.notes.clone(),
                reason: if completed.is_some() {
                    "Previously completed allocation"
                } else {
                    "Historical monthly plan"
                }
                .into(),
                template_id: row.template_id,
            },
        );
    }
    for row in &records.templates {
        let key = format!("template:{}", row.id);
        if existing.contains(&&key)
            || records
                .allocations
                .iter()
                .any(|existing| existing.template_id == Some(row.id))
            || result
                .values()
                .any(|suggestion| suggestion.template_id == Some(row.id))
        {
            continue;
        }
        result.insert(
            key.clone(),
            Suggestion {
                key,
                title: row.title.clone(),
                section: row.section.clone(),
                kind: row.kind.clone(),
                expense_group_id: row.expense_group_id,
                expense_group_name: row.expense_group_name.clone(),
                category_id: row.category_id,
                subcategory_id: row.subcategory_id,
                category_name: row.category_name.clone(),
                subcategory_name: row.subcategory_name.clone(),
                amount: decimal(row.amount),
                notes: row.notes.clone(),
                reason: "Current recurring template; apply explicitly to this saved month".into(),
                template_id: Some(row.id),
            },
        );
    }
    result.into_values().collect()
}

async fn load_response(
    state: &ApiState,
    headers: &HeaderMap,
    requested: Option<&str>,
) -> Result<Response, ApiError> {
    let context = authenticated(state, headers).await?;
    require_permission(&context, "planning", "read")?;
    let current = month_start_at(&context.household.timezone, SystemClock.now())
        .map_err(|error| validation(error.to_string()))?;
    let month = parse_month(requested, current)?;
    let records = store::load(
        &state.pool,
        context.household.id,
        month,
        current,
        &allowed_scope_values(&context),
    )
    .await
    .map_err(map_error)?;
    let suggestions = suggestions(&records, month, current);
    let actuals = records
        .actuals
        .iter()
        .filter(|row| row.month == month)
        .filter_map(|row| {
            row.category_id.map(|category_id| {
                (
                    ExpenseBucket {
                        category_id,
                        subcategory_id: row.subcategory_id,
                    },
                    row.amount,
                )
            })
        })
        .collect::<BTreeMap<_, _>>();
    let allocations = records
        .allocations
        .iter()
        .map(|row| Allocation {
            id: row.id,
            bucket: if row.kind == "expense" {
                row.category_id.map(|category_id| ExpenseBucket {
                    category_id,
                    subcategory_id: row.subcategory_id,
                })
            } else {
                None
            },
            expense_group_id: (row.kind == "expense"
                && (row.category_id.is_some() || row.category_name.is_none()))
            .then_some(row.expense_group_id)
            .flatten(),
            amount: row.amount,
            completed: row.completed_at.is_some(),
        })
        .collect::<Vec<_>>();
    let category_groups = records
        .actuals
        .iter()
        .filter_map(|row| Some((row.category_id?, row.expense_group_id?)))
        .collect();
    let reconciliation =
        payday::reconcile_with_groups(records.income, &allocations, &actuals, &category_groups);
    let unplanned_actuals = records
        .actuals
        .iter()
        .filter(|row| {
            row.month == month
                && row.category_id.is_none_or(|category_id| {
                    reconciliation.unplanned.contains_key(&ExpenseBucket {
                        category_id,
                        subcategory_id: row.subcategory_id,
                    })
                })
        })
        .map(|row| UnplannedActual {
            expense_group_id: row.expense_group_id,
            expense_group_name: row.expense_group_name.clone(),
            category_id: row.category_id,
            subcategory_id: row.subcategory_id,
            category_name: row.category_name.clone(),
            subcategory_name: row.subcategory_name.clone(),
            amount: decimal(row.amount),
        })
        .collect::<Vec<_>>();
    let unplanned_total = unplanned_actuals
        .iter()
        .filter_map(|row| row.amount.parse::<Decimal>().ok())
        .sum();
    Ok(Response {
        month: month.format("%Y-%m").to_string(),
        current_month: current.format("%Y-%m").to_string(),
        provisional: month >= current,
        currency: records.currency,
        income: decimal(records.income),
        total_allocated: decimal(reconciliation.allocated),
        remaining: decimal(reconciliation.remaining),
        completed_total: decimal(reconciliation.completed),
        actual_total: decimal(
            records
                .actuals
                .iter()
                .filter(|row| row.month == month)
                .map(|row| row.amount)
                .sum(),
        ),
        unplanned_actual_total: decimal(unplanned_total),
        allocations: records
            .allocations
            .into_iter()
            .map(|row| {
                let comparison = reconciliation.comparisons.iter().find(|c| c.id == row.id);
                item(row, comparison)
            })
            .collect(),
        templates: records
            .templates
            .into_iter()
            .map(|row| item(row, None))
            .collect(),
        suggestions,
        unplanned_actuals,
    })
}

#[utoipa::path(get,path="/api/payday-planner",operation_id="getPaydayPlanner",params(("month"=Option<String>,Query)),responses((status=200,body=Response)))]
pub async fn get(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<MonthQuery>,
) -> Result<Json<Response>, ApiError> {
    Ok(Json(
        load_response(&state, &headers, query.month.as_deref()).await?,
    ))
}
#[utoipa::path(get,path="/api/payday-planner/suggestions",operation_id="getPaydaySuggestions",responses((status=200,body=SuggestionsResponse)))]
pub async fn preview(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<MonthQuery>,
) -> Result<Json<SuggestionsResponse>, ApiError> {
    let response = load_response(&state, &headers, query.month.as_deref()).await?;
    Ok(Json(SuggestionsResponse {
        month: response.month,
        suggestions: response.suggestions,
    }))
}
#[utoipa::path(get,path="/api/payday-planner/templates",operation_id="getPaydayTemplates",responses((status=200,body=Vec<Item>)))]
pub async fn templates(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Item>>, ApiError> {
    Ok(Json(load_response(&state, &headers, None).await?.templates))
}

async fn save_allocation(
    state: &ApiState,
    headers: &HeaderMap,
    id: Option<Uuid>,
    payload: Payload,
) -> Result<Json<Response>, ApiError> {
    let context = authenticated(state, headers).await?;
    require_permission(&context, "planning", "write")?;
    let current = month_start_at(&context.household.timezone, SystemClock.now())
        .map_err(|error| validation(error.to_string()))?;
    let month = parse_month(payload.month.as_deref(), current)?;
    store::save(
        &state.pool,
        context.household.id,
        month,
        id,
        &input(&payload, false)?,
        SystemClock.now(),
    )
    .await
    .map_err(map_error)?;
    Ok(Json(
        load_response(state, headers, Some(&month.format("%Y-%m").to_string())).await?,
    ))
}
#[utoipa::path(post,path="/api/payday-planner/allocations",operation_id="createPaydayAllocation",request_body=Payload,responses((status=200,body=Response)))]
pub async fn create(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<Payload>,
) -> Result<Json<Response>, ApiError> {
    save_allocation(&state, &headers, None, payload).await
}
#[utoipa::path(put,path="/api/payday-planner/allocations/{id}",operation_id="updatePaydayAllocation",request_body=Payload,responses((status=200,body=Response)))]
pub async fn update(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<Payload>,
) -> Result<Json<Response>, ApiError> {
    save_allocation(&state, &headers, Some(id), payload).await
}
#[utoipa::path(post,path="/api/payday-planner/apply",operation_id="applyPaydaySuggestions",request_body=ApplyPayload,responses((status=200,body=Response)))]
pub async fn apply(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<ApplyPayload>,
) -> Result<Json<Response>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "planning", "write")?;
    let current = month_start_at(&context.household.timezone, SystemClock.now())
        .map_err(|error| validation(error.to_string()))?;
    let month = parse_month(Some(&payload.month), current)?;
    if payload.items.len() > 200 {
        return Err(validation("too many suggestions"));
    }
    let inputs = payload
        .items
        .iter()
        .map(|p| input(p, true))
        .collect::<Result<Vec<_>, _>>()?;
    store::apply(
        &state.pool,
        context.household.id,
        month,
        &inputs,
        SystemClock.now(),
    )
    .await
    .map_err(map_error)?;
    Ok(Json(
        load_response(&state, &headers, Some(&payload.month)).await?,
    ))
}
async fn save_template(
    state: &ApiState,
    headers: &HeaderMap,
    id: Option<Uuid>,
    payload: Payload,
) -> Result<Json<serde_json::Value>, ApiError> {
    let context = authenticated(state, headers).await?;
    require_permission(&context, "planning", "write")?;
    let id = store::save_template(
        &state.pool,
        context.household.id,
        id,
        &input(&payload, false)?,
    )
    .await
    .map_err(map_error)?;
    Ok(Json(serde_json::json!({"id":id})))
}
#[utoipa::path(post,path="/api/payday-planner/templates",operation_id="createPaydayTemplate",request_body=Payload,responses((status=200)))]
pub async fn create_template(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<Payload>,
) -> Result<Json<serde_json::Value>, ApiError> {
    save_template(&state, &headers, None, payload).await
}
#[utoipa::path(put,path="/api/payday-planner/templates/{id}",operation_id="updatePaydayTemplate",request_body=Payload,responses((status=200)))]
pub async fn update_template(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<Payload>,
) -> Result<Json<serde_json::Value>, ApiError> {
    save_template(&state, &headers, Some(id), payload).await
}
async fn remove(
    state: &ApiState,
    headers: &HeaderMap,
    id: Uuid,
    template: bool,
) -> Result<Json<serde_json::Value>, ApiError> {
    let context = authenticated(state, headers).await?;
    require_permission(&context, "planning", "delete")?;
    store::delete(&state.pool, context.household.id, id, template)
        .await
        .map_err(map_error)?;
    Ok(Json(serde_json::json!({"ok":true})))
}
#[utoipa::path(delete,path="/api/payday-planner/allocations/{id}",operation_id="deletePaydayAllocation",responses((status=200)))]
pub async fn delete(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    remove(&state, &headers, id, false).await
}
#[utoipa::path(delete,path="/api/payday-planner/templates/{id}",operation_id="deletePaydayTemplate",responses((status=200)))]
pub async fn delete_template(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    remove(&state, &headers, id, true).await
}

#[cfg(test)]
mod position_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn position_is_optional_bounded_and_nonnegative() -> anyhow::Result<()> {
        let payload =
            json!({"title":"Reserve","section":"flexible","kind":"savings","amount":"10"});
        let parsed: Payload = serde_json::from_value(payload.clone())?;
        assert_eq!(
            input(&parsed, false)
                .map_err(|_| anyhow::anyhow!("valid payload rejected"))?
                .position,
            None
        );
        for position in [0, i32::MAX] {
            let mut value = payload.clone();
            value["position"] = json!(position);
            let parsed: Payload = serde_json::from_value(value)?;
            assert_eq!(
                input(&parsed, false)
                    .map_err(|_| anyhow::anyhow!("valid position rejected"))?
                    .position,
                Some(position)
            );
        }
        let mut negative = payload.clone();
        negative["position"] = json!(-1);
        let parsed: Payload = serde_json::from_value(negative)?;
        assert!(input(&parsed, false).is_err());
        for invalid in [json!(2147483648_u64), json!(1.5), json!("1")] {
            let mut value = payload.clone();
            value["position"] = invalid;
            assert!(serde_json::from_value::<Payload>(value).is_err());
        }
        Ok(())
    }
}
