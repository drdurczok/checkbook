use chrono::{Datelike, NaiveDate};
use rust_decimal::Decimal;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

use crate::{
    assets::VALUATION_HISTORY_PREFIX,
    imports::{DataLoadHistoryRecord, last_successful_data_load},
    tenant,
};

#[derive(Debug, Clone, Copy, Default)]
pub struct DashboardFilter {
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub include_planned: bool,
}

#[derive(Debug, Clone)]
pub struct DashboardData {
    pub account_points: Vec<AccountPointRow>,
    pub automatic_account_points: Vec<AccountPointRow>,
    pub net_worth_records: Vec<crate::net_worth_months::NetWorthMonthRecord>,
    pub cash_flow: Vec<CashFlowRow>,
    pub income_breakdown: Vec<BreakdownRow>,
    pub expense_breakdown: Vec<BreakdownRow>,
    pub expense_trend: Vec<ExpenseTrendRow>,
    pub utility_trend: Vec<UtilityTrendRow>,
    pub savings_allocation: Vec<BreakdownRow>,
    pub loans: Vec<LoanRow>,
    pub upcoming: Vec<UpcomingRow>,
    pub recent: Vec<FeedRow>,
    pub goals: Vec<GoalRow>,
    pub last_import: Option<DataLoadHistoryRecord>,
}

#[derive(Debug, Clone)]
pub struct AnalyticsData {
    pub overview: DashboardData,
    pub projection: Vec<ProjectionRow>,
}

#[derive(Debug, Clone)]
pub struct AccountPointRow {
    pub period: NaiveDate,
    pub account_kind: String,
    pub account_type: String,
    pub name: String,
    pub balance: Decimal,
}

#[derive(Debug, Clone)]
pub struct CashFlowRow {
    pub period: NaiveDate,
    pub income: Decimal,
    pub expenses: Decimal,
}

#[derive(Debug, Clone)]
pub struct BreakdownRow {
    pub label: String,
    pub amount: Decimal,
}

#[derive(Debug, Clone)]
pub struct ExpenseTrendRow {
    pub period: NaiveDate,
    pub label: String,
    pub amount: Decimal,
}

#[derive(Debug, Clone)]
pub struct UtilityTrendRow {
    pub period: NaiveDate,
    pub label: String,
    pub amount: Decimal,
    pub usage_amount: Option<Decimal>,
    pub unit: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FeedRow {
    pub id: Uuid,
    pub item_type: String,
    pub title: String,
    pub amount: Decimal,
    pub entry_date: NaiveDate,
    pub owner_scope: String,
    pub source: String,
    pub category: Option<String>,
    pub subcategory: Option<String>,
    pub notes: String,
}

#[derive(Debug, Clone)]
pub struct UpcomingRow {
    pub id: Uuid,
    pub name: String,
    pub amount: Decimal,
    pub planned_date: NaiveDate,
    pub owner_scope: String,
    pub description: String,
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct LoanRow {
    pub id: Uuid,
    pub name: String,
    pub current_balance: Decimal,
    pub monthly_payment: Decimal,
    pub interest_rate: Decimal,
    pub original_balance: Decimal,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub notes: String,
    pub terms_payload: Value,
    pub linked_property_id: Option<Uuid>,
}

#[derive(Debug, Clone)]
pub struct GoalRow {
    pub id: Uuid,
    pub name: String,
    pub goal_type: String,
    pub target_amount: Decimal,
    pub target_date: Option<NaiveDate>,
    pub status: String,
    pub linked_loan_id: Option<Uuid>,
}

#[derive(Debug, Clone)]
pub struct ProjectionRow {
    pub period: NaiveDate,
    pub income: Decimal,
    pub expenses: Decimal,
}

pub async fn load_overview_data(
    pool: &PgPool,
    household_id: Uuid,
    scopes: &[String],
    filter: DashboardFilter,
    today: NaiveDate,
) -> Result<DashboardData, sqlx::Error> {
    let mut tx = tenant::begin(pool, household_id, true).await?;
    let data =
        load_overview_data_in_transaction(&mut tx, household_id, scopes, filter, today).await?;
    tx.commit().await?;
    Ok(data)
}

pub async fn load_analytics_data(
    pool: &PgPool,
    household_id: Uuid,
    scopes: &[String],
    today: NaiveDate,
) -> Result<AnalyticsData, sqlx::Error> {
    let mut tx = tenant::begin(pool, household_id, true).await?;
    let filter = DashboardFilter::default();
    let overview =
        load_overview_data_in_transaction(&mut tx, household_id, scopes, filter, today).await?;
    let projection = load_projection_rows_in_transaction(&mut tx, household_id, scopes).await?;
    tx.commit().await?;
    Ok(AnalyticsData {
        overview,
        projection,
    })
}

async fn load_overview_data_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    scopes: &[String],
    filter: DashboardFilter,
    today: NaiveDate,
) -> Result<DashboardData, sqlx::Error> {
    // Canonical months contain household-wide values, with no per-row owner scope.
    let net_worth_records = if ["self", "spouse", "joint"]
        .iter()
        .all(|scope| scopes.iter().any(|allowed| allowed == scope))
    {
        crate::net_worth_months::load_month_records(tx, household_id)
            .await?
            .into_iter()
            .filter(|record| {
                filter.start_date.is_none_or(|start| {
                    (record.period.year(), record.period.month()) >= (start.year(), start.month())
                }) && filter.end_date.is_none_or(|end| record.period <= end)
            })
            .collect()
    } else {
        Vec::new()
    };
    // Curated months may reach past today; their automatic debt and
    // fixed-asset values still have to be generated for those periods.
    let horizon = automatic_horizon(today, &net_worth_records);
    Ok(DashboardData {
        account_points: load_account_points(tx, household_id, scopes, filter, today).await?,
        automatic_account_points: load_automatic_account_points(
            tx,
            household_id,
            scopes,
            filter,
            today,
            horizon,
        )
        .await?,
        net_worth_records,
        cash_flow: load_cash_flow(tx, household_id, scopes, filter, today).await?,
        income_breakdown: load_breakdown(tx, household_id, scopes, filter, "income").await?,
        expense_breakdown: load_breakdown(tx, household_id, scopes, filter, "expense").await?,
        expense_trend: load_expense_trend(tx, household_id, scopes, filter).await?,
        utility_trend: load_utility_trend(tx, household_id, scopes, filter).await?,
        savings_allocation: load_savings_allocation(tx, household_id, scopes).await?,
        loans: load_loans(tx, household_id, scopes).await?,
        upcoming: load_upcoming(tx, household_id, scopes, today).await?,
        recent: load_recent(tx, household_id, scopes, filter).await?,
        goals: load_goals(tx, household_id, scopes).await?,
        last_import: last_successful_data_load(tx, household_id).await?,
    })
}

async fn load_account_points(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    scopes: &[String],
    filter: DashboardFilter,
    today: NaiveDate,
) -> Result<Vec<AccountPointRow>, sqlx::Error> {
    sqlx::query_as!(
        AccountPointRow,
        r#"WITH limits AS (
            SELECT
                COALESCE(
                    date_trunc('month', min(snapshot.effective_date))::date,
                    date_trunc('month', $5::date)::date
                ) AS first_period,
                date_trunc('month', $5::date)::date AS last_period
            FROM account_balance_snapshots snapshot
            WHERE snapshot.household_id = $1
              AND snapshot.source_key NOT LIKE $6
         ),
         periods AS (
            SELECT generate_series(
                GREATEST(first_period, COALESCE(date_trunc('month', $3::date)::date, first_period)),
                LEAST(last_period, COALESCE(date_trunc('month', $4::date)::date, last_period)),
                interval '1 month'
            )::date AS period
            FROM limits
         )
         SELECT period.period AS "period!", account.account_kind AS "account_kind!",
                account.account_type AS "account_type!", account.name AS "name!",
                COALESCE(latest.balance, 0)::numeric AS "balance!: Decimal"
         FROM periods period
         JOIN financial_accounts account
           ON account.household_id = $1
          AND account.owner_scope = ANY($2)
          AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.household_id = account.household_id AND p.account_id = account.id)
          AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.household_id = account.household_id AND l.account_id = account.id)
          AND NOT (COALESCE(account.source_key, '') = 'wealth:debt' AND EXISTS (
              SELECT 1 FROM loans l WHERE l.household_id = account.household_id
                AND l.owner_scope = ANY($2) AND l.source_key NOT LIKE 'app_manual:%'
          ))
          AND (account.opened_on IS NULL OR account.opened_on < period.period + interval '1 month')
          AND (account.closed_on IS NULL OR account.closed_on >= period.period)
         LEFT JOIN LATERAL (
             SELECT snapshot.balance
             FROM account_balance_snapshots snapshot
             WHERE snapshot.household_id = account.household_id
               AND snapshot.account_id = account.id
               AND snapshot.effective_date < period.period + interval '1 month'
               AND snapshot.source_key NOT LIKE $6
             ORDER BY snapshot.effective_date DESC, snapshot.created_at DESC
            LIMIT 1
         ) latest ON true
         ORDER BY period.period, account.account_kind, account.name"#,
        household_id,
        scopes,
        filter.start_date,
        filter.end_date,
        today,
        format!("{VALUATION_HISTORY_PREFIX}%")
    )
    .fetch_all(&mut **tx)
    .await
}

/// Automatic sources stop at today unless a curated month reaches further:
/// the latest curated period extends the horizon so those months keep their
/// automatic debt and fixed-asset values.
fn automatic_horizon(
    today: NaiveDate,
    records: &[crate::net_worth_months::NetWorthMonthRecord],
) -> NaiveDate {
    records
        .iter()
        .map(|record| record.period)
        .filter(|period| *period > today)
        .max()
        .unwrap_or(today)
}

pub async fn load_automatic_account_points(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    scopes: &[String],
    filter: DashboardFilter,
    today: NaiveDate,
    horizon: NaiveDate,
) -> Result<Vec<AccountPointRow>, sqlx::Error> {
    let properties = sqlx::query!(
        "SELECT p.id, p.name, p.category, p.account_type, p.valuation, p.valuation_date,
                p.started_on, p.ended_on, p.depreciation_rate, p.depreciation_enabled
         FROM properties p LEFT JOIN financial_accounts a
           ON a.household_id = p.household_id AND a.id = p.account_id
         WHERE p.household_id = $1 AND COALESCE(a.owner_scope, 'joint') = ANY($2)
         ORDER BY p.id",
        household_id,
        scopes
    )
    .fetch_all(&mut **tx)
    .await?;
    let loans = sqlx::query!(
        "SELECT id, name, current_balance, schedule_opening_balance, original_balance,
                interest_rate, monthly_payment, start_date
         FROM loans WHERE household_id = $1 AND owner_scope = ANY($2) ORDER BY id",
        household_id,
        scopes
    )
    .fetch_all(&mut **tx)
    .await?;
    let mut points = Vec::new();
    let in_range = |period: NaiveDate| {
        period <= horizon
            && filter.start_date.is_none_or(|start| {
                (period.year(), period.month()) >= (start.year(), start.month())
            })
            && filter.end_date.is_none_or(|end| period <= end)
    };
    for property in &properties {
        let anchor = property.started_on.unwrap_or(property.valuation_date);
        let mut period = checkbook_domain::month_start(anchor)
            .map_err(|error| sqlx::Error::Decode(Box::new(error)))?;
        let label = if properties
            .iter()
            .filter(|other| other.name == property.name)
            .count()
            > 1
        {
            format!("{} ({})", property.name, property.id)
        } else {
            property.name.clone()
        };
        while period <= horizon {
            if in_range(period) && property.ended_on.is_none_or(|end| period <= end) {
                let rate = if property.depreciation_enabled {
                    property.depreciation_rate
                } else {
                    Decimal::ZERO
                };
                let balance = checkbook_domain::compounded_value(
                    property.valuation,
                    rate,
                    checkbook_domain::months_between(property.valuation_date, period),
                )
                .map_err(|error| sqlx::Error::Decode(Box::new(error)))?;
                // Zero points retain source-only months; the API omits their labels.
                // Account-category properties report their subtype (NOT NULL by
                // the category CHECK) so the API groups them by account type;
                // every other category stays a fixed 'property' asset.
                let point_type = property
                    .account_type
                    .clone()
                    .filter(|_| property.category == "account")
                    .unwrap_or_else(|| "property".to_owned());
                points.push(AccountPointRow {
                    period,
                    account_kind: "asset".into(),
                    account_type: point_type,
                    name: label.clone(),
                    balance,
                });
            }
            period = checkbook_domain::shift_month_start(period, 1)
                .map_err(|error| sqlx::Error::Decode(Box::new(error)))?;
        }
    }
    for loan in &loans {
        let (schedule, _) = crate::loan_payments::load(tx, household_id, loan.id).await?;
        let opening = loan.schedule_opening_balance.unwrap_or(
            if schedule.iter().any(|payment| payment.is_completed()) {
                loan.original_balance
            } else {
                loan.current_balance
            },
        );
        // Historical balances use completed evidence only. Recalculating future
        // payments here would make history fail on a non-amortizing projection.
        let start = loan
            .start_date
            .or_else(|| schedule.first().map(|payment| payment.date))
            .unwrap_or(today);
        let mut period = checkbook_domain::month_start(start)
            .map_err(|error| sqlx::Error::Decode(Box::new(error)))?;
        let label = if loans.iter().filter(|other| other.name == loan.name).count() > 1 {
            format!("{} ({})", loan.name, loan.id)
        } else {
            loan.name.clone()
        };
        while period <= horizon {
            let next = checkbook_domain::shift_month_start(period, 1)
                .map_err(|error| sqlx::Error::Decode(Box::new(error)))?;
            let balance = schedule
                .iter()
                .filter(|payment| payment.is_completed() && payment.date < next)
                .fold(opening, |balance, payment| {
                    payment.outstanding_loan_balance.unwrap_or_else(|| {
                        ((balance - payment.principal.unwrap_or(Decimal::ZERO)).max(Decimal::ZERO)
                            - payment.extra_principal.unwrap_or(Decimal::ZERO))
                        .max(Decimal::ZERO)
                    })
                });
            if in_range(period) {
                points.push(AccountPointRow {
                    period,
                    account_kind: "liability".into(),
                    account_type: "loan".into(),
                    name: label.clone(),
                    balance,
                });
            }
            period = next;
        }
    }
    Ok(points)
}

async fn load_cash_flow(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    scopes: &[String],
    filter: DashboardFilter,
    today: NaiveDate,
) -> Result<Vec<CashFlowRow>, sqlx::Error> {
    sqlx::query_as!(
        CashFlowRow,
        r#"WITH movements AS (
            SELECT date_trunc('month', entry_date)::date AS period,
                   CASE WHEN direction = 'income' THEN amount ELSE 0 END AS income,
                   CASE WHEN direction = 'expense' THEN amount ELSE 0 END AS expenses
            FROM ledger_entries
            WHERE household_id = $1
              AND entry_date IS NOT NULL
              AND owner_scope = ANY($2)
              AND (status = 'actual' OR ($5 AND status = 'planned'))
              AND ($3::date IS NULL OR entry_date >= $3)
              AND ($4::date IS NULL OR entry_date <= $4)
              AND entry_date <= CASE WHEN $5 THEN 'infinity'::date ELSE $6 END
            UNION ALL
            SELECT date_trunc('month', charge_date)::date, 0, amount
            FROM utility_bills
            WHERE household_id = $1
              AND owner_scope = ANY($2)
              AND ($3::date IS NULL OR charge_date >= $3)
              AND ($4::date IS NULL OR charge_date <= $4)
              AND charge_date <= $6
         )
         SELECT period AS "period!", sum(income)::numeric AS "income!: Decimal",
                sum(expenses)::numeric AS "expenses!: Decimal"
         FROM movements GROUP BY period ORDER BY period"#,
        household_id,
        scopes,
        filter.start_date,
        filter.end_date,
        filter.include_planned,
        today
    )
    .fetch_all(&mut **tx)
    .await
}

async fn load_breakdown(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    scopes: &[String],
    filter: DashboardFilter,
    direction: &str,
) -> Result<Vec<BreakdownRow>, sqlx::Error> {
    let mut rows = sqlx::query_as!(
        BreakdownRow,
        r#"SELECT COALESCE(grp.name, category.name,
                    CASE WHEN e.direction = 'income' THEN 'Income' ELSE 'Uncategorized' END
                ) AS "label!",
                sum(e.amount)::numeric AS "amount!: Decimal"
         FROM ledger_entries e
         LEFT JOIN categories category
           ON category.household_id = e.household_id AND category.id = e.category_id
         LEFT JOIN expense_groups grp
           ON grp.household_id = category.household_id
          AND grp.id = category.expense_group_id
         WHERE e.household_id = $1 AND e.direction = $2
           AND e.owner_scope = ANY($3)
           AND e.entry_date IS NOT NULL
           AND (e.status = 'actual' OR ($6 AND e.status = 'planned'))
           AND ($4::date IS NULL OR e.entry_date >= $4)
           AND ($5::date IS NULL OR e.entry_date <= $5)
         GROUP BY 1"#,
        household_id,
        direction,
        scopes,
        filter.start_date,
        filter.end_date,
        filter.include_planned
    )
    .fetch_all(&mut **tx)
    .await?;
    if direction == "expense" {
        // Utility bills live in their own tables; surface them as a single
        // "Utilities" line in the expense mix rather than one row per service.
        // Runtime query (not `query_as!`) so the offline sqlx cache is untouched.
        let utility_total: Option<Decimal> = sqlx::query_scalar(
            r#"SELECT sum(amount)::numeric
             FROM utility_bills
             WHERE household_id = $1 AND owner_scope = ANY($2)
               AND ($3::date IS NULL OR charge_date >= $3)
               AND ($4::date IS NULL OR charge_date <= $4)"#,
        )
        .bind(household_id)
        .bind(scopes)
        .bind(filter.start_date)
        .bind(filter.end_date)
        .fetch_one(&mut **tx)
        .await?;
        if let Some(amount) = utility_total {
            rows.push(BreakdownRow {
                label: "Utilities".to_owned(),
                amount,
            });
        }
    }
    Ok(rows)
}

async fn load_expense_trend(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    scopes: &[String],
    filter: DashboardFilter,
) -> Result<Vec<ExpenseTrendRow>, sqlx::Error> {
    let mut rows = sqlx::query_as!(
        ExpenseTrendRow,
        r#"SELECT date_trunc('month', e.entry_date)::date AS "period!",
                COALESCE(grp.name, category.name, 'Uncategorized') AS "label!",
                sum(e.amount)::numeric AS "amount!: Decimal"
         FROM ledger_entries e
         LEFT JOIN categories category
           ON category.household_id = e.household_id AND category.id = e.category_id
         LEFT JOIN expense_groups grp
           ON grp.household_id = category.household_id
          AND grp.id = category.expense_group_id
         WHERE e.household_id = $1 AND e.direction = 'expense'
           AND e.owner_scope = ANY($2) AND e.entry_date IS NOT NULL
           AND (e.status = 'actual' OR ($5 AND e.status = 'planned'))
           AND ($3::date IS NULL OR e.entry_date >= $3)
           AND ($4::date IS NULL OR e.entry_date <= $4)
         GROUP BY 1, 2 ORDER BY 1, 2"#,
        household_id,
        scopes,
        filter.start_date,
        filter.end_date,
        filter.include_planned
    )
    .fetch_all(&mut **tx)
    .await?;

    // Fold all utility bills into a single monthly "Utilities" series so the
    // stacked expense-mix chart matches the collapsed breakdown line. Runtime
    // query (not `query_as!`) so the offline sqlx cache is untouched.
    let utility = sqlx::query(
        r#"SELECT date_trunc('month', charge_date)::date AS period,
                sum(amount)::numeric AS amount
         FROM utility_bills
         WHERE household_id = $1 AND owner_scope = ANY($2)
           AND ($3::date IS NULL OR charge_date >= $3)
           AND ($4::date IS NULL OR charge_date <= $4)
         GROUP BY 1 ORDER BY 1"#,
    )
    .bind(household_id)
    .bind(scopes)
    .bind(filter.start_date)
    .bind(filter.end_date)
    .fetch_all(&mut **tx)
    .await?;
    for row in utility {
        rows.push(ExpenseTrendRow {
            period: row.try_get("period")?,
            label: "Utilities".to_owned(),
            amount: row
                .try_get::<Option<Decimal>, _>("amount")?
                .unwrap_or_default(),
        });
    }
    Ok(rows)
}

async fn load_utility_trend(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    scopes: &[String],
    filter: DashboardFilter,
) -> Result<Vec<UtilityTrendRow>, sqlx::Error> {
    sqlx::query_as!(
        UtilityTrendRow,
        r#"SELECT date_trunc('month', bill.charge_date)::date AS "period!",
                COALESCE(service.label, bill.provider, 'Utilities') AS "label!",
                sum(bill.amount)::numeric AS "amount!: Decimal",
                sum(COALESCE(reading.usage_amount, bill.usage_amount))::numeric AS "usage_amount: Decimal",
                max(COALESCE(reading.unit, service.unit)) AS unit
         FROM utility_bills bill
         LEFT JOIN utility_services service
           ON service.household_id = bill.household_id AND service.id = bill.service_id
         LEFT JOIN utility_meter_readings reading
           ON reading.household_id = bill.household_id
          AND reading.utility_bill_id = bill.id
         WHERE bill.household_id = $1 AND bill.owner_scope = ANY($2)
           AND ($3::date IS NULL OR bill.charge_date >= $3)
           AND ($4::date IS NULL OR bill.charge_date <= $4)
         GROUP BY 1, 2 ORDER BY 1, 2"#,
        household_id,
        scopes,
        filter.start_date,
        filter.end_date
    )
    .fetch_all(&mut **tx)
    .await
}

async fn load_savings_allocation(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    scopes: &[String],
) -> Result<Vec<BreakdownRow>, sqlx::Error> {
    sqlx::query_as!(
        BreakdownRow,
        r#"SELECT initcap(replace(account.account_type, '_', ' ')) AS "label!",
                sum(latest.balance)::numeric AS "amount!: Decimal"
         FROM financial_accounts account
         JOIN LATERAL (
             SELECT snapshot.balance
             FROM account_balance_snapshots snapshot
             WHERE snapshot.household_id = account.household_id
               AND snapshot.account_id = account.id
               AND snapshot.source_key NOT LIKE $3
             ORDER BY snapshot.effective_date DESC, snapshot.created_at DESC
             LIMIT 1
         ) latest ON true
         WHERE account.household_id = $1 AND account.account_kind = 'asset'
           AND account.owner_scope = ANY($2)
         GROUP BY account.account_type"#,
        household_id,
        scopes,
        format!("{VALUATION_HISTORY_PREFIX}%")
    )
    .fetch_all(&mut **tx)
    .await
}

async fn load_loans(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    scopes: &[String],
) -> Result<Vec<LoanRow>, sqlx::Error> {
    sqlx::query_as!(
        LoanRow,
        r#"SELECT id, name, current_balance, monthly_payment, interest_rate,
                original_balance, start_date, end_date, notes, linked_property_id,
                app.loan_terms_with_schedule(household_id, id, terms_payload) AS "terms_payload!: Value"
         FROM loans WHERE household_id = $1 AND owner_scope = ANY($2)
         ORDER BY name"#,
        household_id,
        scopes
    )
    .fetch_all(&mut **tx)
    .await
}

async fn load_upcoming(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    scopes: &[String],
    today: NaiveDate,
) -> Result<Vec<UpcomingRow>, sqlx::Error> {
    sqlx::query_as!(
        UpcomingRow,
        r#"SELECT id, description AS "name!", amount, entry_date AS "planned_date!",
                owner_scope, notes AS "description!", status
         FROM ledger_entries
         WHERE household_id = $1 AND direction = 'expense' AND status = 'planned'
           AND entry_date >= $3 AND owner_scope = ANY($2)
         ORDER BY entry_date, created_at LIMIT 5"#,
        household_id,
        scopes,
        today
    )
    .fetch_all(&mut **tx)
    .await
}

async fn load_recent(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    scopes: &[String],
    filter: DashboardFilter,
) -> Result<Vec<FeedRow>, sqlx::Error> {
    sqlx::query_as!(
        FeedRow,
        r#"WITH activity AS (
            SELECT e.id, e.direction AS item_type, e.description AS title,
                   e.amount, e.entry_date, e.owner_scope, e.data_source AS source,
                   category.name AS category, subcategory.name AS subcategory, e.notes
            FROM ledger_entries e
            LEFT JOIN categories category
              ON category.household_id = e.household_id AND category.id = e.category_id
            LEFT JOIN categories subcategory
              ON subcategory.household_id = e.household_id AND subcategory.id = e.subcategory_id
            WHERE e.household_id = $1 AND e.entry_date IS NOT NULL
              AND e.owner_scope = ANY($2)
              AND (e.status = 'actual' OR ($5 AND e.status = 'planned'))
              AND ($3::date IS NULL OR e.entry_date >= $3)
              AND ($4::date IS NULL OR e.entry_date <= $4)
            UNION ALL
            SELECT bill.id, 'utility', bill.provider, bill.amount, bill.charge_date,
                   bill.owner_scope, bill.data_source,
                   'Utilities', service.label, bill.notes
            FROM utility_bills bill
            LEFT JOIN utility_services service
              ON service.household_id = bill.household_id AND service.id = bill.service_id
            WHERE bill.household_id = $1 AND bill.owner_scope = ANY($2)
              AND ($3::date IS NULL OR bill.charge_date >= $3)
              AND ($4::date IS NULL OR bill.charge_date <= $4)
         )
         SELECT id AS "id!", item_type AS "item_type!", title AS "title!",
                amount AS "amount!: Decimal", entry_date AS "entry_date!",
                owner_scope AS "owner_scope!", source AS "source!",
                category, subcategory, notes AS "notes!"
         FROM activity ORDER BY entry_date DESC LIMIT 12"#,
        household_id,
        scopes,
        filter.start_date,
        filter.end_date,
        filter.include_planned
    )
    .fetch_all(&mut **tx)
    .await
}

async fn load_goals(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    scopes: &[String],
) -> Result<Vec<GoalRow>, sqlx::Error> {
    sqlx::query_as!(
        GoalRow,
        r#"SELECT id, name, goal_type, target_amount, target_date, status,
                linked_loan_id
         FROM goals WHERE household_id = $1 AND owner_scope = ANY($2)
         ORDER BY created_at"#,
        household_id,
        scopes
    )
    .fetch_all(&mut **tx)
    .await
}

async fn load_projection_rows_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    scopes: &[String],
) -> Result<Vec<ProjectionRow>, sqlx::Error> {
    sqlx::query_as!(
        ProjectionRow,
        r#"SELECT o.period AS "period!",
                sum(CASE WHEN r.direction = 'income'
                         THEN COALESCE(o.override_amount, o.calculated_amount)
                         ELSE 0 END)::numeric AS "income!: Decimal",
                sum(CASE WHEN r.direction = 'expense'
                         THEN COALESCE(o.override_amount, o.calculated_amount)
                         ELSE 0 END)::numeric AS "expenses!: Decimal"
         FROM planning_occurrences o
         JOIN planning_rules r
           ON r.household_id = o.household_id AND r.id = o.planning_rule_id
         WHERE o.household_id = $1 AND r.enabled AND r.owner_scope = ANY($2)
         GROUP BY o.period ORDER BY o.period"#,
        household_id,
        scopes
    )
    .fetch_all(&mut **tx)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(period: NaiveDate) -> crate::net_worth_months::NetWorthMonthRecord {
        crate::net_worth_months::NetWorthMonthRecord {
            period,
            completed: false,
            components: Vec::new(),
        }
    }

    fn month(text: &str) -> anyhow::Result<NaiveDate> {
        text.parse::<NaiveDate>()
            .map_err(|error| anyhow::anyhow!("{error}"))
    }

    #[test]
    fn horizon_stays_at_today_without_future_curated_months() -> anyhow::Result<()> {
        let today = month("2026-10-01")?;
        assert_eq!(automatic_horizon(today, &[]), today);
        assert_eq!(
            automatic_horizon(today, &[record(month("2026-09-01")?)]),
            today
        );
        Ok(())
    }

    #[test]
    fn horizon_reaches_the_latest_curated_month_past_today() -> anyhow::Result<()> {
        let today = month("2026-10-01")?;
        let mut records = Vec::new();
        for text in ["2026-09-01", "2026-11-01", "2027-06-01"] {
            records.push(record(month(text)?));
        }
        assert_eq!(automatic_horizon(today, &records), month("2027-06-01")?);
        Ok(())
    }
}
