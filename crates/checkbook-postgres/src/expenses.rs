use std::collections::BTreeMap;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::records::RecordsStoreError;
use crate::tenant;

#[derive(Debug, Clone)]
pub struct ExpenseGroupRecord {
    pub id: Uuid,
    pub name: String,
    pub color: String,
    pub notes: String,
    pub sort_order: i32,
    pub is_retired: bool,
    pub can_delete: bool,
    pub is_source_linked: bool,
}

#[derive(Debug, Clone)]
pub struct ExpenseGroupInput {
    pub name: String,
    pub color: String,
    pub notes: String,
    pub sort_order: i32,
    pub is_retired: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct ExpenseCategoryRecord {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
    pub expense_group_id: Option<Uuid>,
    pub is_system: bool,
    pub sort_order: i32,
    pub is_retired: bool,
    pub can_delete: bool,
    pub is_source_linked: bool,
}

#[derive(Debug, Clone)]
pub struct ExpenseCategoryInput {
    pub name: String,
    pub expense_group_id: Option<Uuid>,
    pub sort_order: i32,
    pub is_retired: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct ExpenseCategoryStatsRow {
    pub category_id: Uuid,
    pub total_amount: Decimal,
    pub entry_count: i64,
    pub first_entry_date: Option<NaiveDate>,
    pub last_entry_date: Option<NaiveDate>,
    pub month_count: i64,
}

#[derive(Debug, Clone)]
pub struct ExpensesBoard {
    pub groups: Vec<ExpenseGroupRecord>,
    pub categories: Vec<ExpenseCategoryRecord>,
    pub stats: Vec<ExpenseCategoryStatsRow>,
    pub last_actual_entry_date: Option<NaiveDate>,
    pub monthly_totals: Vec<ExpenseCategoryMonthlyTotalRow>,
    pub utility_property_ids: Vec<Uuid>,
}

#[derive(Debug)]
struct PropertyUtilityMonthRow {
    property_id: Uuid,
    expense_group_id: Uuid,
    is_retired: bool,
    period: Option<NaiveDate>,
    amount: Decimal,
    entry_count: i64,
    first_entry_date: Option<NaiveDate>,
    last_entry_date: Option<NaiveDate>,
}

fn project_property_utilities(
    rows: Vec<PropertyUtilityMonthRow>,
    categories: &mut Vec<ExpenseCategoryRecord>,
    stats: &mut Vec<ExpenseCategoryStatsRow>,
    monthly_totals: &mut Vec<ExpenseCategoryMonthlyTotalRow>,
) -> Vec<Uuid> {
    let mut subjects = BTreeMap::new();
    for row in rows {
        let stat = subjects.entry(row.property_id).or_insert_with(|| {
            categories.push(ExpenseCategoryRecord {
                id: row.property_id,
                name: "Utilities".to_owned(),
                parent_id: None,
                expense_group_id: Some(row.expense_group_id),
                is_system: true,
                sort_order: 0,
                is_retired: row.is_retired,
                can_delete: false,
                is_source_linked: true,
            });
            ExpenseCategoryStatsRow {
                category_id: row.property_id,
                total_amount: Decimal::ZERO,
                entry_count: 0,
                first_entry_date: None,
                last_entry_date: None,
                month_count: 0,
            }
        });
        stat.total_amount += row.amount;
        stat.entry_count += row.entry_count;
        stat.first_entry_date = match (stat.first_entry_date, row.first_entry_date) {
            (Some(left), Some(right)) => Some(left.min(right)),
            (left, right) => left.or(right),
        };
        stat.last_entry_date = stat.last_entry_date.max(row.last_entry_date);
        if let Some(period) = row.period {
            stat.month_count += 1;
            monthly_totals.push(ExpenseCategoryMonthlyTotalRow {
                category_id: Some(row.property_id),
                period,
                amount: row.amount,
            });
        }
    }
    let ids = subjects.keys().copied().collect();
    stats.extend(subjects.into_values());
    ids
}

#[derive(Debug, Clone)]
pub struct ExpenseCategoryMonthlyTotalRow {
    pub category_id: Option<Uuid>,
    pub period: NaiveDate,
    pub amount: Decimal,
}

#[derive(Debug, Clone)]
pub struct ExpenseEntryRecord {
    pub id: Uuid,
    pub description: String,
    pub amount: Decimal,
    pub entry_date: Option<NaiveDate>,
    pub owner_scope: String,
    pub notes: String,
    pub data_source: String,
    pub category_id: Option<Uuid>,
    pub subcategory_id: Option<Uuid>,
    pub extra_payload: Value,
}

#[derive(Debug, Clone)]
pub struct ExpenseMonthlyTotalRow {
    pub period: NaiveDate,
    pub amount: Decimal,
}

#[derive(Debug, Clone)]
pub struct ExpenseCategoryDetail {
    pub category: ExpenseCategoryRecord,
    pub subcategories: Vec<ExpenseCategoryRecord>,
    pub monthly_totals: Vec<ExpenseMonthlyTotalRow>,
    pub entries: Vec<ExpenseEntryRecord>,
}

#[derive(Debug, Clone)]
pub struct ExpenseEntryUpdateInput {
    pub amount: Decimal,
    pub entry_date: Option<NaiveDate>,
    pub description: String,
    pub notes: String,
    pub owner_scope: String,
    pub category_id: Option<Uuid>,
    pub subcategory_id: Option<Uuid>,
    pub allowed_scopes: Vec<String>,
}

const DETAIL_ENTRY_LIMIT: i64 = 200;

#[derive(Debug, Clone)]
pub struct ExpenseNameSuggestionRecord {
    pub description: String,
    pub category_id: Uuid,
    pub category_name: String,
    pub expense_group_id: Option<Uuid>,
}

pub async fn load_name_suggestions(
    pool: &PgPool,
    household_id: Uuid,
    allowed_scopes: &[String],
    query: &str,
    today: NaiveDate,
) -> Result<Vec<ExpenseNameSuggestionRecord>, RecordsStoreError> {
    if query.chars().count() > 120 {
        return Err(RecordsStoreError::Validation(
            "Expense name query must not exceed 120 characters.".to_owned(),
        ));
    }
    let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
    if query.chars().count() < 2 {
        return Ok(Vec::new());
    }
    // LIKE metacharacters are literal user input, including the escape itself.
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let contains = format!("%{escaped}%");
    let prefix = format!("{escaped}%");
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let rows = sqlx::query_as!(
        ExpenseNameSuggestionRecord,
        r#"WITH matches AS (
            SELECT e.id, e.description, e.entry_date, root.id AS category_id,
                   root.name AS category_name, root.expense_group_id,
                   lower(btrim(regexp_replace(e.description, '\s+', ' ', 'g'))) AS normalized
            FROM ledger_entries e
            JOIN categories c ON c.household_id = e.household_id
                AND c.id = coalesce(e.subcategory_id, e.category_id)
            JOIN categories root ON root.household_id = c.household_id
                AND root.id = coalesce(c.parent_id, c.id)
            LEFT JOIN expense_groups g ON g.household_id = root.household_id
                AND g.id = root.expense_group_id
            WHERE e.household_id = $1 AND e.owner_scope = ANY($2)
                AND e.direction = 'expense' AND e.status = 'actual' AND e.entry_date <= $6
                AND c.kind = 'expense' AND NOT c.is_retired
                AND root.kind = 'expense' AND root.parent_id IS NULL AND NOT root.is_retired
                AND (root.expense_group_id IS NULL OR NOT g.is_retired)
                AND lower(btrim(regexp_replace(e.description, '\s+', ' ', 'g'))) LIKE lower($4)
        ), ranked AS (
            SELECT *, count(*) OVER (PARTITION BY normalized, category_id) AS frequency,
                   row_number() OVER (PARTITION BY normalized, category_id
                       ORDER BY entry_date DESC, id) AS classification_row
            FROM matches
        ), descriptions AS (
            SELECT *, row_number() OVER (PARTITION BY normalized
                ORDER BY entry_date DESC, frequency DESC, category_id, id) AS description_row
            FROM ranked WHERE classification_row = 1
        )
        SELECT description AS "description!", category_id AS "category_id!",
               category_name AS "category_name!", expense_group_id
        FROM descriptions WHERE description_row = 1
        ORDER BY CASE WHEN normalized = lower($3) THEN 0
                      WHEN normalized LIKE lower($5) THEN 1 ELSE 2 END,
                 entry_date DESC, frequency DESC, normalized, category_id
        LIMIT 8"#,
        household_id,
        allowed_scopes,
        query,
        contains,
        prefix,
        today
    )
    .fetch_all(&mut *transaction)
    .await?;
    Ok(rows)
}

pub async fn load_board(
    pool: &PgPool,
    household_id: Uuid,
    allowed_scopes: &[String],
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
) -> Result<ExpensesBoard, RecordsStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let groups = list_groups(&mut transaction, household_id).await?;
    let mut categories = sqlx::query_as!(
        ExpenseCategoryRecord,
        r#"SELECT id, name, parent_id, expense_group_id, is_system, sort_order, is_retired,
                 app.expense_category_can_delete(household_id, id) AS "can_delete!",
                 linked_loan_id IS NOT NULL AS "is_source_linked!"
         FROM categories
         WHERE household_id = $1 AND kind = 'expense'
         ORDER BY sort_order, name"#,
        household_id
    )
    .fetch_all(&mut *transaction)
    .await?;
    let mut stats = sqlx::query_as!(
        ExpenseCategoryStatsRow,
        r#"SELECT e.category_id AS "category_id!",
                sum(e.amount)::numeric AS "total_amount!: Decimal",
                count(*) AS "entry_count!",
                min(e.entry_date) AS first_entry_date,
                max(e.entry_date) AS last_entry_date,
                count(DISTINCT date_trunc('month', e.entry_date)) AS "month_count!"
         FROM ledger_entries e
         WHERE e.household_id = $1 AND e.direction = 'expense'
           AND e.status = 'actual' AND e.category_id IS NOT NULL
           AND e.entry_date IS NOT NULL
           AND e.owner_scope = ANY($2)
           AND ($3::date IS NULL OR e.entry_date >= $3)
           AND ($4::date IS NULL OR e.entry_date <= $4)
         GROUP BY e.category_id"#,
        household_id,
        allowed_scopes,
        start_date,
        end_date
    )
    .fetch_all(&mut *transaction)
    .await?;
    let mut monthly_totals = sqlx::query_as!(
        ExpenseCategoryMonthlyTotalRow,
        r#"SELECT category_id, date_trunc('month', entry_date)::date AS "period!",
                  sum(amount)::numeric AS "amount!: Decimal"
           FROM ledger_entries
           WHERE household_id = $1 AND direction = 'expense' AND status = 'actual'
             AND entry_date IS NOT NULL AND owner_scope = ANY($2)
             AND ($3::date IS NULL OR entry_date >= $3)
             AND ($4::date IS NULL OR entry_date <= $4)
           GROUP BY 1, 2 ORDER BY 2, 1"#,
        household_id,
        allowed_scopes,
        start_date,
        end_date
    )
    .fetch_all(&mut *transaction)
    .await?;
    // Utilities remain canonical bills, not duplicated ledger expenses.
    let utility_months = load_property_utility_months(
        &mut transaction,
        household_id,
        allowed_scopes,
        start_date,
        end_date,
    )
    .await?;
    let utility_property_ids = project_property_utilities(
        utility_months,
        &mut categories,
        &mut stats,
        &mut monthly_totals,
    );
    // Future loan schedules must not extend unrelated categories' historical averages.
    let last_actual_entry_date = stats.iter().filter_map(|row| row.last_entry_date).max();
    let loan_entries = load_loan_expenses(
        &mut transaction,
        household_id,
        allowed_scopes,
        None,
        start_date,
        end_date,
    )
    .await?;
    for entry in loan_entries {
        let (Some(category_id), Some(entry_date)) = (entry.category_id, entry.entry_date) else {
            continue;
        };
        let period = checkbook_domain::month_start(entry_date)
            .map_err(|error| RecordsStoreError::Validation(error.to_string()))?;
        if let Some(stat) = stats
            .iter_mut()
            .find(|stat| stat.category_id == category_id)
        {
            stat.total_amount += entry.amount;
            stat.entry_count += 1;
            stat.first_entry_date = Some(
                stat.first_entry_date
                    .map_or(entry_date, |d| d.min(entry_date)),
            );
            stat.last_entry_date = Some(
                stat.last_entry_date
                    .map_or(entry_date, |d| d.max(entry_date)),
            );
        } else {
            stats.push(ExpenseCategoryStatsRow {
                category_id,
                total_amount: entry.amount,
                entry_count: 1,
                first_entry_date: Some(entry_date),
                last_entry_date: Some(entry_date),
                month_count: 1,
            });
        }
        monthly_totals.push(ExpenseCategoryMonthlyTotalRow {
            category_id: Some(category_id),
            period,
            amount: entry.amount,
        });
    }
    let mut by_month = BTreeMap::new();
    for row in monthly_totals {
        *by_month
            .entry((row.period, row.category_id))
            .or_insert(Decimal::ZERO) += row.amount;
    }
    let monthly_totals: Vec<_> = by_month
        .into_iter()
        .map(
            |((period, category_id), amount)| ExpenseCategoryMonthlyTotalRow {
                category_id,
                period,
                amount,
            },
        )
        .collect();
    for stat in &mut stats {
        stat.month_count = i64::try_from(
            monthly_totals
                .iter()
                .filter(|row| row.category_id == Some(stat.category_id))
                .count(),
        )
        .map_err(|_| RecordsStoreError::Validation("Too many expense months.".to_owned()))?;
    }
    transaction.commit().await?;
    Ok(ExpensesBoard {
        groups,
        categories,
        stats,
        last_actual_entry_date,
        monthly_totals,
        utility_property_ids,
    })
}

// The imported schedule is authoritative; materialized occurrences fill only missing months.
// An actual expense replaces the schedule for that loan category, month and owner scope.
pub(crate) async fn load_loan_expenses(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    allowed_scopes: &[String],
    category_id: Option<Uuid>,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
) -> Result<Vec<ExpenseEntryRecord>, sqlx::Error> {
    sqlx::query_as!(
        ExpenseEntryRecord,
        r#"WITH schedule AS (
            SELECT p.id, p.payment_date AS entry_date,
                   (COALESCE(p.total_payment, 0) + COALESCE(p.extra_payment, 0))::numeric AS amount,
                   l.owner_scope, c.id AS category_id, l.name AS description,
                   l.id AS loan_id
            FROM loan_payments p
            JOIN loans l ON l.household_id = p.household_id AND l.id = p.loan_id
            JOIN categories c ON c.household_id = l.household_id AND c.linked_loan_id = l.id
                AND c.kind = 'expense' AND c.parent_id IS NULL
            WHERE p.household_id = $1
            UNION ALL
            SELECT o.id, o.period, (COALESCE(o.override_amount, o.calculated_amount)
                   + COALESCE(op.amount, 0))::numeric,
                   l.owner_scope, c.id, l.name, l.id
            FROM planning_occurrences o
            JOIN planning_rules r ON r.household_id = o.household_id AND r.id = o.planning_rule_id
            JOIN loans l ON l.household_id = r.household_id AND l.id = r.linked_loan_id
            JOIN categories c ON c.household_id = l.household_id AND c.linked_loan_id = l.id
                AND c.kind = 'expense' AND c.parent_id IS NULL
            LEFT JOIN loan_overpayment_plans op ON op.household_id = l.household_id
                AND op.loan_id = l.id AND op.period = o.period
            WHERE o.household_id = $1 AND r.rule_kind = 'loan' AND r.enabled
              AND l.current_balance > 0
              AND (l.end_date IS NULL OR o.period <= date_trunc('month', l.end_date)::date)
              AND NOT EXISTS (
                  SELECT 1 FROM loan_payments p WHERE p.household_id = $1 AND p.loan_id = l.id
                    AND date_trunc('month', p.payment_date)::date = o.period
              )
        )
        SELECT s.id AS "id!", s.description AS "description!", s.amount AS "amount!: Decimal",
               s.entry_date AS "entry_date?", s.owner_scope AS "owner_scope!",
               ''::text AS "notes!", 'loan_schedule'::text AS "data_source!",
               s.category_id AS "category_id?", NULL::uuid AS subcategory_id,
               jsonb_build_object('linked_loan_id', s.loan_id, 'read_only', true) AS "extra_payload!: Value"
        FROM schedule s
        WHERE s.owner_scope = ANY($2) AND ($3::uuid IS NULL OR s.category_id = $3)
          AND ($4::date IS NULL OR s.entry_date >= $4)
          AND ($5::date IS NULL OR s.entry_date <= $5)
          AND NOT EXISTS (
              SELECT 1 FROM ledger_entries e
              WHERE e.household_id = $1 AND e.direction = 'expense' AND e.status = 'actual'
                AND (e.category_id = s.category_id OR e.subcategory_id = s.category_id)
                AND e.owner_scope = s.owner_scope
                AND date_trunc('month', e.entry_date) = date_trunc('month', s.entry_date)
          )
        ORDER BY s.entry_date DESC, s.id"#,
        household_id, allowed_scopes, category_id, start_date, end_date
    ).fetch_all(&mut **transaction).await
}

pub async fn create_group(
    pool: &PgPool,
    household_id: Uuid,
    input: ExpenseGroupInput,
) -> Result<ExpenseGroupRecord, RecordsStoreError> {
    let name = valid_name(&input.name, "Group name is required.")?;
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let record = sqlx::query_as!(
        ExpenseGroupRecord,
        r#"INSERT INTO expense_groups
            (household_id, name, normalized_name, color, notes, sort_order, is_retired, creation_origin)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, false), 'manual')
         ON CONFLICT (household_id, normalized_name) DO NOTHING
         RETURNING id, name, color, notes, sort_order, is_retired,
                    true AS "can_delete!", false AS "is_source_linked!""#,
        household_id,
        name,
        name.to_lowercase(),
        input.color.trim(),
        &input.notes,
        input.sort_order,
        input.is_retired
    )
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(|| {
        RecordsStoreError::Validation(format!("An expense group named \"{name}\" already exists."))
    })?;
    transaction.commit().await?;
    Ok(record)
}

pub async fn update_group(
    pool: &PgPool,
    household_id: Uuid,
    group_id: Uuid,
    input: ExpenseGroupInput,
) -> Result<ExpenseGroupRecord, RecordsStoreError> {
    let name = valid_name(&input.name, "Group name is required.")?;
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let conflict = sqlx::query_scalar!(
        r#"SELECT EXISTS(
            SELECT 1 FROM expense_groups
            WHERE household_id = $1 AND normalized_name = $2 AND id <> $3
         ) AS "exists!""#,
        household_id,
        name.to_lowercase(),
        group_id
    )
    .fetch_one(&mut *transaction)
    .await?;
    if conflict {
        return Err(RecordsStoreError::Validation(format!(
            "An expense group named \"{name}\" already exists."
        )));
    }
    let record = sqlx::query_as!(
        ExpenseGroupRecord,
        r#"UPDATE expense_groups
         SET name = $3, normalized_name = $4, color = $5, notes = $6,
             sort_order = $7, is_retired = COALESCE($8, is_retired), updated_at = now()
         WHERE household_id = $1 AND id = $2
         RETURNING id, name, color, notes, sort_order, is_retired,
                    app.expense_group_can_delete(household_id, id) AS "can_delete!",
                    EXISTS(SELECT 1 FROM properties p
                           WHERE p.household_id = expense_groups.household_id
                             AND p.id = expense_groups.linked_property_id
                             AND p.category IN ('property', 'vehicle')) AS "is_source_linked!""#,
        household_id,
        group_id,
        name,
        name.to_lowercase(),
        input.color.trim(),
        &input.notes,
        input.sort_order,
        input.is_retired
    )
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(RecordsStoreError::NotFound)?;
    transaction.commit().await?;
    Ok(record)
}

pub async fn delete_group(
    pool: &PgPool,
    household_id: Uuid,
    group_id: Uuid,
) -> Result<(), RecordsStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let can_delete = sqlx::query_scalar!(
        r#"SELECT app.expense_group_can_delete(household_id, id) AS "can_delete!"
           FROM expense_groups WHERE household_id = $1 AND id = $2"#,
        household_id,
        group_id
    )
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(RecordsStoreError::NotFound)?;
    if !can_delete {
        return Err(RecordsStoreError::Validation(
            "Automatically created or source-referenced expenses cannot be deleted; retire them instead.".to_owned(),
        ));
    }
    // Member categories fall back to ungrouped via ON DELETE SET NULL.
    let result = sqlx::query!(
        "DELETE FROM expense_groups WHERE household_id = $1 AND id = $2",
        household_id,
        group_id
    )
    .execute(&mut *transaction)
    .await?;
    if result.rows_affected() == 0 {
        return Err(RecordsStoreError::NotFound);
    }
    transaction.commit().await?;
    Ok(())
}

pub async fn create_category(
    pool: &PgPool,
    household_id: Uuid,
    input: ExpenseCategoryInput,
) -> Result<ExpenseCategoryRecord, RecordsStoreError> {
    let name = valid_name(&input.name, "Expense name is required.")?;
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    if let Some(group_id) = input.expense_group_id {
        ensure_group_exists(&mut transaction, household_id, group_id).await?;
    }
    let record = sqlx::query_as!(
        ExpenseCategoryRecord,
        r#"INSERT INTO categories
            (household_id, kind, name, normalized_name, expense_group_id, sort_order, is_retired, creation_origin)
         VALUES ($1, 'expense', $2, $3, $4, $5, COALESCE($6, false), 'manual')
         ON CONFLICT (household_id, kind, normalized_name) WHERE parent_id IS NULL
         DO NOTHING
         RETURNING id, name, parent_id, expense_group_id, is_system, sort_order, is_retired,
                    true AS "can_delete!", false AS "is_source_linked!""#,
        household_id,
        name,
        name.to_lowercase(),
        input.expense_group_id,
        input.sort_order,
        input.is_retired
    )
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(|| {
        RecordsStoreError::Validation(format!("An expense named \"{name}\" already exists."))
    })?;
    transaction.commit().await?;
    Ok(record)
}

pub async fn update_category(
    pool: &PgPool,
    household_id: Uuid,
    category_id: Uuid,
    input: ExpenseCategoryInput,
) -> Result<ExpenseCategoryRecord, RecordsStoreError> {
    let name = valid_name(&input.name, "Expense name is required.")?;
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    if let Some(group_id) = input.expense_group_id {
        ensure_group_exists(&mut transaction, household_id, group_id).await?;
    }
    let conflict = sqlx::query_scalar!(
        r#"SELECT EXISTS(
            SELECT 1 FROM categories
            WHERE household_id = $1 AND kind = 'expense' AND parent_id IS NULL
              AND normalized_name = $2 AND id <> $3
         ) AS "exists!""#,
        household_id,
        name.to_lowercase(),
        category_id
    )
    .fetch_one(&mut *transaction)
    .await?;
    if conflict {
        return Err(RecordsStoreError::Validation(format!(
            "An expense named \"{name}\" already exists."
        )));
    }
    let record = sqlx::query_as!(
        ExpenseCategoryRecord,
        r#"UPDATE categories
         SET name = $3, normalized_name = $4, expense_group_id = $5,
             sort_order = $6, is_retired = COALESCE($7, is_retired), updated_at = now()
         WHERE household_id = $1 AND id = $2
           AND kind = 'expense' AND parent_id IS NULL
         RETURNING id, name, parent_id, expense_group_id, is_system, sort_order, is_retired,
                    app.expense_category_can_delete(household_id, id) AS "can_delete!",
                    linked_loan_id IS NOT NULL AS "is_source_linked!""#,
        household_id,
        category_id,
        name,
        name.to_lowercase(),
        input.expense_group_id,
        input.sort_order,
        input.is_retired
    )
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(RecordsStoreError::NotFound)?;
    transaction.commit().await?;
    Ok(record)
}

pub async fn delete_category(
    pool: &PgPool,
    household_id: Uuid,
    category_id: Uuid,
) -> Result<(), RecordsStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let can_delete = sqlx::query_scalar!(
        r#"SELECT app.expense_category_can_delete(household_id, id) AS "can_delete!"
           FROM categories WHERE household_id = $1 AND id = $2 AND kind = 'expense' AND parent_id IS NULL"#,
        household_id,
        category_id
    )
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(RecordsStoreError::NotFound)?;
    if !can_delete {
        return Err(RecordsStoreError::Validation(
            "Automatically created or source-referenced expenses cannot be deleted; retire them instead.".to_owned(),
        ));
    }
    // Ledger entries keep their history and fall back to uncategorized
    // (ON DELETE SET NULL); subcategories cascade with the parent.
    let result = sqlx::query!(
        "DELETE FROM categories
         WHERE household_id = $1 AND id = $2
           AND kind = 'expense' AND parent_id IS NULL",
        household_id,
        category_id
    )
    .execute(&mut *transaction)
    .await?;
    if result.rows_affected() == 0 {
        return Err(RecordsStoreError::NotFound);
    }
    transaction.commit().await?;
    Ok(())
}

async fn load_property_utility_months(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    allowed_scopes: &[String],
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
) -> Result<Vec<PropertyUtilityMonthRow>, RecordsStoreError> {
    Ok(sqlx::query_as!(
        PropertyUtilityMonthRow,
        r#"SELECT p.id AS "property_id!", g.id AS "expense_group_id!", g.is_retired AS "is_retired!",
                  date_trunc('month', b.charge_date)::date AS "period?",
                  coalesce(sum(b.amount), 0)::numeric AS "amount!: Decimal",
                  count(b.id) AS "entry_count!",
                  min(b.charge_date) AS "first_entry_date?",
                  max(b.charge_date) AS "last_entry_date?"
           FROM properties p
           JOIN expense_groups g
             ON g.household_id = p.household_id AND g.linked_property_id = p.id
           LEFT JOIN utility_bills b
             ON b.household_id = p.household_id AND b.property_id = p.id
            AND b.owner_scope = ANY($2)
            AND ($3::date IS NULL OR b.charge_date >= $3)
            AND ($4::date IS NULL OR b.charge_date <= $4)
           WHERE p.household_id = $1 AND p.category = 'property'
             AND p.utilities_enabled AND p.expenses_enabled
           GROUP BY p.id, g.id, g.is_retired, date_trunc('month', b.charge_date)::date
           ORDER BY p.id, 4"#,
        household_id,
        allowed_scopes,
        start_date,
        end_date
    )
    .fetch_all(&mut **transaction)
    .await?)
}

async fn load_property_utility_detail(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    property_id: Uuid,
    allowed_scopes: &[String],
) -> Result<ExpenseCategoryDetail, RecordsStoreError> {
    let rows = load_property_utility_months(transaction, household_id, allowed_scopes, None, None)
        .await?
        .into_iter()
        .filter(|row| row.property_id == property_id)
        .collect();
    let mut categories = Vec::new();
    let mut stats = Vec::new();
    let mut monthly_totals = Vec::new();
    project_property_utilities(rows, &mut categories, &mut stats, &mut monthly_totals);
    let category = categories.pop().ok_or(RecordsStoreError::NotFound)?;
    let entries = sqlx::query_as!(
        ExpenseEntryRecord,
        r#"SELECT id, description, amount, charge_date AS "entry_date?", owner_scope, notes,
                  'utility_bill'::text AS "data_source!", property_id AS category_id,
                  NULL::uuid AS subcategory_id,
                  jsonb_build_object('linked_property_id', property_id, 'read_only', true)
                      AS "extra_payload!: Value"
           FROM utility_bills
           WHERE household_id = $1 AND property_id = $2 AND owner_scope = ANY($3)
           ORDER BY charge_date DESC, id"#,
        household_id,
        property_id,
        allowed_scopes
    )
    .fetch_all(&mut **transaction)
    .await?;
    Ok(ExpenseCategoryDetail {
        category,
        subcategories: Vec::new(),
        monthly_totals: monthly_totals
            .into_iter()
            .map(|row| ExpenseMonthlyTotalRow {
                period: row.period,
                amount: row.amount,
            })
            .collect(),
        entries,
    })
}

pub async fn load_category_detail(
    pool: &PgPool,
    household_id: Uuid,
    category_id: Uuid,
    allowed_scopes: &[String],
) -> Result<ExpenseCategoryDetail, RecordsStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let category = sqlx::query_as!(
        ExpenseCategoryRecord,
        r#"SELECT id, name, parent_id, expense_group_id, is_system, sort_order, is_retired,
                 app.expense_category_can_delete(household_id, id) AS "can_delete!",
                 linked_loan_id IS NOT NULL AS "is_source_linked!"
         FROM categories
         WHERE household_id = $1 AND id = $2
           AND kind = 'expense' AND parent_id IS NULL"#,
        household_id,
        category_id
    )
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(category) = category else {
        let detail = load_property_utility_detail(
            &mut transaction,
            household_id,
            category_id,
            allowed_scopes,
        )
        .await?;
        transaction.commit().await?;
        return Ok(detail);
    };
    let subcategories = sqlx::query_as!(
        ExpenseCategoryRecord,
        r#"SELECT id, name, parent_id, expense_group_id, is_system, sort_order, is_retired,
                 app.expense_category_can_delete(household_id, id) AS "can_delete!",
                 linked_loan_id IS NOT NULL AS "is_source_linked!"
         FROM categories
         WHERE household_id = $1 AND parent_id = $2
         ORDER BY sort_order, name"#,
        household_id,
        category_id
    )
    .fetch_all(&mut *transaction)
    .await?;
    let monthly_totals = sqlx::query_as!(
        ExpenseMonthlyTotalRow,
        r#"SELECT date_trunc('month', e.entry_date)::date AS "period!",
                sum(e.amount)::numeric AS "amount!: Decimal"
         FROM ledger_entries e
         WHERE e.household_id = $1 AND e.direction = 'expense'
           AND e.status = 'actual' AND e.entry_date IS NOT NULL
           AND (e.category_id = $2 OR e.subcategory_id = $2)
           AND e.owner_scope = ANY($3)
         GROUP BY 1 ORDER BY 1"#,
        household_id,
        category_id,
        allowed_scopes
    )
    .fetch_all(&mut *transaction)
    .await?;
    let mut entries = sqlx::query_as!(
        ExpenseEntryRecord,
        r#"SELECT id, description, amount, entry_date, owner_scope, notes,
                data_source, category_id, subcategory_id,
                extra_payload AS "extra_payload!: Value"
         FROM ledger_entries
         WHERE household_id = $1 AND direction = 'expense' AND status = 'actual'
           AND (category_id = $2 OR subcategory_id = $2)
           AND owner_scope = ANY($3)
         ORDER BY entry_date DESC NULLS LAST, created_at DESC
         LIMIT $4"#,
        household_id,
        category_id,
        allowed_scopes,
        DETAIL_ENTRY_LIMIT
    )
    .fetch_all(&mut *transaction)
    .await?;
    let loan_entries = load_loan_expenses(
        &mut transaction,
        household_id,
        allowed_scopes,
        Some(category_id),
        None,
        None,
    )
    .await?;
    let mut by_month: BTreeMap<_, _> = monthly_totals
        .into_iter()
        .map(|row| (row.period, row.amount))
        .collect();
    for entry in &loan_entries {
        if let Some(date) = entry.entry_date {
            let period = checkbook_domain::month_start(date)
                .map_err(|error| RecordsStoreError::Validation(error.to_string()))?;
            *by_month.entry(period).or_insert(Decimal::ZERO) += entry.amount;
        }
    }
    let monthly_totals = by_month
        .into_iter()
        .map(|(period, amount)| ExpenseMonthlyTotalRow { period, amount })
        .collect();
    entries.extend(loan_entries);
    entries.sort_by(|left, right| {
        right
            .entry_date
            .cmp(&left.entry_date)
            .then(left.id.cmp(&right.id))
    });
    transaction.commit().await?;
    Ok(ExpenseCategoryDetail {
        category,
        subcategories,
        monthly_totals,
        entries,
    })
}

pub async fn update_expense_entry(
    pool: &PgPool,
    household_id: Uuid,
    entry_id: Uuid,
    input: ExpenseEntryUpdateInput,
) -> Result<(), RecordsStoreError> {
    if !input
        .allowed_scopes
        .iter()
        .any(|allowed| allowed == &input.owner_scope)
    {
        return Err(RecordsStoreError::Forbidden);
    }
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let existing_scope = sqlx::query!(
        "SELECT owner_scope FROM ledger_entries
         WHERE household_id = $1 AND id = $2
           AND direction = 'expense' AND status = 'actual'",
        household_id,
        entry_id
    )
    .fetch_optional(&mut *transaction)
    .await?
    .map(|row| row.owner_scope)
    .ok_or(RecordsStoreError::NotFound)?;
    if !input
        .allowed_scopes
        .iter()
        .any(|allowed| allowed == &existing_scope)
    {
        return Err(RecordsStoreError::Forbidden);
    }
    if let Some(category_id) = input.category_id {
        ensure_root_expense_category(&mut transaction, household_id, category_id).await?;
    }
    match (input.subcategory_id, input.category_id) {
        (Some(subcategory_id), Some(category_id)) => {
            let valid = sqlx::query_scalar!(
                r#"SELECT EXISTS(
                    SELECT 1 FROM categories
                    WHERE household_id = $1 AND id = $2
                      AND kind = 'expense' AND parent_id = $3
                 ) AS "exists!""#,
                household_id,
                subcategory_id,
                category_id
            )
            .fetch_one(&mut *transaction)
            .await?;
            if !valid {
                return Err(RecordsStoreError::Validation(
                    "Subcategory does not belong to the selected expense.".to_owned(),
                ));
            }
        }
        (Some(_), None) => {
            return Err(RecordsStoreError::Validation(
                "A subcategory requires a parent expense.".to_owned(),
            ));
        }
        (None, _) => {}
    }
    let result = sqlx::query!(
        "UPDATE ledger_entries
         SET amount = $3, entry_date = $4, description = $5, notes = $6,
             owner_scope = $7, category_id = $8, subcategory_id = $9,
             updated_at = now()
         WHERE household_id = $1 AND id = $2
           AND direction = 'expense' AND status = 'actual'",
        household_id,
        entry_id,
        input.amount,
        input.entry_date,
        input.description.trim(),
        &input.notes,
        &input.owner_scope,
        input.category_id,
        input.subcategory_id
    )
    .execute(&mut *transaction)
    .await?;
    if result.rows_affected() == 0 {
        return Err(RecordsStoreError::NotFound);
    }
    transaction.commit().await?;
    Ok(())
}

pub async fn delete_expense_entry(
    pool: &PgPool,
    household_id: Uuid,
    entry_id: Uuid,
    allowed_scopes: &[String],
) -> Result<(), RecordsStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let existing_scope = sqlx::query!(
        "SELECT owner_scope FROM ledger_entries
         WHERE household_id = $1 AND id = $2
           AND direction = 'expense' AND status = 'actual'",
        household_id,
        entry_id
    )
    .fetch_optional(&mut *transaction)
    .await?
    .map(|row| row.owner_scope)
    .ok_or(RecordsStoreError::NotFound)?;
    if !allowed_scopes
        .iter()
        .any(|allowed| allowed == &existing_scope)
    {
        return Err(RecordsStoreError::Forbidden);
    }
    sqlx::query!(
        "DELETE FROM ledger_entries
         WHERE household_id = $1 AND id = $2
           AND direction = 'expense' AND status = 'actual'",
        household_id,
        entry_id
    )
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

async fn list_groups(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
) -> Result<Vec<ExpenseGroupRecord>, sqlx::Error> {
    sqlx::query_as!(
        ExpenseGroupRecord,
        r#"SELECT id, name, color, notes, sort_order, is_retired,
                 app.expense_group_can_delete(household_id, id) AS "can_delete!",
                 EXISTS(SELECT 1 FROM properties p
                        WHERE p.household_id = expense_groups.household_id
                          AND p.id = expense_groups.linked_property_id
                          AND p.category IN ('property', 'vehicle')) AS "is_source_linked!"
         FROM expense_groups
         WHERE household_id = $1
         ORDER BY sort_order, name"#,
        household_id
    )
    .fetch_all(&mut **transaction)
    .await
}

async fn ensure_root_expense_category(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    category_id: Uuid,
) -> Result<(), RecordsStoreError> {
    let exists = sqlx::query_scalar!(
        r#"SELECT EXISTS(
            SELECT 1 FROM categories
            WHERE household_id = $1 AND id = $2
              AND kind = 'expense' AND parent_id IS NULL
         ) AS "exists!""#,
        household_id,
        category_id
    )
    .fetch_one(&mut **transaction)
    .await?;
    if exists {
        Ok(())
    } else {
        Err(RecordsStoreError::NotFound)
    }
}

async fn ensure_group_exists(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    group_id: Uuid,
) -> Result<(), RecordsStoreError> {
    let exists = sqlx::query_scalar!(
        r#"SELECT EXISTS(
            SELECT 1 FROM expense_groups WHERE household_id = $1 AND id = $2
         ) AS "exists!""#,
        household_id,
        group_id
    )
    .fetch_one(&mut **transaction)
    .await?;
    if exists {
        Ok(())
    } else {
        Err(RecordsStoreError::NotFound)
    }
}

fn valid_name<'a>(name: &'a str, message: &str) -> Result<&'a str, RecordsStoreError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(RecordsStoreError::Validation(message.to_owned()));
    }
    Ok(name)
}
