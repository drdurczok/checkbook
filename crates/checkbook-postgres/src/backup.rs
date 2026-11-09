use std::collections::{BTreeMap, BTreeSet};

use checkbook_domain::{InvoiceLine, calculate_invoice, month_start_at};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::planning::materialize_household_in_transaction;
use crate::tenant;
#[path = "backup_utility_contracts.rs"]
mod utility_contract_upgrade;
use utility_contract_upgrade::upgrade_utility_contracts;

pub const BACKUP_FORMAT_VERSION: u32 = 2;
pub const BACKUP_SCHEMA_VERSION: i64 = 17;
const PRE_UTILITY_CONTRACT_BACKUP_SCHEMA_VERSION: i64 = 16;
const PRE_UTILITY_ORDER_BACKUP_SCHEMA_VERSION: i64 = 15;
const PRE_UTILITY_LIFECYCLE_BACKUP_SCHEMA_VERSION: i64 = 14;
const PRE_UTILITY_COMPLETION_BACKUP_SCHEMA_VERSION: i64 = 13;
const PRE_HOLDING_PRICES_BACKUP_SCHEMA_VERSION: i64 = 12;
const PRE_UTILITY_PRICING_BACKUP_SCHEMA_VERSION: i64 = 11;
const PRE_ACCOUNT_ASSETS_BACKUP_SCHEMA_VERSION: i64 = 10;
const PAYDAY_BACKUP_SCHEMA_VERSION: i64 = 9;
const RECURRING_BACKUP_SCHEMA_VERSION: i64 = 8;
const NET_WORTH_BACKUP_SCHEMA_VERSION: i64 = 7;
const PREVIOUS_BACKUP_SCHEMA_VERSION: i64 = 4;
const SOURCE_LINK_BACKUP_SCHEMA_VERSION: i64 = 5;
const RETIREMENT_BACKUP_SCHEMA_VERSION: i64 = 6;

pub const BACKUP_TABLES: &[&str] = &[
    "household_settings",
    "role_permissions",
    "expense_groups",
    "categories",
    "entry_groups",
    "income_sources",
    "income_source_lines",
    "income_source_custom_fields",
    "income_source_milestones",
    "financial_accounts",
    "account_balance_snapshots",
    "net_worth_months",
    "net_worth_month_components",
    "properties",
    "property_categories",
    "account_holdings",
    "holding_price_cache",
    "projects",
    "project_rooms",
    "project_sections",
    "project_items",
    "utility_services",
    "utility_contracts",
    "utility_contract_prices",
    "utility_contract_import_sources",
    "utility_subject_services",
    "utility_months",
    "utility_bills",
    "utility_meter_readings",
    "loans",
    "loan_payments",
    "loan_overpayment_plans",
    "planning_rules",
    "planning_occurrences",
    "ledger_entries",
    "recurring_expenses",
    "payday_templates",
    "payday_months",
    "payday_allocations",
    "recurring_commitments",
    "goals",
    "scenarios",
    "scenario_category_overrides",
    "buyers",
    "invoice_templates",
    "invoice_template_lines",
    "invoices",
    "invoice_revisions",
    "invoice_lines",
    "audit_events",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HouseholdSnapshot {
    pub format_version: u32,
    pub schema_version: i64,
    pub household_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub tables: BTreeMap<String, Value>,
}

#[derive(Debug, thiserror::Error)]
pub enum BackupStoreError {
    #[error("backup validation failed: {0}")]
    Validation(String),
    #[error("database error")]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Clone, Copy)]
struct ReferenceRule {
    child_table: &'static str,
    field: &'static str,
    parent_table: &'static str,
    nullable: bool,
}

const REFERENCES: &[ReferenceRule] = &[
    ReferenceRule::new("expense_groups", "linked_property_id", "properties", true),
    ReferenceRule::new("categories", "linked_loan_id", "loans", true),
    ReferenceRule::new("categories", "linked_project_id", "projects", true),
    ReferenceRule::new("categories", "parent_id", "categories", true),
    ReferenceRule::new("categories", "expense_group_id", "expense_groups", true),
    ReferenceRule::new("property_categories", "property_id", "properties", false),
    ReferenceRule::new("property_categories", "category_id", "categories", false),
    ReferenceRule::new("account_holdings", "property_id", "properties", false),
    ReferenceRule::new(
        "income_source_lines",
        "income_source_id",
        "income_sources",
        false,
    ),
    ReferenceRule::new(
        "income_source_custom_fields",
        "income_source_id",
        "income_sources",
        true,
    ),
    ReferenceRule::new(
        "income_source_custom_fields",
        "income_source_line_id",
        "income_source_lines",
        true,
    ),
    ReferenceRule::new(
        "income_source_milestones",
        "income_source_id",
        "income_sources",
        false,
    ),
    ReferenceRule::new(
        "account_balance_snapshots",
        "account_id",
        "financial_accounts",
        false,
    ),
    ReferenceRule::new("projects", "linked_property_id", "properties", true),
    ReferenceRule::new("project_rooms", "project_id", "projects", true),
    ReferenceRule::new("project_rooms", "property_id", "properties", true),
    ReferenceRule::new("project_sections", "room_id", "project_rooms", false),
    ReferenceRule::new("project_items", "section_id", "project_sections", false),
    ReferenceRule::new(
        "utility_subject_services",
        "property_id",
        "properties",
        true,
    ),
    ReferenceRule::new(
        "utility_subject_services",
        "contract_id",
        "entry_groups",
        true,
    ),
    ReferenceRule::new(
        "utility_subject_services",
        "service_id",
        "utility_services",
        false,
    ),
    ReferenceRule::new("utility_months", "property_id", "properties", true),
    ReferenceRule::new("utility_months", "contract_id", "entry_groups", true),
    ReferenceRule::new(
        "utility_contract_import_sources",
        "property_id",
        "properties",
        false,
    ),
    ReferenceRule::new(
        "utility_contract_import_sources",
        "utility_contract_id",
        "utility_contracts",
        false,
    ),
    ReferenceRule::new("utility_contracts", "property_id", "properties", false),
    ReferenceRule::new("utility_contracts", "service_id", "utility_services", false),
    ReferenceRule::new(
        "utility_contract_prices",
        "utility_contract_id",
        "utility_contracts",
        false,
    ),
    ReferenceRule::new(
        "utility_bills",
        "utility_contract_id",
        "utility_contracts",
        true,
    ),
    ReferenceRule::new("utility_bills", "property_id", "properties", true),
    ReferenceRule::new("utility_bills", "contract_id", "entry_groups", true),
    ReferenceRule::new("utility_bills", "service_id", "utility_services", false),
    ReferenceRule::new(
        "utility_meter_readings",
        "utility_bill_id",
        "utility_bills",
        false,
    ),
    ReferenceRule::new(
        "utility_meter_readings",
        "previous_reading_id",
        "utility_meter_readings",
        true,
    ),
    ReferenceRule::new("loans", "account_id", "financial_accounts", false),
    ReferenceRule::new("loan_payments", "loan_id", "loans", false),
    ReferenceRule::new("loan_overpayment_plans", "loan_id", "loans", false),
    ReferenceRule::new("planning_rules", "category_id", "categories", true),
    ReferenceRule::new("planning_rules", "income_source_id", "income_sources", true),
    ReferenceRule::new("planning_rules", "linked_loan_id", "loans", true),
    ReferenceRule::new(
        "planning_occurrences",
        "planning_rule_id",
        "planning_rules",
        false,
    ),
    ReferenceRule::new("ledger_entries", "category_id", "categories", true),
    ReferenceRule::new("ledger_entries", "subcategory_id", "categories", true),
    ReferenceRule::new("ledger_entries", "income_source_id", "income_sources", true),
    ReferenceRule::new(
        "ledger_entries",
        "planning_occurrence_id",
        "planning_occurrences",
        true,
    ),
    ReferenceRule::new("ledger_entries", "linked_project_id", "projects", true),
    ReferenceRule::new("recurring_expenses", "category_id", "categories", true),
    ReferenceRule::new(
        "payday_templates",
        "expense_group_id",
        "expense_groups",
        true,
    ),
    ReferenceRule::new(
        "payday_allocations",
        "expense_group_id",
        "expense_groups",
        true,
    ),
    ReferenceRule::new("payday_templates", "category_id", "categories", true),
    ReferenceRule::new("payday_templates", "subcategory_id", "categories", true),
    ReferenceRule::new("payday_allocations", "month_id", "payday_months", false),
    ReferenceRule::new(
        "payday_allocations",
        "template_id",
        "payday_templates",
        true,
    ),
    ReferenceRule::new("payday_allocations", "category_id", "categories", true),
    ReferenceRule::new("payday_allocations", "subcategory_id", "categories", true),
    ReferenceRule::new("recurring_commitments", "category_id", "categories", true),
    ReferenceRule::new(
        "recurring_commitments",
        "subcategory_id",
        "categories",
        true,
    ),
    ReferenceRule::new("goals", "linked_loan_id", "loans", true),
    ReferenceRule::new("scenarios", "loan_id", "loans", true),
    ReferenceRule::new(
        "scenario_category_overrides",
        "scenario_id",
        "scenarios",
        false,
    ),
    ReferenceRule::new(
        "invoice_template_lines",
        "template_id",
        "invoice_templates",
        false,
    ),
    ReferenceRule::new("invoice_revisions", "invoice_id", "invoices", false),
    ReferenceRule::new(
        "invoice_revisions",
        "template_id",
        "invoice_templates",
        true,
    ),
    ReferenceRule::new(
        "invoice_revisions",
        "income_source_id",
        "income_sources",
        true,
    ),
    ReferenceRule::new(
        "invoice_lines",
        "invoice_revision_id",
        "invoice_revisions",
        false,
    ),
];

impl ReferenceRule {
    const fn new(
        child_table: &'static str,
        field: &'static str,
        parent_table: &'static str,
        nullable: bool,
    ) -> Self {
        Self {
            child_table,
            field,
            parent_table,
            nullable,
        }
    }
}

pub async fn snapshot_household(
    pool: &PgPool,
    household_id: Uuid,
) -> Result<HouseholdSnapshot, BackupStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let mut tables = BTreeMap::new();
    for table in BACKUP_TABLES {
        let columns = table_columns(&mut transaction, table).await?;
        let object = columns
            .iter()
            .map(|column| {
                let quoted = quote_identifier(&column.name);
                let value = if matches!(column.data_type.as_str(), "json" | "jsonb") {
                    format!("to_jsonb(row_data.{quoted})")
                } else {
                    format!(
                        "CASE WHEN row_data.{quoted} IS NULL
                              THEN 'null'::jsonb
                              ELSE to_jsonb(row_data.{quoted}::text)
                         END"
                    )
                };
                format!("'{}', {value}", column.name.replace('\'', "''"))
            })
            .collect::<Vec<_>>()
            .join(", ");
        let order_key = if *table == "holding_price_cache" {
            "ticker"
        } else {
            "id"
        };
        let query = format!(
            "SELECT COALESCE(jsonb_agg(jsonb_build_object({object}) ORDER BY row_data.{order_key}),
                             '[]'::jsonb)
             FROM {table} row_data
             WHERE household_id = $1"
        );
        // Intentionally dynamic SQL: `table` comes only from the compiled `BACKUP_TABLES`
        // allowlist and `object` is built from verified `information_schema` column metadata
        // (identifiers quoted via `quote_identifier`). No caller/user input reaches the SQL,
        // and the table/column set is not known at compile time, so this cannot be a macro.
        let rows = sqlx::query_scalar::<_, Value>(&query)
            .bind(household_id)
            .fetch_one(&mut *transaction)
            .await?;
        tables.insert((*table).to_owned(), rows);
    }
    transaction.commit().await?;
    Ok(HouseholdSnapshot {
        format_version: BACKUP_FORMAT_VERSION,
        schema_version: BACKUP_SCHEMA_VERSION,
        household_id,
        created_at: Utc::now(),
        tables,
    })
}

#[derive(Debug, sqlx::FromRow)]
struct ColumnMetadata {
    name: String,
    data_type: String,
}

async fn table_columns(
    transaction: &mut Transaction<'_, Postgres>,
    table: &str,
) -> Result<Vec<ColumnMetadata>, sqlx::Error> {
    sqlx::query_as!(
        ColumnMetadata,
        "SELECT column_name AS \"name!\", data_type AS \"data_type!\"
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position",
        table
    )
    .fetch_all(&mut **transaction)
    .await
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub fn upgrade_snapshot_schema(
    snapshot: &HouseholdSnapshot,
) -> Result<HouseholdSnapshot, BackupStoreError> {
    let mut upgraded = snapshot.clone();
    match upgraded.schema_version {
        BACKUP_SCHEMA_VERSION => return Ok(upgraded),
        PREVIOUS_BACKUP_SCHEMA_VERSION
        | SOURCE_LINK_BACKUP_SCHEMA_VERSION
        | RETIREMENT_BACKUP_SCHEMA_VERSION
        | NET_WORTH_BACKUP_SCHEMA_VERSION
        | RECURRING_BACKUP_SCHEMA_VERSION
        | PAYDAY_BACKUP_SCHEMA_VERSION
        | PRE_ACCOUNT_ASSETS_BACKUP_SCHEMA_VERSION
        | PRE_UTILITY_PRICING_BACKUP_SCHEMA_VERSION
        | PRE_HOLDING_PRICES_BACKUP_SCHEMA_VERSION
        | PRE_UTILITY_COMPLETION_BACKUP_SCHEMA_VERSION
        | PRE_UTILITY_LIFECYCLE_BACKUP_SCHEMA_VERSION
        | PRE_UTILITY_ORDER_BACKUP_SCHEMA_VERSION
        | PRE_UTILITY_CONTRACT_BACKUP_SCHEMA_VERSION => {}
        version => {
            return Err(BackupStoreError::Validation(format!(
                "backup schema version {version} is unsupported; expected {PREVIOUS_BACKUP_SCHEMA_VERSION}, {SOURCE_LINK_BACKUP_SCHEMA_VERSION}, {RETIREMENT_BACKUP_SCHEMA_VERSION}, {NET_WORTH_BACKUP_SCHEMA_VERSION}, {RECURRING_BACKUP_SCHEMA_VERSION}, {PAYDAY_BACKUP_SCHEMA_VERSION}, {PRE_ACCOUNT_ASSETS_BACKUP_SCHEMA_VERSION}, {PRE_UTILITY_PRICING_BACKUP_SCHEMA_VERSION}, {PRE_HOLDING_PRICES_BACKUP_SCHEMA_VERSION}, {PRE_UTILITY_COMPLETION_BACKUP_SCHEMA_VERSION}, {PRE_UTILITY_LIFECYCLE_BACKUP_SCHEMA_VERSION}, {PRE_UTILITY_ORDER_BACKUP_SCHEMA_VERSION}, {PRE_UTILITY_CONTRACT_BACKUP_SCHEMA_VERSION} or {BACKUP_SCHEMA_VERSION}"
            )));
        }
    }

    for (table, fields) in [
        ("expense_groups", &["linked_property_id"][..]),
        ("categories", &["linked_loan_id", "linked_project_id"][..]),
    ] {
        let rows = upgraded.tables.get_mut(table).ok_or_else(|| {
            BackupStoreError::Validation(format!("backup is missing table {table}"))
        })?;
        let rows = rows.as_array_mut().ok_or_else(|| {
            BackupStoreError::Validation(format!("table {table} must contain an array"))
        })?;
        for row in rows {
            let object = row.as_object_mut().ok_or_else(|| {
                BackupStoreError::Validation(format!("table {table} contains a non-object row"))
            })?;
            for field in fields {
                object.entry((*field).to_owned()).or_insert(Value::Null);
            }
            object
                .entry("is_retired".to_owned())
                .or_insert_with(|| json!("false"));
            object
                .entry("creation_origin".to_owned())
                .or_insert_with(|| json!("legacy_unknown"));
        }
    }
    for table in [
        "utility_months",
        "net_worth_months",
        "net_worth_month_components",
        "recurring_expenses",
        "payday_templates",
        "payday_months",
        "payday_allocations",
        "account_holdings",
    ] {
        upgraded
            .tables
            .entry(table.to_owned())
            .or_insert_with(|| json!([]));
    }
    if let Some(properties) = upgraded.tables.get_mut("properties") {
        let properties = properties.as_array_mut().ok_or_else(|| {
            BackupStoreError::Validation("table properties must contain an array".to_owned())
        })?;
        for row in properties {
            let object = row.as_object_mut().ok_or_else(|| {
                BackupStoreError::Validation(
                    "table properties contains a non-object row".to_owned(),
                )
            })?;
            object
                .entry("account_type".to_owned())
                .or_insert(Value::Null);
            object
                .entry("account_registration".to_owned())
                .or_insert(Value::Null);
        }
    }
    for table in ["payday_templates", "payday_allocations"] {
        let rows = upgraded
            .tables
            .get_mut(table)
            .and_then(Value::as_array_mut)
            .ok_or_else(|| {
                BackupStoreError::Validation(format!("table {table} must contain an array"))
            })?;
        for row in rows {
            let object = row.as_object_mut().ok_or_else(|| {
                BackupStoreError::Validation(format!("table {table} contains a non-object row"))
            })?;
            object
                .entry("position".to_owned())
                .or_insert_with(|| json!("0"));
            if table == "payday_templates" {
                let id = parse_uuid_field(object, "id")?;
                object
                    .entry("recurrence_id".to_owned())
                    .or_insert_with(|| json!(id));
                object
                    .entry("starts_on".to_owned())
                    .or_insert_with(|| json!("-infinity"));
                object
                    .entry("ends_before".to_owned())
                    .or_insert(Value::Null);
            } else {
                object.entry("deleted_at".to_owned()).or_insert(Value::Null);
            }
        }
    }
    for table in ["utility_services", "utility_bills"] {
        if let Some(rows) = upgraded.tables.get_mut(table).and_then(Value::as_array_mut) {
            for row in rows {
                let object = row.as_object_mut().ok_or_else(|| {
                    BackupStoreError::Validation(format!("table {table} contains a non-object row"))
                })?;
                if table == "utility_services" {
                    object.entry("color".to_owned()).or_insert(Value::Null);
                    object.entry("retired".to_owned()).or_insert(json!(false));
                    object.entry("hidden".to_owned()).or_insert(json!(false));
                }
                object.entry("unit_rate".to_owned()).or_insert(Value::Null);
                object.entry("entry_mode".to_owned()).or_insert_with(|| {
                    if table == "utility_services" {
                        json!("meter")
                    } else {
                        Value::Null
                    }
                });
                if table == "utility_bills" {
                    object
                        .entry("usage_amount".to_owned())
                        .or_insert(Value::Null);
                }
            }
        }
    }
    upgraded
        .tables
        .entry("holding_price_cache".to_owned())
        .or_insert_with(|| json!([]));
    if let Some(rows) = upgraded
        .tables
        .get_mut("account_holdings")
        .and_then(Value::as_array_mut)
    {
        for row in rows {
            let object = row.as_object_mut().ok_or_else(|| {
                BackupStoreError::Validation(
                    "account_holdings contains a non-object row".to_owned(),
                )
            })?;
            object.entry("ticker".to_owned()).or_insert(Value::Null);
        }
    }
    if let Some(rows) = upgraded
        .tables
        .get_mut("utility_services")
        .and_then(Value::as_array_mut)
    {
        rows.sort_by(|a, b| {
            a["label"]
                .as_str()
                .cmp(&b["label"].as_str())
                .then_with(|| a["service_key"].as_str().cmp(&b["service_key"].as_str()))
                .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
        });
        for (position, row) in rows.iter_mut().enumerate() {
            let object = row.as_object_mut().ok_or_else(|| {
                BackupStoreError::Validation(
                    "utility_services contains a non-object row".to_owned(),
                )
            })?;
            object
                .entry("sort_order".to_owned())
                .or_insert(json!(position));
        }
    }
    upgrade_utility_contracts(&mut upgraded)?;
    upgraded.schema_version = BACKUP_SCHEMA_VERSION;
    Ok(upgraded)
}

pub async fn restore_household(
    pool: &PgPool,
    household_id: Uuid,
    actor_user_id: Uuid,
    snapshot: &HouseholdSnapshot,
) -> Result<BTreeMap<String, u64>, BackupStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    tenant::advisory_lock(&mut transaction, household_id).await?;
    let upgraded = upgrade_snapshot_schema(snapshot)?;
    let restored = replace_household_data(&mut transaction, household_id, &upgraded).await?;
    let timezone: String = sqlx::query_scalar!(
        "SELECT timezone FROM households WHERE id = $1",
        household_id
    )
    .fetch_one(&mut *transaction)
    .await?;
    let current_month = month_start_at(&timezone, Utc::now()).map_err(|error| {
        BackupStoreError::Validation(format!("household timezone is invalid: {error}"))
    })?;
    materialize_household_in_transaction(&mut transaction, household_id, current_month)
        .await
        .map_err(|error| {
            BackupStoreError::Validation(format!(
                "planning materialization after restore failed: {error}"
            ))
        })?;
    sqlx::query!(
        "INSERT INTO audit_events
            (household_id, actor_user_id, event_type, resource_type, payload)
         VALUES ($1,$2,'backup_restored','household',$3)",
        household_id,
        actor_user_id,
        json!({
            "format_version": snapshot.format_version,
            "schema_version": upgraded.schema_version,
            "created_at": snapshot.created_at
        })
    )
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(restored)
}

pub async fn validate_snapshot_rows(
    transaction: &mut Transaction<'_, Postgres>,
    snapshot: &HouseholdSnapshot,
) -> Result<(), BackupStoreError> {
    for table in BACKUP_TABLES {
        let rows = snapshot
            .tables
            .get(*table)
            .ok_or_else(|| missing_table(table))?;
        let expected_columns = table_columns(transaction, table)
            .await?
            .into_iter()
            .map(|column| column.name)
            .collect::<BTreeSet<_>>();
        for row in table_rows(snapshot, table)? {
            let actual_columns = row
                .as_object()
                .ok_or_else(|| {
                    BackupStoreError::Validation(format!("table {table} contains a non-object row"))
                })?
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>();
            if actual_columns != expected_columns {
                return Err(BackupStoreError::Validation(format!(
                    "table {table} row columns do not match the archive schema"
                )));
            }
        }
        // Intentionally dynamic SQL: `table` is an allowlisted `BACKUP_TABLES` identifier used
        // as a composite type name for `jsonb_populate_recordset`; the row payload is bound. The
        // table name is not known at compile time, so a macro is not possible here.
        let query =
            format!("SELECT count(*) FROM jsonb_populate_recordset(NULL::{table}, $1::jsonb)");
        sqlx::query_scalar::<_, i64>(&query)
            .bind(rows)
            .fetch_one(&mut **transaction)
            .await
            .map_err(|error| {
                BackupStoreError::Validation(format!(
                    "table {table} contains invalid values: {error}"
                ))
            })?;
    }
    Ok(())
}

pub async fn replace_household_data(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    snapshot: &HouseholdSnapshot,
) -> Result<BTreeMap<String, u64>, BackupStoreError> {
    sqlx::query("SAVEPOINT expense_source_restore")
        .execute(&mut **transaction)
        .await?;
    match replace_household_data_inner(transaction, household_id, snapshot).await {
        Ok(restored) => {
            sqlx::query("RELEASE SAVEPOINT expense_source_restore")
                .execute(&mut **transaction)
                .await?;
            Ok(restored)
        }
        Err(error) => {
            // Roll back both the partial restore and its transaction-local bypass flag.
            sqlx::query("ROLLBACK TO SAVEPOINT expense_source_restore")
                .execute(&mut **transaction)
                .await?;
            sqlx::query("RELEASE SAVEPOINT expense_source_restore")
                .execute(&mut **transaction)
                .await?;
            Err(error)
        }
    }
}

async fn replace_household_data_inner(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    snapshot: &HouseholdSnapshot,
) -> Result<BTreeMap<String, u64>, BackupStoreError> {
    validate_snapshot(snapshot, household_id)?;
    if snapshot.schema_version != BACKUP_SCHEMA_VERSION {
        return Err(BackupStoreError::Validation(format!(
            "backup schema version {} does not match archive schema version {BACKUP_SCHEMA_VERSION}",
            snapshot.schema_version,
        )));
    }

    validate_snapshot_rows(transaction, snapshot).await?;

    // Restore original source/category UUIDs before enforcing synchronization.
    // The new source FKs are deferred; final reconciliation must precede commit.
    sqlx::query("SELECT set_config('app.expense_source_restore', 'on', true)")
        .execute(&mut **transaction)
        .await?;

    for table in BACKUP_TABLES
        .iter()
        .rev()
        .filter(|table| **table != "audit_events")
    {
        // Intentionally dynamic SQL: `table` is an allowlisted `BACKUP_TABLES` identifier; the
        // household scope is bound. Table name is not known at compile time (macro impossible).
        let query = format!("DELETE FROM {table} WHERE household_id = $1");
        sqlx::query(&query)
            .bind(household_id)
            .execute(&mut **transaction)
            .await?;
    }

    let mut restored = BTreeMap::new();
    for table in BACKUP_TABLES {
        let rows = snapshot
            .tables
            .get(*table)
            .ok_or_else(|| missing_table(table))?;
        let query = if *table == "audit_events" {
            "INSERT INTO audit_events
             SELECT * FROM jsonb_populate_recordset(NULL::audit_events, $1::jsonb)
             ON CONFLICT (id) DO NOTHING"
                .to_owned()
        } else {
            format!(
                "INSERT INTO {table}
                 SELECT * FROM jsonb_populate_recordset(NULL::{table}, $1::jsonb)"
            )
        };
        // Intentionally dynamic SQL: `table` is an allowlisted `BACKUP_TABLES` identifier used as
        // both target table and composite type for `jsonb_populate_recordset`; the row payload is
        // bound. Table name is not known at compile time, so this cannot be a macro.
        let count = sqlx::query(&query)
            .bind(rows)
            .execute(&mut **transaction)
            .await?
            .rows_affected();
        if count > 0 {
            restored.insert((*table).to_owned(), count);
        }
    }
    sqlx::query("SELECT set_config('app.expense_source_restore', 'off', true)")
        .execute(&mut **transaction)
        .await?;
    // Trigger reconciliation runs only after the original source UUIDs exist.
    // Inconsistent archives fail atomically instead of adopting conflicting rows.
    sqlx::query("UPDATE properties SET name = name WHERE household_id = $1")
        .bind(household_id)
        .execute(&mut **transaction)
        .await?;
    sqlx::query("UPDATE loans SET name = name WHERE household_id = $1")
        .bind(household_id)
        .execute(&mut **transaction)
        .await?;
    sqlx::query("UPDATE projects SET name = name WHERE household_id = $1")
        .bind(household_id)
        .execute(&mut **transaction)
        .await?;
    Ok(restored)
}

pub fn validate_snapshot(
    snapshot: &HouseholdSnapshot,
    household_id: Uuid,
) -> Result<(), BackupStoreError> {
    if snapshot.format_version != BACKUP_FORMAT_VERSION {
        return Err(BackupStoreError::Validation(format!(
            "unsupported backup format version {}",
            snapshot.format_version
        )));
    }
    if snapshot.household_id != household_id {
        return Err(BackupStoreError::Validation(
            "backup belongs to a different household".to_owned(),
        ));
    }
    if snapshot.tables.len() != BACKUP_TABLES.len()
        || snapshot
            .tables
            .keys()
            .any(|table| !BACKUP_TABLES.contains(&table.as_str()))
    {
        return Err(BackupStoreError::Validation(
            "backup table set does not match this application version".to_owned(),
        ));
    }

    let mut ids = BTreeMap::<&str, BTreeSet<Uuid>>::new();
    for table in BACKUP_TABLES {
        let rows = table_rows(snapshot, table)?;
        let mut table_ids = BTreeSet::new();
        let mut cache_tickers = BTreeSet::new();
        for row in rows {
            let object = row.as_object().ok_or_else(|| {
                BackupStoreError::Validation(format!("table {table} contains a non-object row"))
            })?;
            let row_household = parse_uuid_field(object, "household_id")?;
            if row_household != household_id {
                return Err(BackupStoreError::Validation(format!(
                    "table {table} contains a cross-household row"
                )));
            }
            if *table == "holding_price_cache" {
                let ticker = object
                    .get("ticker")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        BackupStoreError::Validation(
                            "holding price cache has an invalid ticker".to_owned(),
                        )
                    })?;
                if checkbook_domain::holding_prices::normalize_ticker(Some(ticker))
                    .ok()
                    .flatten()
                    .as_deref()
                    != Some(ticker)
                    || !cache_tickers.insert(ticker)
                {
                    return Err(BackupStoreError::Validation(
                        "holding price cache has an invalid or duplicate ticker".to_owned(),
                    ));
                }
                continue;
            }
            let id = parse_uuid_field(object, "id")?;
            if !table_ids.insert(id) {
                return Err(BackupStoreError::Validation(format!(
                    "table {table} contains duplicate id {id}"
                )));
            }
        }
        ids.insert(table, table_ids);
    }

    for rule in REFERENCES {
        let rows = table_rows(snapshot, rule.child_table)?;
        let parent_ids = ids.get(rule.parent_table).ok_or_else(|| {
            BackupStoreError::Validation(format!(
                "reference target table {} is missing",
                rule.parent_table
            ))
        })?;
        for row in rows {
            let object = row.as_object().ok_or_else(|| {
                BackupStoreError::Validation(format!(
                    "table {} contains a non-object row",
                    rule.child_table
                ))
            })?;
            let Some(value) = object.get(rule.field) else {
                if rule.nullable {
                    continue;
                }
                return Err(BackupStoreError::Validation(format!(
                    "table {} is missing required field {}",
                    rule.child_table, rule.field
                )));
            };
            if value.is_null() && rule.nullable {
                continue;
            }
            let id = value
                .as_str()
                .and_then(|value| Uuid::parse_str(value).ok())
                .ok_or_else(|| {
                    BackupStoreError::Validation(format!(
                        "table {} has an invalid {}",
                        rule.child_table, rule.field
                    ))
                })?;
            if !parent_ids.contains(&id) {
                return Err(BackupStoreError::Validation(format!(
                    "table {} references missing {} id {}",
                    rule.child_table, rule.parent_table, id
                )));
            }
        }
    }
    validate_invoice_totals(snapshot)?;
    Ok(())
}

fn validate_invoice_totals(snapshot: &HouseholdSnapshot) -> Result<(), BackupStoreError> {
    #[derive(Clone)]
    struct RevisionAmounts {
        conversion_enabled: bool,
        conversion_currency: String,
        conversion_rate: Decimal,
        subtotal: Decimal,
        tax_amount: Decimal,
        total_amount: Decimal,
    }

    let mut revisions = BTreeMap::<Uuid, RevisionAmounts>::new();
    for row in table_rows(snapshot, "invoice_revisions")? {
        let object = row.as_object().ok_or_else(|| {
            BackupStoreError::Validation(
                "table invoice_revisions contains a non-object row".to_owned(),
            )
        })?;
        let id = parse_uuid_field(object, "id")?;
        revisions.insert(
            id,
            RevisionAmounts {
                conversion_enabled: parse_bool_field(object, "conversion_enabled")?,
                conversion_currency: parse_string_field(object, "conversion_currency")?.to_owned(),
                conversion_rate: parse_decimal_field(object, "conversion_rate")?,
                subtotal: parse_decimal_field(object, "subtotal")?,
                tax_amount: parse_decimal_field(object, "tax_amount")?,
                total_amount: parse_decimal_field(object, "total_amount")?,
            },
        );
    }
    let mut totals = BTreeMap::<Uuid, (Decimal, Decimal)>::new();
    for row in table_rows(snapshot, "invoice_lines")? {
        let object = row.as_object().ok_or_else(|| {
            BackupStoreError::Validation("table invoice_lines contains a non-object row".to_owned())
        })?;
        let revision_id = parse_uuid_field(object, "invoice_revision_id")?;
        let revision = revisions.get(&revision_id).ok_or_else(|| {
            BackupStoreError::Validation(format!(
                "invoice line references missing revision {revision_id}"
            ))
        })?;
        let currency = parse_string_field(object, "currency")?;
        let factor = if revision.conversion_enabled
            && !currency.is_empty()
            && currency.eq_ignore_ascii_case(&revision.conversion_currency)
        {
            revision.conversion_rate
        } else {
            Decimal::ONE
        };
        let amounts = calculate_invoice(
            &[InvoiceLine {
                quantity: parse_decimal_field(object, "quantity")?,
                unit_price: parse_decimal_field(object, "unit_price")?,
                vat_rate: parse_vat_fraction(parse_string_field(object, "vat_rate")?)?,
            }],
            factor,
        )
        .map_err(|error| {
            BackupStoreError::Validation(format!("invoice line calculation failed: {error}"))
        })?;
        if amounts.subtotal != parse_decimal_field(object, "net_amount")?
            || amounts.tax_amount != parse_decimal_field(object, "tax_amount")?
            || amounts.total_amount != parse_decimal_field(object, "gross_amount")?
        {
            return Err(BackupStoreError::Validation(
                "invoice line stored totals are inconsistent".to_owned(),
            ));
        }
        let total = totals.entry(revision_id).or_default();
        total.0 += amounts.subtotal;
        total.1 += amounts.tax_amount;
    }
    for (revision_id, revision) in revisions {
        let (subtotal, tax_amount) = totals.get(&revision_id).copied().unwrap_or_default();
        if subtotal != revision.subtotal
            || tax_amount != revision.tax_amount
            || subtotal + tax_amount != revision.total_amount
        {
            return Err(BackupStoreError::Validation(format!(
                "invoice revision {revision_id} stored totals are inconsistent"
            )));
        }
    }
    Ok(())
}

fn parse_string_field<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Result<&'a str, BackupStoreError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| BackupStoreError::Validation(format!("backup row has an invalid {field}")))
}

fn parse_decimal_field(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Decimal, BackupStoreError> {
    parse_string_field(object, field)?
        .parse()
        .map_err(|_| BackupStoreError::Validation(format!("backup row has an invalid {field}")))
}

fn parse_bool_field(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<bool, BackupStoreError> {
    parse_string_field(object, field)?
        .parse()
        .map_err(|_| BackupStoreError::Validation(format!("backup row has an invalid {field}")))
}

fn parse_vat_fraction(value: &str) -> Result<Decimal, BackupStoreError> {
    let rate: Decimal = value
        .trim()
        .trim_end_matches('%')
        .parse()
        .map_err(|_| BackupStoreError::Validation("invoice VAT rate is invalid".to_owned()))?;
    let fraction = if rate > Decimal::ONE {
        rate / Decimal::from(100)
    } else {
        rate
    };
    if fraction.is_sign_negative() || fraction > Decimal::ONE {
        return Err(BackupStoreError::Validation(
            "invoice VAT rate is invalid".to_owned(),
        ));
    }
    Ok(fraction)
}

fn table_rows<'a>(
    snapshot: &'a HouseholdSnapshot,
    table: &str,
) -> Result<&'a Vec<Value>, BackupStoreError> {
    snapshot
        .tables
        .get(table)
        .and_then(Value::as_array)
        .ok_or_else(|| missing_table(table))
}

fn parse_uuid_field(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Uuid, BackupStoreError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| BackupStoreError::Validation(format!("backup row has an invalid {field}")))
}

fn missing_table(table: &str) -> BackupStoreError {
    BackupStoreError::Validation(format!("backup table {table} is missing or invalid"))
}

#[cfg(test)]
mod snapshot_schema_tests {
    use super::{
        BACKUP_SCHEMA_VERSION, HouseholdSnapshot, PREVIOUS_BACKUP_SCHEMA_VERSION,
        upgrade_snapshot_schema,
    };
    use chrono::Utc;
    use serde_json::json;
    use std::collections::BTreeMap;
    use uuid::Uuid;

    #[test]
    fn upgrades_holding_prices_without_changing_holdings() -> Result<(), super::BackupStoreError> {
        let snapshot = HouseholdSnapshot {
            format_version: 2,
            schema_version: 12,
            household_id: Uuid::new_v4(),
            created_at: Utc::now(),
            tables: BTreeMap::from([
                (
                    "account_holdings".to_owned(),
                    json!([{"name":"VTI","value":12.34}]),
                ),
                ("expense_groups".to_owned(), json!([])),
                ("categories".to_owned(), json!([])),
            ]),
        };
        let upgraded = upgrade_snapshot_schema(&snapshot)?;
        assert_eq!(upgraded.schema_version, BACKUP_SCHEMA_VERSION);
        assert_eq!(upgraded.tables["utility_months"], json!([]));
        assert_eq!(upgraded.tables["holding_price_cache"], json!([]));
        assert!(upgraded.tables["account_holdings"][0]["ticker"].is_null());
        assert_eq!(
            upgraded.tables["account_holdings"][0]["value"],
            json!(12.34)
        );
        assert_eq!(upgrade_snapshot_schema(&upgraded)?.tables, upgraded.tables);
        Ok(())
    }
    #[test]
    fn upgrades_pre_order_catalog_deterministically() -> Result<(), super::BackupStoreError> {
        let snapshot = HouseholdSnapshot {
            format_version: 2,
            schema_version: 15,
            household_id: Uuid::new_v4(),
            created_at: Utc::now(),
            tables: BTreeMap::from([
                ("expense_groups".to_owned(), json!([])),
                ("categories".to_owned(), json!([])),
                (
                    "utility_services".to_owned(),
                    json!([
                        {"label":"Zebra","service_key":"z","retired":false},
                        {"label":"Alpha","service_key":"a","retired":true}
                    ]),
                ),
            ]),
        };
        let upgraded = upgrade_snapshot_schema(&snapshot)?;
        assert_eq!(upgraded.tables["utility_services"][0]["service_key"], "a");
        assert_eq!(upgraded.tables["utility_services"][0]["sort_order"], 0);
        assert_eq!(upgraded.tables["utility_services"][1]["sort_order"], 1);
        assert_eq!(upgrade_snapshot_schema(&upgraded)?.tables, upgraded.tables);
        Ok(())
    }

    #[test]
    fn upgrades_pre_lifecycle_services_and_preserves_flags() -> Result<(), super::BackupStoreError>
    {
        let mut snapshot = HouseholdSnapshot {
            format_version: 2,
            schema_version: 14,
            household_id: Uuid::new_v4(),
            created_at: Utc::now(),
            tables: BTreeMap::from([
                ("expense_groups".to_owned(), json!([])),
                ("categories".to_owned(), json!([])),
                ("utility_services".to_owned(), json!([{"label":"Water"}])),
            ]),
        };
        let upgraded = upgrade_snapshot_schema(&snapshot)?;
        assert_eq!(upgraded.tables["utility_services"][0]["retired"], false);
        assert_eq!(upgraded.tables["utility_services"][0]["hidden"], false);
        assert!(upgraded.tables["utility_services"][0]["color"].is_null());
        snapshot.tables.insert(
            "utility_services".to_owned(),
            json!([{"retired":true,"hidden":true,"color":"#aB12Ef"}]),
        );
        let upgraded = upgrade_snapshot_schema(&snapshot)?;
        assert_eq!(upgraded.tables["utility_services"][0]["retired"], true);
        assert_eq!(upgraded.tables["utility_services"][0]["hidden"], true);
        assert_eq!(upgraded.tables["utility_services"][0]["color"], "#aB12Ef");
        Ok(())
    }

    #[test]
    fn upgrades_utility_pricing_columns_without_changing_saved_snapshots()
    -> Result<(), super::BackupStoreError> {
        let snapshot = HouseholdSnapshot {
            format_version: 2,
            schema_version: 11,
            household_id: Uuid::new_v4(),
            created_at: Utc::now(),
            tables: BTreeMap::from([
                ("expense_groups".to_owned(), json!([])),
                ("categories".to_owned(), json!([])),
                ("utility_services".to_owned(), json!([{"label":"Water"}])),
                ("utility_bills".to_owned(), json!([{"amount":12.34}])),
            ]),
        };
        let upgraded = upgrade_snapshot_schema(&snapshot)?;
        assert_eq!(
            upgraded.tables["utility_services"][0]["entry_mode"],
            "meter"
        );
        assert_eq!(upgraded.tables["utility_services"][0]["retired"], false);
        assert_eq!(upgraded.tables["utility_services"][0]["hidden"], false);
        assert!(upgraded.tables["utility_services"][0]["unit_rate"].is_null());
        assert!(upgraded.tables["utility_bills"][0]["entry_mode"].is_null());
        assert!(upgraded.tables["utility_bills"][0]["unit_rate"].is_null());
        assert!(upgraded.tables["utility_bills"][0]["usage_amount"].is_null());
        assert_eq!(upgraded.tables["utility_bills"][0]["amount"], json!(12.34));
        assert_eq!(upgrade_snapshot_schema(&upgraded)?.tables, upgraded.tables);
        Ok(())
    }

    #[test]
    fn upgrades_legacy_versions_with_empty_canonical_months() -> Result<(), super::BackupStoreError>
    {
        for version in [4, 5, 6, 7, 8, 9, 10] {
            let snapshot = HouseholdSnapshot {
                format_version: 2,
                schema_version: version,
                household_id: Uuid::new_v4(),
                created_at: Utc::now(),
                tables: BTreeMap::from([
                    ("expense_groups".to_owned(), json!([])),
                    ("categories".to_owned(), json!([])),
                ]),
            };
            let upgraded = upgrade_snapshot_schema(&snapshot)?;
            assert_eq!(upgraded.schema_version, BACKUP_SCHEMA_VERSION);
            for table in [
                "net_worth_months",
                "net_worth_month_components",
                "recurring_expenses",
                "payday_templates",
                "payday_months",
                "payday_allocations",
                "account_holdings",
            ] {
                assert!(super::BACKUP_TABLES.contains(&table));
                assert_eq!(upgraded.tables[table], json!([]));
                assert!(!snapshot.tables.contains_key(table));
            }
        }
        Ok(())
    }

    #[test]
    fn upgrades_legacy_properties_without_changing_decimal_lexemes()
    -> Result<(), super::BackupStoreError> {
        for version in [4, 5, 6, 7, 8, 9, 10] {
            let property = json!({
                "id": Uuid::new_v4(), "category": "property", "valuation": "1234.5600"
            });
            let snapshot = HouseholdSnapshot {
                format_version: 2,
                schema_version: version,
                household_id: Uuid::new_v4(),
                created_at: Utc::now(),
                tables: BTreeMap::from([
                    ("expense_groups".to_owned(), json!([])),
                    ("categories".to_owned(), json!([])),
                    ("properties".to_owned(), json!([property.clone()])),
                ]),
            };
            let upgraded = upgrade_snapshot_schema(&snapshot)?;
            let row = &upgraded.tables["properties"][0];
            assert_eq!(row["account_type"], json!(null));
            assert_eq!(row["account_registration"], json!(null));
            assert!(
                row.as_object()
                    .is_some_and(|object| object.contains_key("account_type"))
            );
            assert!(
                row.as_object()
                    .is_some_and(|object| object.contains_key("account_registration"))
            );
            assert_eq!(row["valuation"], json!("1234.5600"));
            assert_eq!(snapshot.tables["properties"][0], property);
            assert_eq!(upgrade_snapshot_schema(&upgraded)?.tables, upgraded.tables);
        }
        Ok(())
    }

    #[test]
    fn upgrades_payday_snapshots_with_historical_recurrence_ranges()
    -> Result<(), super::BackupStoreError> {
        let id = Uuid::new_v4();
        let snapshot = HouseholdSnapshot {
            format_version: 2,
            schema_version: 9,
            household_id: Uuid::new_v4(),
            created_at: Utc::now(),
            tables: BTreeMap::from([
                ("expense_groups".to_owned(), json!([])),
                ("categories".to_owned(), json!([])),
                (
                    "payday_templates".to_owned(),
                    json!([{"id": id, "amount": "100.25"}]),
                ),
                (
                    "payday_allocations".to_owned(),
                    json!([{"id": Uuid::new_v4(), "template_id": id}]),
                ),
            ]),
        };
        let upgraded = upgrade_snapshot_schema(&snapshot)?;
        let template = &upgraded.tables["payday_templates"][0];
        assert_eq!(template["recurrence_id"], json!(id));
        assert_eq!(template["starts_on"], json!("-infinity"));
        assert_eq!(template["ends_before"], json!(null));
        assert_eq!(template["amount"], json!("100.25"));
        assert_eq!(template["position"], json!("0"));
        assert_eq!(
            upgraded.tables["payday_allocations"][0]["position"],
            json!("0")
        );
        let mut positioned = upgraded.clone();
        positioned
            .tables
            .get_mut("payday_templates")
            .ok_or_else(|| super::BackupStoreError::Validation("missing templates".into()))?[0]["position"] =
            json!("7");
        assert_eq!(
            upgrade_snapshot_schema(&positioned)?.tables["payday_templates"][0]["position"],
            json!("7")
        );
        assert_eq!(
            upgraded.tables["payday_allocations"][0]["deleted_at"],
            json!(null)
        );
        assert_eq!(upgrade_snapshot_schema(&upgraded)?.tables, upgraded.tables);
        assert!(
            !snapshot.tables["payday_templates"][0]
                .as_object()
                .is_some_and(|row| row.contains_key("recurrence_id"))
        );
        Ok(())
    }

    #[test]
    fn upgrades_version_four_source_fields_to_null() -> Result<(), super::BackupStoreError> {
        let mut tables = BTreeMap::new();
        tables.insert(
            "expense_groups".to_owned(),
            json!([{"id": "group", "name": "Home"}]),
        );
        tables.insert(
            "categories".to_owned(),
            json!([{"id": "category", "name": "Utilities"}]),
        );
        let snapshot = HouseholdSnapshot {
            format_version: 2,
            schema_version: PREVIOUS_BACKUP_SCHEMA_VERSION,
            household_id: Uuid::new_v4(),
            created_at: Utc::now(),
            tables,
        };

        let upgraded = upgrade_snapshot_schema(&snapshot)?;
        assert_eq!(upgraded.schema_version, BACKUP_SCHEMA_VERSION);
        assert_eq!(
            upgraded.tables["expense_groups"][0]["linked_property_id"],
            json!(null)
        );
        assert_eq!(
            upgraded.tables["categories"][0]["linked_loan_id"],
            json!(null)
        );
        assert_eq!(
            upgraded.tables["categories"][0]["linked_project_id"],
            json!(null)
        );
        assert_eq!(snapshot.schema_version, PREVIOUS_BACKUP_SCHEMA_VERSION);
        Ok(())
    }

    #[test]
    fn upgrades_legacy_properties_without_guessing_alias_links()
    -> Result<(), super::BackupStoreError> {
        let property_id = Uuid::new_v4();
        let group_id = Uuid::new_v4();
        let snapshot = HouseholdSnapshot {
            format_version: 2,
            schema_version: PREVIOUS_BACKUP_SCHEMA_VERSION,
            household_id: Uuid::new_v4(),
            created_at: Utc::now(),
            tables: BTreeMap::from([
                (
                    "properties".to_owned(),
                    json!([{"id": property_id, "name": "Example House"}]),
                ),
                (
                    "expense_groups".to_owned(),
                    json!([{"id": group_id, "name": "House", "normalized_name": "house"}]),
                ),
                ("categories".to_owned(), json!([])),
            ]),
        };

        let upgraded = upgrade_snapshot_schema(&snapshot)?;
        let group = &upgraded.tables["expense_groups"][0];
        assert_eq!(group["id"], json!(group_id));
        assert_eq!(group["name"], "House");
        assert_eq!(group["normalized_name"], "house");
        assert_eq!(group["linked_property_id"], json!(null));
        assert_eq!(upgraded.tables["properties"][0]["id"], json!(property_id));
        assert_eq!(upgraded.tables["properties"][0]["name"], "Example House");
        assert_eq!(upgrade_snapshot_schema(&upgraded)?.tables, upgraded.tables);
        Ok(())
    }

    #[test]
    fn upgrades_preserve_explicit_source_links() -> Result<(), super::BackupStoreError> {
        let property_id = Uuid::new_v4();
        let loan_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let snapshot = HouseholdSnapshot {
            format_version: 2,
            schema_version: super::SOURCE_LINK_BACKUP_SCHEMA_VERSION,
            household_id: Uuid::new_v4(),
            created_at: Utc::now(),
            tables: BTreeMap::from([
                (
                    "expense_groups".to_owned(),
                    json!([{"id": Uuid::new_v4(), "linked_property_id": property_id}]),
                ),
                (
                    "categories".to_owned(),
                    json!([
                        {"id": Uuid::new_v4(), "linked_loan_id": loan_id, "linked_project_id": null},
                        {"id": Uuid::new_v4(), "linked_loan_id": null, "linked_project_id": project_id}
                    ]),
                ),
            ]),
        };

        let upgraded = upgrade_snapshot_schema(&snapshot)?;
        assert_eq!(
            upgraded.tables["expense_groups"][0]["linked_property_id"],
            json!(property_id)
        );
        assert_eq!(
            upgraded.tables["categories"][0]["linked_loan_id"],
            json!(loan_id)
        );
        assert_eq!(
            upgraded.tables["categories"][1]["linked_project_id"],
            json!(project_id)
        );
        assert_eq!(upgrade_snapshot_schema(&upgraded)?.tables, upgraded.tables);
        Ok(())
    }
}
