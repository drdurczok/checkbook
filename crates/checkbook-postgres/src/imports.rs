use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::tenant;

const RAW_DATA_LIMIT: i64 = 250;

const ASSET_PROJECT_COLUMNS: &[(&str, &str)] = &[
    ("name", "Name"),
    ("total_cost", "Total cost"),
    ("valuation_date", "Valuation date"),
    ("data_source", "Source"),
    ("created_at", "Added"),
    ("updated_at", "Last updated"),
];
const ASSET_COLUMNS: &[(&str, &str)] = &[
    ("name", "Name"),
    ("asset_type", "Type"),
    ("balance", "Balance"),
    ("valuation_date", "Valuation date"),
    ("data_source", "Source"),
    ("created_at", "Added"),
    ("updated_at", "Last updated"),
];
const LIABILITY_COLUMNS: &[(&str, &str)] = &[
    ("name", "Name"),
    ("liability_type", "Type"),
    ("balance", "Balance"),
    ("as_of_date", "As of"),
    ("data_source", "Source"),
    ("created_at", "Added"),
    ("updated_at", "Last updated"),
];
const ENTRY_COLUMNS: &[(&str, &str)] = &[
    ("description", "Description"),
    ("amount", "Amount"),
    ("entry_date", "Date"),
    ("data_source", "Source"),
    ("created_at", "Added"),
    ("updated_at", "Last updated"),
];
const UTILITY_COLUMNS: &[(&str, &str)] = &[
    ("provider", "Provider"),
    ("description", "Description"),
    ("amount", "Amount"),
    ("charge_date", "Date"),
    ("is_recurring", "Recurring"),
    ("data_source", "Source"),
    ("created_at", "Added"),
    ("updated_at", "Last updated"),
];
const LOAN_COLUMNS: &[(&str, &str)] = &[
    ("name", "Name"),
    ("liability_type", "Type"),
    ("current_balance", "Current balance"),
    ("original_balance", "Original balance"),
    ("monthly_payment", "Monthly payment"),
    ("interest_rate", "Interest rate"),
    ("start_date", "Start date"),
    ("end_date", "End date"),
    ("data_source", "Source"),
    ("created_at", "Added"),
    ("updated_at", "Last updated"),
];

#[derive(Debug, Clone)]
pub struct DataLoadHistoryRecord {
    pub id: Uuid,
    pub status: String,
    pub counts: Value,
    pub warnings: Value,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct RawDataColumnRecord {
    pub key: String,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct RawDataTableRecord {
    pub key: String,
    pub label: String,
    pub count: i64,
    pub columns: Vec<RawDataColumnRecord>,
    pub rows: Vec<Value>,
}

pub async fn data_load_history(
    pool: &PgPool,
    household_id: Uuid,
) -> Result<Vec<DataLoadHistoryRecord>, sqlx::Error> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let rows = sqlx::query_as!(
        DataLoadHistoryRecord,
        r#"SELECT id, status, counts AS "counts!: Value", warnings AS "warnings!: Value", created_at AS started_at,
                committed_at AS finished_at
         FROM data_load_runs
         WHERE household_id = $1
           AND status <> 'deleted'
         ORDER BY created_at DESC"#,
        household_id
    )
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(rows)
}

pub async fn last_successful_data_load(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
) -> Result<Option<DataLoadHistoryRecord>, sqlx::Error> {
    sqlx::query_as!(
        DataLoadHistoryRecord,
        r#"SELECT id, status, counts AS "counts!: Value", warnings AS "warnings!: Value", created_at AS started_at,
                committed_at AS finished_at
         FROM data_load_runs
         WHERE household_id = $1 AND status = 'committed'
         ORDER BY committed_at DESC NULLS LAST LIMIT 1"#,
        household_id
    )
    .fetch_optional(&mut **transaction)
    .await
}

pub async fn raw_data(
    pool: &PgPool,
    household_id: Uuid,
) -> Result<Vec<RawDataTableRecord>, sqlx::Error> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let asset_project_count = sqlx::query!(
        r#"SELECT count(*) AS "count!"
           FROM (
              SELECT household_id FROM properties
              UNION ALL
              SELECT household_id FROM projects
           ) asset_projects
           WHERE household_id = $1"#,
        household_id
    )
    .fetch_one(&mut *transaction)
    .await?
    .count;
    let asset_project_rows = sqlx::query!(
        r#"SELECT jsonb_build_object(
                'name', asset_project.name,
                'total_cost', asset_project.total_cost::text,
                'valuation_date', asset_project.valuation_date,
                'data_source', asset_project.data_source,
                'created_at', asset_project.created_at,
                'updated_at', asset_project.updated_at) AS "row!: Value"
           FROM (
              SELECT name, valuation AS total_cost, valuation_date, data_source,
                     created_at, updated_at
              FROM properties WHERE household_id = $1
              UNION ALL
              SELECT name, budget AS total_cost, valuation_date, data_source,
                     created_at, updated_at
              FROM projects WHERE household_id = $1
           ) asset_project
           ORDER BY created_at DESC
           LIMIT $2"#,
        household_id,
        RAW_DATA_LIMIT
    )
    .fetch_all(&mut *transaction)
    .await?
    .into_iter()
    .map(|row| row.row)
    .collect();

    let asset_count = sqlx::query!(
        r#"SELECT count(*) AS "count!"
           FROM account_balance_snapshots snapshot
           JOIN financial_accounts account
             ON account.household_id = snapshot.household_id
            AND account.id = snapshot.account_id
           WHERE snapshot.household_id = $1 AND account.account_kind = 'asset'"#,
        household_id
    )
    .fetch_one(&mut *transaction)
    .await?
    .count;
    let asset_rows = sqlx::query!(
        r#"SELECT jsonb_build_object(
                'name', account.name,
                'asset_type', account.account_type,
                'balance', snapshot.balance::text,
                'valuation_date', snapshot.effective_date,
                'data_source', snapshot.data_source,
                'created_at', snapshot.created_at,
                'updated_at', snapshot.updated_at) AS "row!: Value"
           FROM account_balance_snapshots snapshot
           JOIN financial_accounts account
             ON account.household_id = snapshot.household_id
            AND account.id = snapshot.account_id
           WHERE snapshot.household_id = $1 AND account.account_kind = 'asset'
           ORDER BY snapshot.created_at DESC
           LIMIT $2"#,
        household_id,
        RAW_DATA_LIMIT
    )
    .fetch_all(&mut *transaction)
    .await?
    .into_iter()
    .map(|row| row.row)
    .collect();

    let liability_count = sqlx::query!(
        r#"SELECT count(*) AS "count!"
           FROM account_balance_snapshots snapshot
           JOIN financial_accounts account
             ON account.household_id = snapshot.household_id
            AND account.id = snapshot.account_id
           WHERE snapshot.household_id = $1 AND account.account_kind = 'liability'"#,
        household_id
    )
    .fetch_one(&mut *transaction)
    .await?
    .count;
    let liability_rows = sqlx::query!(
        r#"SELECT jsonb_build_object(
                'name', account.name,
                'liability_type', account.account_type,
                'balance', snapshot.balance::text,
                'as_of_date', snapshot.effective_date,
                'data_source', snapshot.data_source,
                'created_at', snapshot.created_at,
                'updated_at', snapshot.updated_at) AS "row!: Value"
           FROM account_balance_snapshots snapshot
           JOIN financial_accounts account
             ON account.household_id = snapshot.household_id
            AND account.id = snapshot.account_id
           WHERE snapshot.household_id = $1 AND account.account_kind = 'liability'
           ORDER BY snapshot.created_at DESC
           LIMIT $2"#,
        household_id,
        RAW_DATA_LIMIT
    )
    .fetch_all(&mut *transaction)
    .await?
    .into_iter()
    .map(|row| row.row)
    .collect();

    let income_count = sqlx::query!(
        r#"SELECT count(*) AS "count!"
           FROM ledger_entries
           WHERE household_id = $1 AND direction = 'income'"#,
        household_id
    )
    .fetch_one(&mut *transaction)
    .await?
    .count;
    let income_rows = sqlx::query!(
        r#"SELECT jsonb_build_object(
                'description', description,
                'amount', amount::text,
                'entry_date', entry_date,
                'data_source', data_source,
                'created_at', created_at,
                'updated_at', updated_at) AS "row!: Value"
           FROM ledger_entries
           WHERE household_id = $1 AND direction = 'income'
           ORDER BY created_at DESC
           LIMIT $2"#,
        household_id,
        RAW_DATA_LIMIT
    )
    .fetch_all(&mut *transaction)
    .await?
    .into_iter()
    .map(|row| row.row)
    .collect();

    let expense_count = sqlx::query!(
        r#"SELECT count(*) AS "count!"
           FROM ledger_entries
           WHERE household_id = $1 AND direction = 'expense'"#,
        household_id
    )
    .fetch_one(&mut *transaction)
    .await?
    .count;
    let expense_rows = sqlx::query!(
        r#"SELECT jsonb_build_object(
                'description', description,
                'amount', amount::text,
                'entry_date', entry_date,
                'data_source', data_source,
                'created_at', created_at,
                'updated_at', updated_at) AS "row!: Value"
           FROM ledger_entries
           WHERE household_id = $1 AND direction = 'expense'
           ORDER BY created_at DESC
           LIMIT $2"#,
        household_id,
        RAW_DATA_LIMIT
    )
    .fetch_all(&mut *transaction)
    .await?
    .into_iter()
    .map(|row| row.row)
    .collect();

    let utility_count = sqlx::query!(
        r#"SELECT count(*) AS "count!"
           FROM utility_bills
           WHERE household_id = $1"#,
        household_id
    )
    .fetch_one(&mut *transaction)
    .await?
    .count;
    let utility_rows = sqlx::query!(
        r#"SELECT jsonb_build_object(
                'provider', provider,
                'description', description,
                'amount', amount::text,
                'charge_date', charge_date,
                'is_recurring', is_recurring,
                'data_source', data_source,
                'created_at', created_at,
                'updated_at', updated_at) AS "row!: Value"
           FROM utility_bills
           WHERE household_id = $1
           ORDER BY created_at DESC
           LIMIT $2"#,
        household_id,
        RAW_DATA_LIMIT
    )
    .fetch_all(&mut *transaction)
    .await?
    .into_iter()
    .map(|row| row.row)
    .collect();

    let loan_count = sqlx::query!(
        r#"SELECT count(*) AS "count!"
           FROM loans
           WHERE household_id = $1"#,
        household_id
    )
    .fetch_one(&mut *transaction)
    .await?
    .count;
    let loan_rows = sqlx::query!(
        r#"SELECT jsonb_build_object(
                'name', name,
                'liability_type', liability_type,
                'current_balance', current_balance::text,
                'original_balance', original_balance::text,
                'monthly_payment', monthly_payment::text,
                'interest_rate', interest_rate::text,
                'start_date', start_date,
                'end_date', end_date,
                'data_source', data_source,
                'created_at', created_at,
                'updated_at', updated_at) AS "row!: Value"
           FROM loans
           WHERE household_id = $1
           ORDER BY created_at DESC
           LIMIT $2"#,
        household_id,
        RAW_DATA_LIMIT
    )
    .fetch_all(&mut *transaction)
    .await?
    .into_iter()
    .map(|row| row.row)
    .collect();

    let tables = vec![
        raw_table(
            "asset_projects",
            "Asset projects",
            ASSET_PROJECT_COLUMNS,
            asset_project_count,
            asset_project_rows,
        ),
        raw_table(
            "wealth_assets",
            "Wealth assets",
            ASSET_COLUMNS,
            asset_count,
            asset_rows,
        ),
        raw_table(
            "liabilities",
            "Liabilities",
            LIABILITY_COLUMNS,
            liability_count,
            liability_rows,
        ),
        raw_table("income", "Income", ENTRY_COLUMNS, income_count, income_rows),
        raw_table(
            "expenses",
            "Expenses",
            ENTRY_COLUMNS,
            expense_count,
            expense_rows,
        ),
        raw_table(
            "utilities",
            "Utilities",
            UTILITY_COLUMNS,
            utility_count,
            utility_rows,
        ),
        raw_table("loans", "Loans", LOAN_COLUMNS, loan_count, loan_rows),
    ];
    transaction.commit().await?;
    Ok(tables)
}

fn raw_table(
    key: &str,
    label: &str,
    columns: &[(&str, &str)],
    count: i64,
    rows: Vec<Value>,
) -> RawDataTableRecord {
    RawDataTableRecord {
        key: key.to_owned(),
        label: label.to_owned(),
        count,
        columns: columns
            .iter()
            .map(|(key, label)| RawDataColumnRecord {
                key: (*key).to_owned(),
                label: (*label).to_owned(),
            })
            .collect(),
        rows,
    }
}
