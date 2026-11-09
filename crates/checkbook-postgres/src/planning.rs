use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use checkbook_domain::{cadence_months, median_outlier_trim, ten_percent_trimmed_mean};
use chrono::{Datelike, NaiveDate};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{assets::refresh_property_depreciation_snapshots, tenant};

const HORIZON_MONTHS: u32 = 84;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MaterializationResult {
    pub rules_changed: u64,
    pub occurrences_changed: u64,
    pub depreciation_snapshots_written: u64,
}

impl MaterializationResult {
    #[must_use]
    pub const fn total_changes(self) -> u64 {
        self.rules_changed + self.occurrences_changed + self.depreciation_snapshots_written
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PlanningStoreError {
    #[error("database error")]
    Database(#[from] sqlx::Error),
    #[error("planning calculation failed")]
    Calculation,
    #[error("not found: {0}")]
    NotFound(&'static str),
    #[error("forbidden")]
    Forbidden,
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    BadRequest(String),
}

#[derive(Debug, Clone)]
struct DesiredRule {
    stable_key: String,
    rule_kind: &'static str,
    title: String,
    amount: Decimal,
    direction: &'static str,
    owner_scope: String,
    category_id: Option<Uuid>,
    income_source_id: Option<Uuid>,
    linked_loan_id: Option<Uuid>,
    active_from: Option<NaiveDate>,
    active_until: Option<NaiveDate>,
    rule_payload: Value,
    occurrences: Vec<DesiredOccurrence>,
}

#[derive(Debug, Clone)]
struct DesiredOccurrence {
    period: NaiveDate,
    amount: Decimal,
    sort_order: i32,
}

#[derive(Debug, FromRow)]
struct IncomeActualRow {
    identity: String,
    title: String,
    income_source_id: Option<Uuid>,
    owner_scope: String,
    period: NaiveDate,
    amount: Decimal,
    started_on: Option<NaiveDate>,
    ended_on: Option<NaiveDate>,
    sort_order: i32,
}

#[derive(Debug, FromRow)]
struct HousingActualRow {
    description: String,
    category_name: Option<String>,
    subcategory_name: Option<String>,
    period: NaiveDate,
    amount: Decimal,
}

#[derive(Debug, FromRow)]
struct MonthlyAmountRow {
    period: NaiveDate,
    amount: Decimal,
}

#[derive(Debug, FromRow)]
struct LoanRuleRow {
    id: Uuid,
    name: String,
    owner_scope: String,
    current_balance: Decimal,
    monthly_payment: Decimal,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
}

#[derive(Debug, FromRow)]
struct RecurringRuleRow {
    id: Uuid,
    name: String,
    amount: Decimal,
    cadence: String,
    next_due_date: NaiveDate,
    owner_scope: String,
    category_id: Option<Uuid>,
    is_active: bool,
}

#[derive(Debug, FromRow)]
struct ExistingRule {
    id: Uuid,
    stable_key: String,
}

#[derive(Debug, FromRow)]
struct ExistingOccurrence {
    id: Uuid,
    planning_rule_id: Uuid,
    period: NaiveDate,
}

pub async fn materialize_household(
    pool: &PgPool,
    household_id: Uuid,
    today: NaiveDate,
) -> Result<MaterializationResult, PlanningStoreError> {
    let current_month = month_start(today)?;
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    tenant::advisory_lock(&mut transaction, household_id).await?;
    let currency = sqlx::query!(
        "SELECT base_currency FROM households WHERE id = $1",
        household_id
    )
    .fetch_one(&mut *transaction)
    .await?
    .base_currency;
    crate::recurring_expenses::materialize_due(&mut transaction, household_id, today, &currency)
        .await
        .map_err(|error| PlanningStoreError::Validation(error.to_string()))?;
    let result =
        materialize_household_in_transaction(&mut transaction, household_id, current_month).await?;
    transaction.commit().await?;
    Ok(result)
}

pub async fn materialize_household_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    current_month: NaiveDate,
) -> Result<MaterializationResult, PlanningStoreError> {
    let desired = build_rules(transaction, household_id, current_month).await?;
    let mut result = reconcile(transaction, household_id, desired).await?;
    result.depreciation_snapshots_written =
        refresh_property_depreciation_snapshots(transaction, household_id, current_month).await?;
    Ok(result)
}

async fn build_rules(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    current_month: NaiveDate,
) -> Result<Vec<DesiredRule>, PlanningStoreError> {
    let mut rules = income_rules(transaction, household_id, current_month).await?;
    if let Some(rule) = housing_rule(transaction, household_id, current_month).await? {
        rules.push(rule);
    }
    rules.extend(loan_rules(transaction, household_id, current_month).await?);
    rules.extend(recurring_rules(transaction, household_id, current_month).await?);
    rules.extend(recurring_expense_rules(transaction, household_id, current_month).await?);
    Ok(rules)
}

async fn income_rules(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    current_month: NaiveDate,
) -> Result<Vec<DesiredRule>, PlanningStoreError> {
    let cutoff = add_months(current_month, -8)?;
    let rows = sqlx::query_as!(
        IncomeActualRow,
        "SELECT
            CASE
                WHEN e.income_source_id IS NOT NULL THEN 'source:' || e.income_source_id::text
                ELSE 'description:' || lower(trim(e.description))
            END AS \"identity!\",
            COALESCE(s.name, e.description) AS \"title!\",
            e.income_source_id,
            e.owner_scope,
            date_trunc('month', e.entry_date)::date AS \"period!\",
            sum(e.amount)::numeric AS \"amount!\",
            s.started_on,
            s.ended_on,
            COALESCE(s.sort_order, 0) AS \"sort_order!\"
         FROM ledger_entries e
         LEFT JOIN income_sources s
           ON s.household_id = e.household_id AND s.id = e.income_source_id
         WHERE e.household_id = $1
           AND e.direction = 'income'
           AND e.status = 'actual'
           AND e.entry_date >= $2
         GROUP BY
            CASE
                WHEN e.income_source_id IS NOT NULL THEN 'source:' || e.income_source_id::text
                ELSE 'description:' || lower(trim(e.description))
            END,
            COALESCE(s.name, e.description), e.income_source_id,
            e.owner_scope, date_trunc('month', e.entry_date)::date,
            s.started_on, s.ended_on, s.sort_order
         ORDER BY 1, 5",
        household_id,
        cutoff
    )
    .fetch_all(&mut **transaction)
    .await?;

    let occupied = sqlx::query!(
        "SELECT DISTINCT
            CASE
                WHEN income_source_id IS NOT NULL THEN 'source:' || income_source_id::text
                ELSE 'description:' || lower(trim(description))
            END AS \"identity!\",
            date_trunc('month', entry_date)::date AS \"period!\"
         FROM ledger_entries
         WHERE household_id = $1
           AND direction = 'income'
           AND entry_date IS NOT NULL
           AND (
                status = 'actual'
                OR (status = 'planned' AND planning_occurrence_id IS NULL)
           )",
        household_id
    )
    .fetch_all(&mut **transaction)
    .await?
    .into_iter()
    .map(|row| (row.identity, row.period))
    .collect::<HashSet<_>>();

    let mut grouped: BTreeMap<String, Vec<IncomeActualRow>> = BTreeMap::new();
    for row in rows {
        grouped.entry(row.identity.clone()).or_default().push(row);
    }
    let mut rules = Vec::new();
    for (identity, source_rows) in grouped {
        let mut by_month = BTreeMap::<NaiveDate, Decimal>::new();
        for row in &source_rows {
            *by_month.entry(row.period).or_default() += row.amount;
        }
        let monthly = by_month.into_values().collect::<Vec<_>>();
        let baseline = ten_percent_trimmed_mean(median_outlier_trim(monthly))
            .map_err(|_| PlanningStoreError::Calculation)?;
        if baseline <= Decimal::new(1, 2) {
            continue;
        }
        let first = source_rows.first().ok_or(PlanningStoreError::Calculation)?;
        let owner_scope = dominant_scope(&source_rows);
        let mut occurrences = Vec::new();
        for index in 0..HORIZON_MONTHS {
            let period = add_months(
                current_month,
                i32::try_from(index).map_err(|_| PlanningStoreError::Calculation)?,
            )?;
            if first
                .started_on
                .is_some_and(|value| period < month_start(value).unwrap_or(value))
                || first
                    .ended_on
                    .is_some_and(|value| period > month_start(value).unwrap_or(value))
                || occupied.contains(&(identity.clone(), period))
            {
                continue;
            }
            occurrences.push(DesiredOccurrence {
                period,
                amount: baseline,
                sort_order: -320 + first.sort_order,
            });
        }
        rules.push(DesiredRule {
            stable_key: format!("system:income:{identity}"),
            rule_kind: "income",
            title: first.title.clone(),
            amount: baseline,
            direction: "income",
            owner_scope,
            category_id: None,
            income_source_id: first.income_source_id,
            linked_loan_id: None,
            active_from: first.started_on,
            active_until: first.ended_on,
            rule_payload: json!({
                "baseline_method": "trailing_9_month_median_and_10_percent_trimmed_mean",
                "baseline_key": identity
            }),
            occurrences,
        });
    }
    Ok(rules)
}

fn dominant_scope(rows: &[IncomeActualRow]) -> String {
    let mut totals: HashMap<&str, Decimal> = HashMap::new();
    for row in rows {
        *totals.entry(&row.owner_scope).or_default() += row.amount;
    }
    totals
        .into_iter()
        .max_by(|left, right| left.1.cmp(&right.1))
        .map_or_else(|| "joint".to_owned(), |(scope, _)| scope.to_owned())
}

async fn housing_rule(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    current_month: NaiveDate,
) -> Result<Option<DesiredRule>, PlanningStoreError> {
    let cutoff = add_months(current_month, -12)?;
    let expenses = sqlx::query_as!(
        HousingActualRow,
        "SELECT e.description, category.name AS \"category_name?\",
                subcategory.name AS \"subcategory_name?\",
                date_trunc('month', e.entry_date)::date AS \"period!\",
                e.amount
         FROM ledger_entries e
         LEFT JOIN categories category
           ON category.household_id = e.household_id AND category.id = e.category_id
         LEFT JOIN categories subcategory
           ON subcategory.household_id = e.household_id AND subcategory.id = e.subcategory_id
         WHERE e.household_id = $1
           AND e.direction = 'expense'
           AND e.status = 'actual'
           AND e.data_source <> 'app_recurring'
           AND e.entry_date >= $2",
        household_id,
        cutoff
    )
    .fetch_all(&mut **transaction)
    .await?;
    let utilities = sqlx::query_as!(
        MonthlyAmountRow,
        "SELECT date_trunc('month', charge_date)::date AS \"period!\",
                sum(amount)::numeric AS \"amount!\"
         FROM utility_bills
         WHERE household_id = $1 AND charge_date >= $2
         GROUP BY date_trunc('month', charge_date)::date",
        household_id,
        cutoff
    )
    .fetch_all(&mut **transaction)
    .await?;
    let mut monthly: BTreeMap<NaiveDate, Decimal> = BTreeMap::new();
    for row in expenses {
        if is_housing_expense(&row) {
            *monthly.entry(row.period).or_default() += row.amount;
        }
    }
    for row in utilities {
        *monthly.entry(row.period).or_default() += row.amount;
    }
    let amount = ten_percent_trimmed_mean(median_outlier_trim(monthly.values().copied().collect()))
        .map_err(|_| PlanningStoreError::Calculation)?;
    if amount <= Decimal::new(1, 2) {
        return Ok(None);
    }
    let category_id = ensure_planning_category(transaction, household_id, "Housing").await?;
    let occurrences = horizon(current_month, amount, -220)?;
    Ok(Some(DesiredRule {
        stable_key: "system:housing".to_owned(),
        rule_kind: "housing",
        title: "Housing & utilities".to_owned(),
        amount,
        direction: "expense",
        owner_scope: "joint".to_owned(),
        category_id: Some(category_id),
        income_source_id: None,
        linked_loan_id: None,
        active_from: None,
        active_until: None,
        rule_payload: json!({
            "baseline_method": "trailing_12_month_median_and_10_percent_trimmed_mean",
            "keywords": ["housing", "rent", "czynsz", "hoa", "property tax", "property insurance", "home maintenance", "maintenance"]
        }),
        occurrences,
    }))
}

fn is_housing_expense(row: &HousingActualRow) -> bool {
    let text = format!(
        "{} {} {}",
        row.description,
        row.category_name.as_deref().unwrap_or_default(),
        row.subcategory_name.as_deref().unwrap_or_default()
    )
    .to_ascii_lowercase();
    if ["mortgage", "loan", "credit", "debt"]
        .iter()
        .any(|token| text.contains(token))
    {
        return false;
    }
    [
        "housing",
        "rent",
        "czynsz",
        "hoa",
        "property tax",
        "property insurance",
        "home maintenance",
        "maintenance",
    ]
    .iter()
    .any(|token| text.contains(token))
}

async fn loan_rules(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    current_month: NaiveDate,
) -> Result<Vec<DesiredRule>, PlanningStoreError> {
    let rows = sqlx::query_as!(
        LoanRuleRow,
        "SELECT id, name, owner_scope, current_balance, monthly_payment,
                start_date, end_date
         FROM loans
         WHERE household_id = $1 AND current_balance > 0 AND monthly_payment > 0
         ORDER BY liability_type DESC, name",
        household_id
    )
    .fetch_all(&mut **transaction)
    .await?;
    let mut rules = Vec::with_capacity(rows.len());
    for (loan_index, row) in rows.into_iter().enumerate() {
        let category_id = sqlx::query_scalar!(
            "SELECT id FROM categories
             WHERE household_id = $1 AND linked_loan_id = $2
               AND kind = 'expense' AND parent_id IS NULL",
            household_id,
            row.id
        )
        .fetch_one(&mut **transaction)
        .await?;
        let start = row
            .start_date
            .map(month_start)
            .transpose()?
            .unwrap_or(current_month)
            .max(current_month);
        let end = row
            .end_date
            .map(month_start)
            .transpose()?
            .unwrap_or(add_months(
                current_month,
                i32::try_from(HORIZON_MONTHS - 1).map_err(|_| PlanningStoreError::Calculation)?,
            )?);
        let mut balance = row.current_balance;
        let mut occurrences = Vec::new();
        for index in 0..HORIZON_MONTHS {
            let period = add_months(
                current_month,
                i32::try_from(index).map_err(|_| PlanningStoreError::Calculation)?,
            )?;
            if period < start || period > end || balance <= Decimal::ZERO {
                continue;
            }
            let payment = row.monthly_payment.min(balance);
            occurrences.push(DesiredOccurrence {
                period,
                amount: payment,
                sort_order: -180
                    + i32::try_from(loan_index).map_err(|_| PlanningStoreError::Calculation)?,
            });
            balance -= payment;
        }
        rules.push(DesiredRule {
            stable_key: format!("system:loan:{}", row.id),
            rule_kind: "loan",
            title: row.name,
            amount: row.monthly_payment,
            direction: "expense",
            owner_scope: row.owner_scope,
            category_id: Some(category_id),
            income_source_id: None,
            linked_loan_id: Some(row.id),
            active_from: row.start_date,
            active_until: row.end_date,
            rule_payload: json!({"base_amount": row.monthly_payment}),
            occurrences,
        });
    }
    Ok(rules)
}

async fn recurring_rules(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    current_month: NaiveDate,
) -> Result<Vec<DesiredRule>, PlanningStoreError> {
    let rows = sqlx::query_as!(
        RecurringRuleRow,
        "SELECT id, name, amount, cadence, next_due_date, owner_scope,
                category_id, is_active
         FROM recurring_commitments
         WHERE household_id = $1",
        household_id
    )
    .fetch_all(&mut **transaction)
    .await?;
    let mut rules = Vec::new();
    for row in rows {
        if !row.is_active {
            continue;
        }
        let every = cadence_months(&row.cadence).map_err(|_| PlanningStoreError::Calculation)?;
        let first = month_start(row.next_due_date)?;
        let mut occurrences = Vec::new();
        for index in 0..HORIZON_MONTHS {
            let period = add_months(
                current_month,
                i32::try_from(index).map_err(|_| PlanningStoreError::Calculation)?,
            )?;
            let delta = month_delta(first, period);
            if delta >= 0
                && u32::try_from(delta)
                    .map_err(|_| PlanningStoreError::Calculation)?
                    .is_multiple_of(every)
            {
                occurrences.push(DesiredOccurrence {
                    period,
                    amount: row.amount,
                    sort_order: -120,
                });
            }
        }
        rules.push(DesiredRule {
            stable_key: format!("system:recurring:{}", row.id),
            rule_kind: "recurring",
            title: row.name,
            amount: row.amount,
            direction: "expense",
            owner_scope: row.owner_scope,
            category_id: row.category_id,
            income_source_id: None,
            linked_loan_id: None,
            active_from: Some(row.next_due_date),
            active_until: None,
            rule_payload: json!({"cadence": row.cadence, "commitment_id": row.id}),
            occurrences,
        });
    }
    Ok(rules)
}

async fn recurring_expense_rules(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    current_month: NaiveDate,
) -> Result<Vec<DesiredRule>, PlanningStoreError> {
    let schedules = crate::recurring_expenses::load_in_transaction(transaction, household_id)
        .await
        .map_err(|error| PlanningStoreError::Validation(error.to_string()))?;
    let until = add_months(current_month, HORIZON_MONTHS as i32)?
        .pred_opt()
        .ok_or(PlanningStoreError::Calculation)?;
    let mut rules = Vec::new();
    for schedule in schedules {
        let record = schedule.record;
        if !record.is_active {
            continue;
        }
        let dates = checkbook_domain::recurring_occurrences(
            record.start_date,
            record.end_date,
            &record.cadence,
            current_month,
            until,
        )
        .map_err(|_| PlanningStoreError::Calculation)?;
        let mut monthly = BTreeMap::new();
        for occurrence in dates {
            if i64::from(occurrence.index) >= i64::from(schedule.next_index) {
                *monthly
                    .entry(month_start(occurrence.date)?)
                    .or_insert(Decimal::ZERO) += record.amount;
            }
        }
        rules.push(DesiredRule {
            stable_key: format!("system:recurring-expense:{}", record.id),
            rule_kind: "recurring",
            title: record.description,
            amount: record.amount,
            direction: "expense",
            owner_scope: record.owner_scope,
            category_id: record.category_id,
            income_source_id: None,
            linked_loan_id: None,
            active_from: Some(record.start_date),
            active_until: record.end_date,
            rule_payload: json!({"cadence": record.cadence, "recurring_expense_id": record.id}),
            occurrences: monthly
                .into_iter()
                .map(|(period, amount)| DesiredOccurrence {
                    period,
                    amount,
                    sort_order: -120,
                })
                .collect(),
        });
    }
    Ok(rules)
}

async fn reconcile(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    desired: Vec<DesiredRule>,
) -> Result<MaterializationResult, PlanningStoreError> {
    let desired_keys = desired
        .iter()
        .map(|rule| rule.stable_key.clone())
        .collect::<BTreeSet<_>>();
    let existing = sqlx::query_as!(
        ExistingRule,
        "SELECT id, stable_key
         FROM planning_rules
         WHERE household_id = $1 AND stable_key LIKE 'system:%'",
        household_id
    )
    .fetch_all(&mut **transaction)
    .await?;
    let mut result = MaterializationResult::default();
    for rule in existing
        .iter()
        .filter(|rule| !desired_keys.contains(&rule.stable_key))
    {
        result.rules_changed += sqlx::query!(
            "DELETE FROM planning_rules WHERE household_id = $1 AND id = $2",
            household_id,
            rule.id
        )
        .execute(&mut **transaction)
        .await?
        .rows_affected();
    }

    let mut rule_ids = HashMap::new();
    for rule in &desired {
        let changed = sqlx::query_scalar!(
            "INSERT INTO planning_rules
                (household_id, rule_kind, stable_key, title, amount, direction,
                 owner_scope, category_id, income_source_id, linked_loan_id,
                 active_from, active_until, enabled, rule_payload)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13)
             ON CONFLICT (household_id, stable_key) DO UPDATE
             SET rule_kind = EXCLUDED.rule_kind,
                 title = EXCLUDED.title,
                 amount = EXCLUDED.amount,
                 direction = EXCLUDED.direction,
                 owner_scope = EXCLUDED.owner_scope,
                 category_id = EXCLUDED.category_id,
                 income_source_id = EXCLUDED.income_source_id,
                 linked_loan_id = EXCLUDED.linked_loan_id,
                 active_from = EXCLUDED.active_from,
                 active_until = EXCLUDED.active_until,
                 enabled = true,
                 rule_payload = EXCLUDED.rule_payload,
                 updated_at = now()
             WHERE (planning_rules.rule_kind, planning_rules.title, planning_rules.amount,
                    planning_rules.direction, planning_rules.owner_scope,
                    planning_rules.category_id, planning_rules.income_source_id,
                    planning_rules.linked_loan_id, planning_rules.active_from,
                    planning_rules.active_until, planning_rules.enabled,
                    planning_rules.rule_payload)
                   IS DISTINCT FROM
                   (EXCLUDED.rule_kind, EXCLUDED.title, EXCLUDED.amount,
                    EXCLUDED.direction, EXCLUDED.owner_scope,
                    EXCLUDED.category_id, EXCLUDED.income_source_id,
                    EXCLUDED.linked_loan_id, EXCLUDED.active_from,
                    EXCLUDED.active_until, true, EXCLUDED.rule_payload)
             RETURNING id",
            household_id,
            rule.rule_kind,
            rule.stable_key,
            rule.title,
            rule.amount,
            rule.direction,
            rule.owner_scope,
            rule.category_id,
            rule.income_source_id,
            rule.linked_loan_id,
            rule.active_from,
            rule.active_until,
            &rule.rule_payload
        )
        .fetch_optional(&mut **transaction)
        .await?;
        let id = if let Some(id) = changed {
            result.rules_changed += 1;
            id
        } else {
            sqlx::query_scalar!(
                "SELECT id FROM planning_rules
                 WHERE household_id = $1 AND stable_key = $2",
                household_id,
                rule.stable_key
            )
            .fetch_one(&mut **transaction)
            .await?
        };
        rule_ids.insert(rule.stable_key.clone(), id);
    }

    let system_rule_ids = rule_ids.values().copied().collect::<Vec<_>>();
    let existing_occurrences = if system_rule_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as!(
            ExistingOccurrence,
            "SELECT id, planning_rule_id, period
             FROM planning_occurrences
             WHERE household_id = $1 AND planning_rule_id = ANY($2)",
            household_id,
            &system_rule_ids
        )
        .fetch_all(&mut **transaction)
        .await?
    };
    let desired_occurrence_keys = desired
        .iter()
        .flat_map(|rule| {
            let rule_id = rule_ids[&rule.stable_key];
            rule.occurrences
                .iter()
                .map(move |occurrence| (rule_id, occurrence.period))
        })
        .collect::<HashSet<_>>();
    for occurrence in existing_occurrences
        .iter()
        .filter(|row| !desired_occurrence_keys.contains(&(row.planning_rule_id, row.period)))
    {
        result.occurrences_changed += sqlx::query!(
            "DELETE FROM planning_occurrences WHERE household_id = $1 AND id = $2",
            household_id,
            occurrence.id
        )
        .execute(&mut **transaction)
        .await?
        .rows_affected();
    }
    for rule in desired {
        let rule_id = rule_ids[&rule.stable_key];
        for occurrence in rule.occurrences {
            let changed = sqlx::query!(
                "INSERT INTO planning_occurrences
                    (household_id, planning_rule_id, period, calculated_amount, sort_order)
                 VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (household_id, planning_rule_id, period) DO UPDATE
                 SET calculated_amount = EXCLUDED.calculated_amount,
                     sort_order = EXCLUDED.sort_order,
                     updated_at = now()
                 WHERE (planning_occurrences.calculated_amount,
                        planning_occurrences.sort_order)
                       IS DISTINCT FROM
                       (EXCLUDED.calculated_amount, EXCLUDED.sort_order)",
                household_id,
                rule_id,
                occurrence.period,
                occurrence.amount,
                occurrence.sort_order
            )
            .execute(&mut **transaction)
            .await?;
            result.occurrences_changed += changed.rows_affected();
        }
    }
    Ok(result)
}

async fn ensure_planning_category(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    name: &str,
) -> Result<Uuid, PlanningStoreError> {
    let normalized = name.trim().to_ascii_lowercase();
    Ok(sqlx::query_scalar!(
        "INSERT INTO categories
            (household_id, kind, name, normalized_name, is_system)
         VALUES ($1, 'planning', $2, $3, true)
         ON CONFLICT (household_id, kind, normalized_name)
             WHERE parent_id IS NULL
         DO UPDATE SET name = EXCLUDED.name
         RETURNING id",
        household_id,
        name,
        normalized
    )
    .fetch_one(&mut **transaction)
    .await?)
}

fn horizon(
    current_month: NaiveDate,
    amount: Decimal,
    sort_order: i32,
) -> Result<Vec<DesiredOccurrence>, PlanningStoreError> {
    (0..HORIZON_MONTHS)
        .map(|index| {
            Ok(DesiredOccurrence {
                period: add_months(
                    current_month,
                    i32::try_from(index).map_err(|_| PlanningStoreError::Calculation)?,
                )?,
                amount,
                sort_order,
            })
        })
        .collect()
}

fn month_start(value: NaiveDate) -> Result<NaiveDate, PlanningStoreError> {
    checkbook_domain::month_start(value).map_err(|_| PlanningStoreError::Calculation)
}

fn add_months(value: NaiveDate, delta: i32) -> Result<NaiveDate, PlanningStoreError> {
    checkbook_domain::shift_month_start(value, delta).map_err(|_| PlanningStoreError::Calculation)
}

fn month_delta(start: NaiveDate, end: NaiveDate) -> i32 {
    (end.year() - start.year()) * 12 + i32::try_from(end.month()).unwrap_or_default()
        - i32::try_from(start.month()).unwrap_or_default()
}
