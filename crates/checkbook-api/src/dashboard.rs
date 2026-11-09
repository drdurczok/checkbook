use std::{
    cmp::Reverse,
    collections::{BTreeMap, BTreeSet},
};

use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use checkbook_application::ApplicationError;
use checkbook_domain::local_date_at;
use checkbook_domain::simulate_loan_payoff;
use checkbook_postgres::{
    dashboard::{
        AccountPointRow, BreakdownRow, CashFlowRow, DashboardData, DashboardFilter,
        ExpenseTrendRow, FeedRow, GoalRow, LoanRow, UpcomingRow, UtilityTrendRow,
        load_analytics_data, load_overview_data,
    },
    imports::DataLoadHistoryRecord,
};
use chrono::{NaiveDate, Utc};
use rust_decimal::{Decimal, RoundingStrategy};
use serde::Deserialize;
use serde_json::json;

use crate::{
    ApiState,
    auth::{allowed_scope_values, authenticated},
    dto::{
        AnalyticsResponse, BreakdownPointResponse, CashFlowPointResponse, DashboardMetricResponse,
        DashboardOverviewResponse, FeedItemResponse, GoalProgressResponse, ImportRunResponse,
        LoanSummary, MonthlyBreakdownPointResponse, MonthlyPointResponse,
        NetWorthComponentGroupResponse, NetWorthComponentRowResponse, UpcomingPlannedItemResponse,
        UtilitySeriesPointResponse,
    },
    error::ApiError,
};

#[derive(Debug, Default, Deserialize)]
pub struct DashboardQuery {
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    #[serde(default)]
    include_planned: bool,
}

type AccountComponents = (
    BTreeMap<String, Decimal>,
    BTreeMap<String, Decimal>,
    BTreeMap<String, Decimal>,
    BTreeMap<String, Decimal>,
);

pub async fn overview(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<DashboardQuery>,
) -> Result<Json<DashboardOverviewResponse>, ApiError> {
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
    let today = local_date_at(&context.household.timezone, Utc::now()).map_err(|error| {
        tracing::error!(%error, "household timezone is invalid");
        ApiError(ApplicationError::Storage)
    })?;
    crate::recurring_expenses::refresh(&state, context.household.id, &context.household.timezone)
        .await?;
    let scopes = allowed_scope_values(&context);
    let result = load_overview_data(
        &state.pool,
        context.household.id,
        &scopes,
        dashboard_filter(&query),
        today,
    )
    .await
    .map_err(storage)
    .map(build_overview)?;
    Ok(Json(result))
}

pub async fn analytics(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<AnalyticsResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let today = local_date_at(&context.household.timezone, Utc::now()).map_err(|error| {
        tracing::error!(%error, "household timezone is invalid");
        ApiError(ApplicationError::Storage)
    })?;
    crate::recurring_expenses::refresh(&state, context.household.id, &context.household.timezone)
        .await?;
    let scopes = allowed_scope_values(&context);
    let data = load_analytics_data(&state.pool, context.household.id, &scopes, today)
        .await
        .map_err(storage)?;
    let overview = build_overview(data.overview);
    let projection = data
        .projection
        .into_iter()
        .map(|row| {
            json!({
                "period": row.period.format("%Y-%m").to_string(),
                "projected_income": row.income,
                "projected_expenses": row.expenses,
                "closing_balance": row.income - row.expenses
            })
        })
        .collect::<Vec<_>>();
    let mut charts = BTreeMap::new();
    charts.insert(
        "netWorth".to_owned(),
        overview
            .net_worth_trend
            .iter()
            .map(|point| json!({"period": point.period, "value": point.value}))
            .collect(),
    );
    charts.insert(
        "cashFlow".to_owned(),
        overview
            .cash_flow_trend
            .iter()
            .map(|point| json!({"period": point.period, "value": point.value}))
            .collect(),
    );
    charts.insert(
        "expenseBreakdown".to_owned(),
        overview
            .expense_breakdown
            .iter()
            .map(|point| json!({"label": point.label, "value": point.value, "share": point.share}))
            .collect(),
    );
    charts.insert(
        "utilities".to_owned(),
        overview
            .utility_trend
            .iter()
            .map(|point| serde_json::to_value(point).unwrap_or_else(|_| json!({})))
            .collect(),
    );
    charts.insert(
        "savingsAllocation".to_owned(),
        overview
            .savings_allocation
            .iter()
            .map(|point| json!({"label": point.label, "value": point.value, "share": point.share}))
            .collect(),
    );
    charts.insert("projection".to_owned(), projection);
    Ok(Json(AnalyticsResponse {
        charts,
        owner_scope_options: vec![
            "all".to_owned(),
            "self".to_owned(),
            "spouse".to_owned(),
            "joint".to_owned(),
        ],
        timeframe_options: vec![
            "3m".to_owned(),
            "6m".to_owned(),
            "12m".to_owned(),
            "all".to_owned(),
        ],
    }))
}

fn dashboard_filter(query: &DashboardQuery) -> DashboardFilter {
    DashboardFilter {
        start_date: query.start_date,
        end_date: query.end_date,
        include_planned: query.include_planned,
    }
}

fn build_overview(data: DashboardData) -> DashboardOverviewResponse {
    let (net_worth_trend, net_worth_components) = net_worth_series(
        data.account_points,
        data.net_worth_records,
        data.automatic_account_points,
    );
    let cash_flow = cash_flow_points(data.cash_flow);
    let cash_flow_trend = cash_flow
        .iter()
        .map(|point| MonthlyPointResponse {
            period: point.period.clone(),
            value: point.net,
        })
        .collect::<Vec<_>>();
    let income_breakdown = breakdown_rows(data.income_breakdown);
    let expense_breakdown = breakdown_rows(data.expense_breakdown);
    let expense_trend = expense_trend_points(data.expense_trend, &expense_breakdown);
    let utility_trend = utility_trend_points(data.utility_trend);
    let savings_allocation = breakdown_rows(data.savings_allocation);
    let loans = loan_summaries(data.loans);
    let upcoming = upcoming_items(data.upcoming);
    let recent = feed_items(data.recent);
    let current_assets = net_worth_components
        .last()
        .map(|point| point.investing.total + point.savings.total + point.non_liquid_assets.total)
        .unwrap_or_default();
    let current_debt = net_worth_components
        .last()
        .map(|point| point.debt.total)
        .unwrap_or_default();
    let current_net_worth = current_assets - current_debt;
    let latest_cash_flow = cash_flow.last();
    let month_income = latest_cash_flow
        .map(|point| point.income)
        .unwrap_or_default();
    let month_net = latest_cash_flow.map(|point| point.net).unwrap_or_default();
    let savings_rate = if month_income.is_zero() {
        Decimal::ZERO
    } else {
        money(month_net / month_income * Decimal::from(100_u8))
    };
    let upcoming_total = upcoming.iter().map(|item| item.amount).sum::<Decimal>();
    let goals = goal_progress(data.goals, current_assets, &loans);
    let last_import = data.last_import.map(import_run_response);
    DashboardOverviewResponse {
        metrics: vec![
            DashboardMetricResponse {
                label: "Net worth".to_owned(),
                value: current_net_worth,
                delta: None,
                unit: "currency".to_owned(),
            },
            DashboardMetricResponse {
                label: "Cash flow".to_owned(),
                value: month_net,
                delta: None,
                unit: "currency".to_owned(),
            },
            DashboardMetricResponse {
                label: "Savings rate".to_owned(),
                value: savings_rate,
                delta: None,
                unit: "percent".to_owned(),
            },
            DashboardMetricResponse {
                label: "Upcoming planned expenses".to_owned(),
                value: upcoming_total,
                delta: None,
                unit: "currency".to_owned(),
            },
        ],
        net_worth_trend,
        net_worth_components,
        cash_flow_trend,
        cash_flow_components: cash_flow,
        income_breakdown,
        expense_breakdown,
        expense_trend_by_category: expense_trend,
        utility_trend,
        savings_allocation,
        loans,
        upcoming_planned_expenses: upcoming,
        recent_activity: recent,
        goals,
        last_successful_import: last_import,
    }
}

fn net_worth_series(
    rows: Vec<AccountPointRow>,
    records: Vec<checkbook_postgres::net_worth_months::NetWorthMonthRecord>,
    automatic_rows: Vec<AccountPointRow>,
) -> (Vec<MonthlyPointResponse>, Vec<NetWorthComponentRowResponse>) {
    let mut periods: BTreeMap<NaiveDate, AccountComponents> = BTreeMap::new();
    for row in rows {
        let groups = periods.entry(row.period).or_default();
        if row.account_kind == "liability" {
            *groups.3.entry(row.name).or_default() += row.balance;
        } else if is_investment(&row.account_type) {
            *groups.0.entry(row.name).or_default() += row.balance;
        } else if is_savings(&row.account_type) {
            *groups.1.entry(row.name).or_default() += row.balance;
        } else {
            *groups.2.entry(row.name).or_default() += row.balance;
        }
    }
    // Curated months fully replace the snapshot-derived aggregation for their
    // period, so imports cannot reshape what the household curated.
    let mut completed_periods = BTreeMap::new();
    for record in records {
        let mut groups: AccountComponents = Default::default();
        for component in record.components {
            let target = match component.group_key.as_str() {
                "investing" => &mut groups.0,
                "savings" => &mut groups.1,
                "non_liquid_assets" => &mut groups.2,
                _ => &mut groups.3,
            };
            *target.entry(component.label).or_default() += component.value;
        }
        periods.insert(record.period, groups);
        completed_periods.insert(record.period, record.completed);
    }
    let mut automatic = BTreeMap::<NaiveDate, AccountComponents>::new();
    for row in automatic_rows {
        periods.entry(row.period).or_default();
        if row.balance.is_zero() {
            continue;
        }
        let groups = automatic.entry(row.period).or_default();
        // Automatic asset rows classify by account type exactly like
        // snapshot rows, so accounts land in investing/savings by subtype
        // while properties/vehicles/other stay non-liquid; liabilities
        // always remain debt.
        let target = if row.account_kind == "liability" {
            &mut groups.3
        } else if is_investment(&row.account_type) {
            &mut groups.0
        } else if is_savings(&row.account_type) {
            &mut groups.1
        } else {
            &mut groups.2
        };
        *target.entry(row.name).or_default() += row.balance;
    }
    let mut trend = Vec::with_capacity(periods.len());
    let mut components = Vec::with_capacity(periods.len());
    let mut previous = None;
    for (period, (investing, savings, non_liquid, debt)) in periods {
        let (auto_investing, auto_savings, auto_non_liquid, auto_debt) =
            automatic.remove(&period).unwrap_or_default();
        let investing_total = investing
            .values()
            .chain(auto_investing.values())
            .copied()
            .sum::<Decimal>();
        let savings_total = savings
            .values()
            .chain(auto_savings.values())
            .copied()
            .sum::<Decimal>();
        let non_liquid_total = non_liquid
            .values()
            .chain(auto_non_liquid.values())
            .copied()
            .sum::<Decimal>();
        let debt_total = debt
            .values()
            .chain(auto_debt.values())
            .copied()
            .sum::<Decimal>();
        let total = investing_total + savings_total + non_liquid_total - debt_total;
        let growth = previous
            .filter(|value: &Decimal| !value.is_zero())
            .map(|value| money(total / value * Decimal::from(100_u8)));
        let period_label = period.format("%Y-%m").to_string();
        trend.push(MonthlyPointResponse {
            period: period_label.clone(),
            value: total,
        });
        components.push(NetWorthComponentRowResponse {
            period: period_label,
            total,
            growth,
            completed: completed_periods.get(&period).copied().unwrap_or(false),
            investing: NetWorthComponentGroupResponse {
                total: investing_total,
                components: investing,
                automatic_components: auto_investing,
            },
            savings: NetWorthComponentGroupResponse {
                total: savings_total,
                components: savings,
                automatic_components: auto_savings,
            },
            non_liquid_assets: NetWorthComponentGroupResponse {
                total: non_liquid_total,
                components: non_liquid,
                automatic_components: auto_non_liquid,
            },
            debt: NetWorthComponentGroupResponse {
                total: debt_total,
                components: debt,
                automatic_components: auto_debt,
            },
        });
        previous = Some(total);
    }
    (trend, components)
}

fn cash_flow_points(rows: Vec<CashFlowRow>) -> Vec<CashFlowPointResponse> {
    rows.into_iter()
        .map(|row| CashFlowPointResponse {
            period: row.period.format("%Y-%m").to_string(),
            income: row.income,
            expenses: row.expenses,
            net: row.income - row.expenses,
        })
        .collect()
}

fn breakdown_rows(rows: Vec<BreakdownRow>) -> Vec<BreakdownPointResponse> {
    let mut combined = BTreeMap::<String, Decimal>::new();
    for row in rows {
        *combined.entry(row.label).or_default() += row.amount;
    }
    breakdown(combined)
}

fn breakdown(values: BTreeMap<String, Decimal>) -> Vec<BreakdownPointResponse> {
    let mut values = values
        .into_iter()
        .filter(|(_, value)| *value > Decimal::ZERO)
        .collect::<Vec<_>>();
    values.sort_by_key(|item| Reverse(item.1));
    let total = values.iter().map(|(_, value)| *value).sum::<Decimal>();
    values
        .into_iter()
        .map(|(label, value)| BreakdownPointResponse {
            label,
            value,
            share: if total.is_zero() {
                Decimal::ZERO
            } else {
                (value / total).round_dp(6)
            },
        })
        .collect()
}

fn expense_trend_points(
    rows: Vec<ExpenseTrendRow>,
    visible: &[BreakdownPointResponse],
) -> Vec<MonthlyBreakdownPointResponse> {
    let labels = visible
        .iter()
        .map(|item| item.label.clone())
        .collect::<BTreeSet<_>>();
    let mut periods = BTreeMap::<NaiveDate, BTreeMap<String, Decimal>>::new();
    for row in rows {
        let label = if labels.contains(&row.label) {
            row.label
        } else {
            "Other categories".to_owned()
        };
        *periods
            .entry(row.period)
            .or_default()
            .entry(label)
            .or_default() += row.amount;
    }
    periods
        .into_iter()
        .map(|(period, values)| MonthlyBreakdownPointResponse {
            period: period.format("%Y-%m").to_string(),
            values,
        })
        .collect()
}

fn utility_trend_points(rows: Vec<UtilityTrendRow>) -> Vec<UtilitySeriesPointResponse> {
    let mut periods = BTreeMap::<
        NaiveDate,
        (
            BTreeMap<String, Decimal>,
            BTreeMap<String, Decimal>,
            BTreeMap<String, String>,
        ),
    >::new();
    for row in rows {
        let period = periods.entry(row.period).or_default();
        period.0.insert(row.label.clone(), row.amount);
        if let Some(usage) = row.usage_amount {
            period.1.insert(row.label.clone(), usage);
        }
        if let Some(unit) = row.unit.filter(|value| !value.is_empty()) {
            period.2.insert(row.label, unit);
        }
    }
    periods
        .into_iter()
        .map(
            |(period, (values, usage, units))| UtilitySeriesPointResponse {
                period: period.format("%Y-%m").to_string(),
                total: values.values().copied().sum(),
                values,
                usage,
                units,
            },
        )
        .collect()
}

fn loan_summaries(rows: Vec<LoanRow>) -> Vec<LoanSummary> {
    rows.into_iter()
        .map(|row| {
            let outcome = simulate_loan_payoff(
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
                projected_payoff_months: outcome.as_ref().map(|item| item.months),
                interest_remaining: outcome.map(|item| item.interest),
                details: row.terms_payload,
                linked_property_id: row.linked_property_id,
            }
        })
        .collect()
}

fn upcoming_items(rows: Vec<UpcomingRow>) -> Vec<UpcomingPlannedItemResponse> {
    rows.into_iter()
        .map(|row| UpcomingPlannedItemResponse {
            id: row.id,
            name: row.name,
            amount: row.amount,
            planned_date: row.planned_date,
            owner_scope: row.owner_scope,
            description: row.description,
            status: row.status,
        })
        .collect()
}

fn feed_items(rows: Vec<FeedRow>) -> Vec<FeedItemResponse> {
    rows.into_iter()
        .map(|row| FeedItemResponse {
            id: row.id,
            item_type: row.item_type,
            title: row.title,
            amount: row.amount,
            entry_date: row.entry_date,
            owner_scope: row.owner_scope,
            source: row.source,
            category: row.category,
            subcategory: row.subcategory,
            notes: row.notes,
        })
        .collect()
}

fn goal_progress(
    rows: Vec<GoalRow>,
    current_assets: Decimal,
    loans: &[LoanSummary],
) -> Vec<GoalProgressResponse> {
    rows.into_iter()
        .map(|row| {
            let projected = if row.goal_type == "debt_paydown" {
                row.linked_loan_id
                    .and_then(|id| loans.iter().find(|loan| loan.id == id))
                    .and_then(|loan| {
                        loan.original_balance
                            .map(|original| (original - loan.current_balance).max(Decimal::ZERO))
                    })
                    .unwrap_or_default()
            } else {
                current_assets
            };
            GoalProgressResponse {
                id: row.id,
                name: row.name,
                goal_type: row.goal_type,
                target_amount: row.target_amount,
                projected_amount: projected,
                progress_ratio: if row.target_amount.is_zero() {
                    Decimal::ZERO
                } else {
                    (projected / row.target_amount)
                        .min(Decimal::ONE)
                        .round_dp(4)
                },
                target_date: row.target_date,
                status: row.status,
            }
        })
        .collect()
}

fn import_run_response(row: DataLoadHistoryRecord) -> ImportRunResponse {
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

fn is_investment(account_type: &str) -> bool {
    let normalized = account_type.to_ascii_lowercase();
    normalized.contains("invest")
        || normalized.contains("broker")
        || normalized.contains("stock")
        || normalized.contains("option")
        || normalized.contains("fund")
        || normalized.contains("retire")
        || normalized.contains("ike")
        || normalized.contains("ikze")
        || normalized.contains("crypto")
        || normalized.contains("etf")
        || normalized.contains("bond")
}

fn is_savings(account_type: &str) -> bool {
    let normalized = account_type.to_ascii_lowercase();
    normalized.contains("saving")
        || normalized.contains("cash")
        || normalized.contains("checking")
        || normalized.contains("bank")
        || normalized.contains("deposit")
}

fn money(value: Decimal) -> Decimal {
    value.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
}

fn storage(error: sqlx::Error) -> ApiError {
    tracing::error!(error = %error, "dashboard storage operation failed");
    ApiError(ApplicationError::Storage)
}

#[utoipa::path(
    put,
    path = "/api/household/net-worth/months/{period}",
    operation_id = "updateNetWorthMonth",
    params(("period" = String, Path, description = "Month formatted as YYYY-MM")),
    request_body = crate::dto::NetWorthMonthPayload,
    responses(
        (status = 200, description = "Updated net worth month", body = crate::dto::NetWorthComponentRowResponse),
        (status = 401, description = "Authentication required", body = crate::error::ErrorBody),
        (status = 403, description = "Permission denied", body = crate::error::ErrorBody),
        (status = 422, description = "Invalid month details", body = crate::error::ErrorBody)
    ),
    security(("bearerAuth" = []))
)]
pub async fn update_net_worth_month(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(period): Path<String>,
    payload: Result<
        Json<crate::dto::NetWorthMonthPayload>,
        axum::extract::rejection::JsonRejection,
    >,
) -> Result<Json<crate::dto::NetWorthComponentRowResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    crate::auth::require_permission(&context, "records", "write")?;
    for scope in ["self", "spouse", "joint"] {
        crate::auth::require_scope_access(&context, scope)?;
    }
    let Json(payload) = payload.map_err(|_| {
        ApiError(ApplicationError::Validation(
            "Net worth month details are invalid.".to_owned(),
        ))
    })?;
    let record = validate_net_worth_month(&period, payload)?;
    let stored = checkbook_postgres::net_worth_months::upsert_month(
        &state.pool,
        context.household.id,
        record.0,
        record.1.completed,
        record
            .1
            .components
            .into_iter()
            .map(
                |component| checkbook_postgres::net_worth_months::NetWorthComponentInput {
                    group_key: component.group_key,
                    label: component.label,
                    value: component.value,
                },
            )
            .collect(),
    )
    .await
    .map_err(crate::assets::map_asset_store_error)?;
    let today = local_date_at(&context.household.timezone, Utc::now())
        .map_err(|_| ApiError(ApplicationError::Storage))?;
    let mut tx = checkbook_postgres::tenant::begin(&state.pool, context.household.id, true)
        .await
        .map_err(storage)?;
    let automatic = checkbook_postgres::dashboard::load_automatic_account_points(
        &mut tx,
        context.household.id,
        &allowed_scope_values(&context),
        DashboardFilter {
            start_date: Some(stored.period),
            end_date: Some(stored.period),
            include_planned: false,
        },
        today,
        stored.period.max(today),
    )
    .await
    .map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    let (_, mut rows) = net_worth_series(Vec::new(), vec![stored], automatic);
    let row = rows.pop().ok_or(ApiError(ApplicationError::Storage))?;
    Ok(Json(row))
}

/// Validate the transport period; component invariants are enforced by the domain.
fn validate_net_worth_month(
    period: &str,
    payload: crate::dto::NetWorthMonthPayload,
) -> Result<(NaiveDate, crate::dto::NetWorthMonthPayload), ApiError> {
    let month = NaiveDate::parse_from_str(&format!("{period}-01"), "%Y-%m-%d")
        .ok()
        .filter(|date| date.format("%Y-%m").to_string() == period)
        .ok_or_else(|| {
            ApiError(ApplicationError::Validation(
                "Period must be formatted as YYYY-MM.".to_owned(),
            ))
        })?;
    Ok((month, payload))
}

#[cfg(test)]
mod net_worth_series_tests {
    use super::*;
    use checkbook_postgres::net_worth_months::{NetWorthComponentInput, NetWorthMonthRecord};
    use rust_decimal_macros::dec;

    fn point(
        period: &str,
        kind: &str,
        account_type: &str,
        name: &str,
        balance: Decimal,
    ) -> Result<AccountPointRow, chrono::ParseError> {
        Ok(AccountPointRow {
            period: NaiveDate::parse_from_str(period, "%Y-%m-%d")?,
            account_kind: kind.to_owned(),
            account_type: account_type.to_owned(),
            name: name.to_owned(),
            balance,
        })
    }

    fn record(
        period: &str,
        completed: bool,
        components: &[(&str, &str, Decimal)],
    ) -> Result<NetWorthMonthRecord, chrono::ParseError> {
        Ok(NetWorthMonthRecord {
            period: NaiveDate::parse_from_str(period, "%Y-%m-%d")?,
            completed,
            components: components
                .iter()
                .map(|(group_key, label, value)| NetWorthComponentInput {
                    group_key: (*group_key).to_owned(),
                    label: (*label).to_owned(),
                    value: *value,
                })
                .collect(),
        })
    }

    #[test]
    fn curated_months_replace_derived_rows_and_carry_completion() -> Result<(), chrono::ParseError>
    {
        let rows = vec![
            point("2026-01-01", "asset", "investing", "Broker", dec!(1000))?,
            point("2026-01-01", "asset", "savings", "Bank", dec!(500))?,
            point("2026-01-01", "liability", "loan", "Mortgage", dec!(200))?,
            point("2026-02-01", "asset", "investing", "Broker", dec!(1100))?,
            point("2026-02-01", "asset", "savings", "Bank", dec!(550))?,
            point("2026-02-01", "liability", "loan", "Mortgage", dec!(190))?,
        ];
        let records = vec![record(
            "2026-02-01",
            true,
            &[
                ("investing", "ETF", dec!(300)),
                ("debt", "Mortgage", dec!(150)),
            ],
        )?];
        let (trend, components) = net_worth_series(rows, records, Vec::new());
        assert_eq!(trend.len(), 2);
        assert_eq!(components.len(), 2);
        let january = &components[0];
        assert!(!january.completed);
        assert_eq!(january.total, dec!(1300));
        let february = &components[1];
        // The curated month fully replaces the derived aggregation.
        assert!(february.completed);
        assert_eq!(february.investing.total, dec!(300));
        assert_eq!(february.investing.components["ETF"], dec!(300));
        assert_eq!(february.savings.total, Decimal::ZERO);
        assert!(february.savings.components.is_empty());
        assert_eq!(february.debt.total, dec!(150));
        assert_eq!(february.total, dec!(150));
        assert_eq!(trend[1].value, dec!(150));
        // Growth is recomputed across the merged sequence.
        assert_eq!(february.growth, Some(dec!(11.54)));
        Ok(())
    }

    #[test]
    fn curated_months_without_snapshots_still_appear_in_order() -> Result<(), chrono::ParseError> {
        let rows = vec![point("2026-02-01", "asset", "savings", "Bank", dec!(50))?];
        let records = vec![record(
            "2025-12-01",
            false,
            &[("savings", "Cash", dec!(70))],
        )?];
        let (trend, components) = net_worth_series(rows, records, Vec::new());
        assert_eq!(
            components
                .iter()
                .map(|row| row.period.as_str())
                .collect::<Vec<_>>(),
            vec!["2025-12", "2026-02"]
        );
        assert_eq!(trend[0].value, dec!(70));
        assert_eq!(trend[1].value, dec!(50));
        assert_eq!(components[0].growth, None);
        Ok(())
    }
    #[test]
    fn automatic_sources_merge_after_completed_manual_and_keep_zero_periods()
    -> Result<(), chrono::ParseError> {
        let records = vec![record(
            "2026-01-01",
            true,
            &[("non_liquid_assets", "Home", dec!(7))],
        )?];
        let automatic = vec![
            point("2026-01-01", "asset", "property", "Home", dec!(100))?,
            point("2026-01-01", "liability", "loan", "Loan", dec!(20))?,
            point("2026-02-01", "asset", "property", "Home", dec!(0))?,
            point("2026-02-01", "liability", "loan", "Loan", dec!(0))?,
        ];
        let (trend, rows) = net_worth_series(Vec::new(), records, automatic);
        assert_eq!(trend.len(), 2);
        assert!(rows[0].completed);
        assert_eq!(rows[0].non_liquid_assets.components["Home"], dec!(7));
        assert_eq!(
            rows[0].non_liquid_assets.automatic_components["Home"],
            dec!(100)
        );
        assert_eq!(rows[0].non_liquid_assets.total, dec!(107));
        assert_eq!(rows[0].total, dec!(87));
        assert_eq!(rows[1].total, Decimal::ZERO);
        assert!(rows[1].non_liquid_assets.automatic_components.is_empty());
        assert!(rows[1].debt.automatic_components.is_empty());
        Ok(())
    }

    #[test]
    fn automatic_accounts_group_by_account_type_like_snapshots() -> Result<(), chrono::ParseError> {
        let automatic = vec![
            point("2026-01-01", "asset", "stocks", "Brokerage", dec!(1000))?,
            point("2026-01-01", "asset", "options", "Options", dec!(300))?,
            point("2026-01-01", "asset", "savings", "Bank", dec!(500))?,
            point("2026-01-01", "asset", "property", "Home", dec!(2000))?,
            point("2026-01-01", "liability", "loan", "Mortgage", dec!(800))?,
        ];
        let (trend, rows) = net_worth_series(Vec::new(), Vec::new(), automatic);
        assert_eq!(trend.len(), 1);
        let row = &rows[0];
        // 'stocks' and 'options' classify as investing, 'savings' as savings,
        // while properties stay non-liquid and loans stay debt.
        assert_eq!(
            row.investing.automatic_components,
            BTreeMap::from([
                ("Brokerage".to_owned(), dec!(1000)),
                ("Options".to_owned(), dec!(300))
            ])
        );
        assert_eq!(row.investing.total, dec!(1300));
        assert_eq!(row.savings.automatic_components["Bank"], dec!(500));
        assert_eq!(row.savings.total, dec!(500));
        assert_eq!(
            row.non_liquid_assets.automatic_components["Home"],
            dec!(2000)
        );
        assert_eq!(row.non_liquid_assets.total, dec!(2000));
        assert_eq!(row.debt.automatic_components["Mortgage"], dec!(800));
        assert_eq!(row.debt.total, dec!(800));
        assert_eq!(row.total, dec!(1300) + dec!(500) + dec!(2000) - dec!(800));
        Ok(())
    }

    #[test]
    fn automatic_and_snapshot_account_types_share_grouping() -> Result<(), chrono::ParseError> {
        let snapshot_rows = vec![point("2026-01-01", "asset", "stocks", "ETF", dec!(10))?];
        let automatic = vec![point("2026-01-01", "asset", "options", "Options", dec!(5))?];
        let (_, rows) = net_worth_series(snapshot_rows, Vec::new(), automatic);
        let investing = &rows[0].investing;
        assert_eq!(investing.components["ETF"], dec!(10));
        assert_eq!(investing.automatic_components["Options"], dec!(5));
        assert_eq!(investing.total, dec!(15));
        Ok(())
    }
}
