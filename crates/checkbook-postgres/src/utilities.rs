use std::collections::BTreeMap;

use checkbook_domain::month_start_at;
use chrono::{Datelike, Months, NaiveDate};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{planning::materialize_household_in_transaction, tenant};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackedFieldRecord {
    #[serde(default)]
    pub contract_id: Option<Uuid>,
    #[serde(default)]
    pub property_id: Option<Uuid>,
    #[serde(default)]
    pub start_date: Option<NaiveDate>,
    #[serde(default)]
    pub end_date: Option<NaiveDate>,
    #[serde(default)]
    pub tracking_mode: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub retired: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub has_data: bool,
    pub key: String,
    pub label: String,
    pub kind: String,
    pub unit: String,
    #[serde(default = "default_entry_mode")]
    pub entry_mode: String,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub unit_rate: Option<Decimal>,
}

#[derive(Debug, Clone, Default)]
pub struct UtilityFieldStateRecord {
    pub amount: Option<Decimal>,
    pub meter_reading: Option<Decimal>,
    pub usage_amount: Option<Decimal>,
}

#[derive(Debug, Clone)]
pub struct UtilityBoardMonthRecord {
    pub month: String,
    pub completed: bool,
    pub values: BTreeMap<String, UtilityFieldStateRecord>,
    pub total: Decimal,
}

#[derive(Debug, Clone)]
pub struct UtilitySeriesPointRecord {
    pub period: String,
    pub values: BTreeMap<String, Decimal>,
    pub usage: BTreeMap<String, Decimal>,
    pub units: BTreeMap<String, String>,
    pub total: Decimal,
}

#[derive(Debug, Clone)]
pub struct UtilityBoardSubjectRecord {
    pub id: Uuid,
    pub kind: String,
    pub name: String,
    pub group_type: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    pub notes: String,
    pub tracked_fields: Vec<TrackedFieldRecord>,
}

#[derive(Debug, Clone)]
pub struct UtilityBoardRecord {
    pub subject: UtilityBoardSubjectRecord,
    pub trend: Vec<UtilitySeriesPointRecord>,
    pub months: Vec<UtilityBoardMonthRecord>,
}

#[derive(Debug, Clone)]
pub struct UtilityEntryFormFieldRecord {
    pub contract_id: Option<Uuid>,
    pub property_id: Option<Uuid>,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub tracking_mode: Option<String>,
    pub amount_source: String,
    pub color: Option<String>,
    pub key: String,
    pub label: String,
    pub kind: String,
    pub unit: String,
    pub amount: Option<Decimal>,
    pub meter_reading: Option<Decimal>,
    pub usage_amount: Option<Decimal>,
    pub entry_mode: String,
    pub unit_rate: Option<Decimal>,
    pub previous_amount: Option<Decimal>,
    pub previous_meter_reading: Option<Decimal>,
    pub previous_usage: Option<Decimal>,
}

#[derive(Debug, Clone)]
pub struct UtilityEntryFormRecord {
    pub month: String,
    pub completed: bool,
    pub fields: Vec<UtilityEntryFormFieldRecord>,
}

#[derive(Debug, Clone)]
pub struct UtilityEntryValueInput {
    pub amount_source: Option<String>,
    pub usage_amount: Option<Decimal>,
    pub field_key: String,
    pub amount: Option<Decimal>,
    pub meter_reading: Option<Decimal>,
}

#[derive(Debug, Clone)]
pub struct UtilityUpsertInput {
    pub month: String,
    pub completed: Option<bool>,
    pub month_start: NaiveDate,
    pub entries: Vec<UtilityEntryValueInput>,
    pub base_currency: String,
    pub household_timezone: String,
}

#[derive(Debug, Clone)]
pub struct ManualUtilityInput {
    pub provider: String,
    pub description: String,
    pub amount: Decimal,
    pub charge_date: NaiveDate,
    pub owner_scope: String,
    pub property_id: Option<Uuid>,
    pub group_id: Option<Uuid>,
    pub service_key: Option<String>,
    pub usage_amount: Option<Decimal>,
    pub usage_unit: String,
    pub meter_reading: Option<Decimal>,
    pub notes: String,
    pub base_currency: String,
    pub household_timezone: String,
}

#[derive(Debug, Clone)]
pub struct CreatedUtilityRecord {
    pub id: Uuid,
    pub name: String,
}

#[derive(Debug, Clone)]
struct Subject {
    id: Uuid,
    kind: &'static str,
    name: String,
    group_type: String,
    started_on: Option<NaiveDate>,
    ended_on: Option<NaiveDate>,
    notes: String,
    fields: Vec<TrackedFieldRecord>,
}

#[derive(Debug)]
struct PropertySubjectRow {
    id: Uuid,
    name: String,
    utility_group_type: String,
    started_on: Option<NaiveDate>,
    ended_on: Option<NaiveDate>,
    notes: String,
}

#[derive(Debug)]
struct GroupSubjectRow {
    id: Uuid,
    name: String,
    group_type: String,
    started_on: Option<NaiveDate>,
    ended_on: Option<NaiveDate>,
    notes: String,
    tracked_fields: Value,
}

#[derive(Debug, Clone)]
struct ServiceRow {
    color: Option<String>,
    retired: bool,
    hidden: bool,
    has_data: bool,
    id: Uuid,
    service_key: String,
    label: String,
    service_kind: String,
    unit: String,
    entry_mode: String,
    unit_rate: Option<Decimal>,
}

#[derive(Debug)]
struct BillRow {
    id: Uuid,
    source_key: Option<String>,
    amount_source: String,
    utility_contract_id: Option<Uuid>,
    reading_id: Option<Uuid>,
    unit_rate: Option<Decimal>,
    entry_mode: Option<String>,
    charge_date: NaiveDate,
    amount: Decimal,
    service_key: String,
    unit: String,
    meter_reading: Option<Decimal>,
    usage_amount: Option<Decimal>,
}

#[derive(Debug, thiserror::Error)]
pub enum UtilityStoreError {
    #[error("database error")]
    Database(#[from] sqlx::Error),
    #[error("not found")]
    NotFound,
    #[error("{0}")]
    Validation(String),
}

pub async fn field_catalog(
    pool: &PgPool,
    household_id: Uuid,
) -> Result<Vec<TrackedFieldRecord>, UtilityStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let fields = load_services(&mut transaction, household_id)
        .await?
        .into_iter()
        .map(service_field)
        .collect();
    transaction.commit().await?;
    Ok(fields)
}

pub async fn reorder_fields(
    pool: &PgPool,
    household_id: Uuid,
    actor: Uuid,
    keys: Vec<String>,
) -> Result<Vec<TrackedFieldRecord>, UtilityStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let services = load_services(&mut transaction, household_id).await?;
    let supplied = keys.iter().collect::<std::collections::BTreeSet<_>>();
    if keys.len() != services.len()
        || supplied.len() != keys.len()
        || services
            .iter()
            .any(|service| !supplied.contains(&service.service_key))
    {
        return Err(UtilityStoreError::Validation(
            "Keys must be an exact permutation of the utility catalog.".to_owned(),
        ));
    }
    let old_keys = services
        .iter()
        .map(|service| &service.service_key)
        .collect::<Vec<_>>();
    sqlx::query!(
        "UPDATE utility_services s SET sort_order = requested.position - 1, updated_at = now()
         FROM unnest($2::text[]) WITH ORDINALITY AS requested(key, position)
         WHERE s.household_id = $1 AND s.service_key = requested.key",
        household_id,
        &keys
    )
    .execute(&mut *transaction)
    .await?;
    let payload = json!({"old_keys": old_keys, "keys": keys});
    sqlx::query!(
        "INSERT INTO audit_events (household_id,actor_user_id,event_type,resource_type,resource_id,payload)
         VALUES ($1,$2,'utility_fields_reordered','household',$1,$3)",
        household_id,
        actor,
        payload
    )
    .execute(&mut *transaction)
    .await?;
    let fields = load_services(&mut transaction, household_id)
        .await?
        .into_iter()
        .map(service_field)
        .collect();
    transaction.commit().await?;
    Ok(fields)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UtilityConfigInput {
    /// Missing preserves the saved color; explicit null clears it.
    #[serde(
        default,
        deserialize_with = "deserialize_color_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub color: Option<Option<String>>,
    pub label: String,
    #[serde(default)]
    pub kind: String,
    pub unit: String,
    pub entry_mode: String,
    #[serde(default, with = "rust_decimal::serde::float_option")]
    pub unit_rate: Option<Decimal>,
}

fn deserialize_color_update<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

pub(crate) fn valid_color(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}

#[derive(Debug, Clone, Serialize)]
pub struct UtilityConfigAudit {
    pub id: Uuid,
    pub actor_user_id: Option<Uuid>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub old_config: Value,
    pub new_config: Value,
}

pub async fn configure(
    pool: &PgPool,
    household_id: Uuid,
    actor: Uuid,
    key: Option<&str>,
    input: UtilityConfigInput,
    create: bool,
) -> Result<TrackedFieldRecord, UtilityStoreError> {
    if let Some(key) = key {
        if key.trim().is_empty()
            || (create
                && (key.bytes().next().is_none_or(|c| !c.is_ascii_lowercase())
                    || !key
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
                    || normalize_service_key(key) != key))
        {
            return Err(UtilityStoreError::Validation(
                "Invalid utility configuration.".to_owned(),
            ));
        }
    } else if !create {
        return Err(UtilityStoreError::Validation(
            "Utility key required for updates.".to_owned(),
        ));
    }
    if input
        .color
        .as_ref()
        .and_then(Option::as_ref)
        .is_some_and(|color| !valid_color(color))
        || input.label.trim().is_empty()
        || (!input.kind.is_empty() && !["cost", "metered"].contains(&input.kind.as_str()))
        || !["meter", "usage"].contains(&input.entry_mode.as_str())
        || input
            .unit_rate
            .is_some_and(|rate| rate.is_sign_negative() || rate.scale() > 6)
        || (input.unit_rate.is_some() && input.unit.trim().is_empty())
    {
        return Err(UtilityStoreError::Validation(
            "Invalid utility configuration.".to_owned(),
        ));
    }
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let services = load_services(&mut transaction, household_id).await?;
    let key = match key {
        Some(key) => key.to_owned(),
        None => generated_service_key(&services, &input.label),
    };
    let existing = services
        .into_iter()
        .find(|service| service.service_key == key);
    if create == existing.is_some() {
        return Err(if create {
            UtilityStoreError::Validation("Utility key already exists.".to_owned())
        } else {
            UtilityStoreError::NotFound
        });
    }
    let kind = existing
        .as_ref()
        .map_or_else(
            || {
                if input.kind.is_empty() {
                    "metered"
                } else {
                    &input.kind
                }
            },
            |service| service.service_kind.as_str(),
        )
        .to_owned();
    if kind == "cost" && input.unit_rate.is_some() {
        return Err(UtilityStoreError::Validation(
            "Cost utilities cannot have per-unit rates.".to_owned(),
        ));
    }
    if let Some(existing) = &existing
        && existing.unit != input.unit.trim()
    {
        let used = sqlx::query_scalar!(
            "SELECT EXISTS(SELECT 1 FROM utility_bills b
                WHERE b.household_id=$1 AND b.service_id=$2) AS \"used!\"",
            household_id,
            existing.id
        )
        .fetch_one(&mut *transaction)
        .await?;
        if used {
            return Err(UtilityStoreError::Validation(
                "Unit cannot change after utility history exists; create another utility."
                    .to_owned(),
            ));
        }
    }
    let color = input
        .color
        .unwrap_or_else(|| existing.as_ref().and_then(|service| service.color.clone()));
    let old = existing.map(service_field);
    let row = sqlx::query_as!(ServiceRow,
        "INSERT INTO utility_services (household_id,service_key,label,service_kind,unit,entry_mode,unit_rate,color)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (household_id,service_key) DO UPDATE SET
         label=EXCLUDED.label, service_kind=EXCLUDED.service_kind, unit=EXCLUDED.unit,
         entry_mode=EXCLUDED.entry_mode, unit_rate=EXCLUDED.unit_rate, color=EXCLUDED.color, updated_at=now()
         RETURNING id,service_key,label,service_kind,unit,entry_mode,unit_rate,color,retired,hidden,
          EXISTS(SELECT 1 FROM utility_bills b WHERE b.household_id=utility_services.household_id AND b.service_id=utility_services.id) AS \"has_data!\"",
         household_id,key.as_str(),input.label.trim(),kind,input.unit.trim(),input.entry_mode,input.unit_rate,color)
         .fetch_one(&mut *transaction).await?;
    let resource_id = row.id;
    let field = service_field(row);
    let payload = json!({"old_config":old,"new_config":field});
    sqlx::query!(
        "INSERT INTO audit_events
        (household_id,actor_user_id,event_type,resource_type,resource_id,payload)
        VALUES ($1,$2,'utility_configured','utility_service',$3,$4)",
        household_id,
        actor,
        resource_id,
        payload
    )
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(field)
}

pub async fn config_audit(
    pool: &PgPool,
    household_id: Uuid,
    key: &str,
) -> Result<Vec<UtilityConfigAudit>, UtilityStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let service = load_services(&mut transaction, household_id)
        .await?
        .into_iter()
        .find(|service| service.service_key == key)
        .ok_or(UtilityStoreError::NotFound)?;
    let rows = sqlx::query!(
        "SELECT id,actor_user_id,created_at,payload FROM audit_events
        WHERE household_id=$1 AND resource_type='utility_service' AND resource_id=$2
        ORDER BY created_at DESC,id DESC",
        household_id,
        service.id
    )
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(rows
        .into_iter()
        .map(|row| UtilityConfigAudit {
            id: row.id,
            actor_user_id: row.actor_user_id,
            created_at: row.created_at,
            old_config: row.payload["old_config"].clone(),
            new_config: row.payload["new_config"].clone(),
        })
        .collect())
}

pub async fn board(
    pool: &PgPool,
    household_id: Uuid,
    property_id: Option<Uuid>,
    group_id: Option<Uuid>,
    months: i32,
    current_month: NaiveDate,
    scopes: &[String],
) -> Result<UtilityBoardRecord, UtilityStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let subject = resolve_subject(&mut transaction, household_id, property_id, group_id).await?;
    let response = board_response(
        &mut transaction,
        household_id,
        &subject,
        months,
        current_month,
        scopes,
    )
    .await?;
    transaction.commit().await?;
    Ok(response)
}

pub async fn form(
    pool: &PgPool,
    household_id: Uuid,
    property_id: Option<Uuid>,
    group_id: Option<Uuid>,
    month: String,
    month_start: NaiveDate,
    scopes: &[String],
) -> Result<UtilityEntryFormRecord, UtilityStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let subject = resolve_subject(&mut transaction, household_id, property_id, group_id).await?;
    let mut fields = Vec::with_capacity(subject.fields.len());
    for field in &subject.fields {
        let current = load_bill(
            &mut transaction,
            household_id,
            &subject,
            &field.key,
            month_start,
            scopes,
        )
        .await?;
        if !field_overlaps_month(field, month_start) && current.is_none() {
            continue;
        }
        let previous = previous_bill(
            &mut transaction,
            household_id,
            &subject,
            &field.key,
            month_start,
            scopes,
        )
        .await?;
        let rate = match field.contract_id {
            Some(id) => {
                crate::utility_contracts::rate_for_month(
                    &mut transaction,
                    household_id,
                    id,
                    month_start,
                )
                .await?
            }
            None => field.unit_rate,
        };
        fields.push(UtilityEntryFormFieldRecord {
            contract_id: field.contract_id,
            property_id: field.property_id,
            start_date: field.start_date,
            end_date: field.end_date,
            tracking_mode: field.tracking_mode.clone(),
            amount_source: current.as_ref().map_or_else(
                || {
                    if field.tracking_mode.as_deref() == Some("actual") {
                        "actual"
                    } else {
                        "auto"
                    }
                    .to_owned()
                },
                |bill| bill.amount_source.clone(),
            ),
            color: field.color.clone(),
            key: field.key.clone(),
            label: field.label.clone(),
            kind: field.kind.clone(),
            unit: field.unit.clone(),
            amount: current.as_ref().and_then(|bill| {
                if bill.amount_source == "auto"
                    && field.tracking_mode.as_deref() != Some("fixed")
                    && bill.unit_rate.is_some()
                    && bill.entry_mode.as_deref() == Some("meter")
                    && bill.usage_amount.is_none()
                {
                    None
                } else {
                    Some(bill.amount)
                }
            }),
            meter_reading: current.as_ref().and_then(|bill| bill.meter_reading),
            usage_amount: current.as_ref().and_then(|bill| bill.usage_amount),
            entry_mode: current.as_ref().map_or_else(
                || field.entry_mode.clone(),
                |bill| {
                    bill.entry_mode.clone().unwrap_or_else(|| {
                        if bill.meter_reading.is_none() && bill.usage_amount.is_some() {
                            "usage"
                        } else {
                            "meter"
                        }
                        .to_owned()
                    })
                },
            ),
            unit_rate: rate,
            previous_amount: previous.as_ref().map(|bill| bill.amount),
            previous_meter_reading: previous.as_ref().and_then(|bill| bill.meter_reading),
            previous_usage: previous.and_then(|bill| bill.usage_amount),
        });
    }
    let completed = month_completed(&mut transaction, household_id, &subject, month_start).await?;
    transaction.commit().await?;
    Ok(UtilityEntryFormRecord {
        month,
        completed,
        fields,
    })
}

/// Links a catalog field to a property so it shows up on its utilities
/// board/form without requiring a real bill entry yet. Also materializes
/// any still-implicit default fields (see `DEFAULT_PROPERTY_FIELDS`) as
/// explicit links, so adding one doesn't leave the others silently unset.
pub async fn track_field(
    pool: &PgPool,
    household_id: Uuid,
    property_id: Uuid,
    field_key: &str,
    months: i32,
    current_month: NaiveDate,
    scopes: &[String],
) -> Result<UtilityBoardRecord, UtilityStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let subject = property_subject(&mut transaction, household_id, property_id).await?;
    let services = load_services(&mut transaction, household_id).await?;
    let Some(service) = services
        .iter()
        .find(|service| service.service_key == field_key)
    else {
        return Err(UtilityStoreError::NotFound);
    };
    for field in &subject.fields {
        if let Some(existing) = services
            .iter()
            .find(|service| service.service_key == field.key)
        {
            ensure_subject_service(&mut transaction, household_id, &subject, existing.id).await?;
        }
    }
    ensure_subject_service(&mut transaction, household_id, &subject, service.id).await?;
    let refreshed = property_subject(&mut transaction, household_id, property_id).await?;
    let response = board_response(
        &mut transaction,
        household_id,
        &refreshed,
        months,
        current_month,
        scopes,
    )
    .await?;
    transaction.commit().await?;
    Ok(response)
}

/// Unlinks a field from a property without touching any bills already
/// recorded for it. Materializes the property's other currently-tracked
/// fields (including any still-implicit defaults) as explicit links first,
/// so removing the last default field doesn't fall back to re-showing all
/// of `DEFAULT_PROPERTY_FIELDS` again.
pub async fn untrack_field(
    pool: &PgPool,
    household_id: Uuid,
    property_id: Uuid,
    field_key: &str,
    months: i32,
    current_month: NaiveDate,
    scopes: &[String],
) -> Result<UtilityBoardRecord, UtilityStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let subject = property_subject(&mut transaction, household_id, property_id).await?;
    if !subject.fields.iter().any(|field| field.key == field_key) {
        return Err(UtilityStoreError::NotFound);
    }
    let services = load_services(&mut transaction, household_id).await?;
    for field in &subject.fields {
        if field.key == field_key {
            continue;
        }
        if let Some(existing) = services
            .iter()
            .find(|service| service.service_key == field.key)
        {
            ensure_subject_service(&mut transaction, household_id, &subject, existing.id).await?;
        }
    }
    if let Some(service) = services
        .iter()
        .find(|service| service.service_key == field_key)
    {
        sqlx::query!(
            "DELETE FROM utility_subject_services
             WHERE household_id = $1 AND property_id = $2 AND service_id = $3",
            household_id,
            property_id,
            service.id
        )
        .execute(&mut *transaction)
        .await?;
    }
    let refreshed = property_subject(&mut transaction, household_id, property_id).await?;
    let response = board_response(
        &mut transaction,
        household_id,
        &refreshed,
        months,
        current_month,
        scopes,
    )
    .await?;
    transaction.commit().await?;
    Ok(response)
}

pub async fn upsert(
    pool: &PgPool,
    household_id: Uuid,
    property_id: Option<Uuid>,
    group_id: Option<Uuid>,
    input: UtilityUpsertInput,
    current_month: NaiveDate,
    scopes: &[String],
) -> Result<UtilityBoardRecord, UtilityStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    if property_id.is_none() || group_id.is_some() {
        return Err(UtilityStoreError::Validation(
            "Select a property utility contract.".to_owned(),
        ));
    }
    let subject = resolve_subject(&mut transaction, household_id, property_id, None).await?;
    let services = load_services(&mut transaction, household_id).await?;
    let locked = month_completed(&mut transaction, household_id, &subject, input.month_start)
        .await?
        && input.completed != Some(false);
    for mut entry in input.entries {
        let field = subject
            .fields
            .iter()
            .find(|field| field.key == entry.field_key)
            .ok_or_else(|| {
                UtilityStoreError::Validation(
                    "Utility contract does not belong to this property.".to_owned(),
                )
            })?;
        let key = field.key.clone();
        let service = services
            .iter()
            .find(|service| service.service_key == key)
            .ok_or(UtilityStoreError::NotFound)?;
        let contract_id = field.contract_id.ok_or_else(|| {
            UtilityStoreError::Validation("A property utility contract is required.".to_owned())
        })?;
        let existing = load_bill(
            &mut transaction,
            household_id,
            &subject,
            &key,
            input.month_start,
            scopes,
        )
        .await?;
        if existing
            .as_ref()
            .is_some_and(|bill| bill.utility_contract_id.is_some_and(|id| id != contract_id))
        {
            return Err(UtilityStoreError::Validation(
                "Utility bill ownership cannot be changed.".to_owned(),
            ));
        }
        if locked {
            if !entry_matches_bill(&entry, existing.as_ref()) {
                return Err(completed_edit_error());
            }
            continue;
        }
        if !field_overlaps_month(field, input.month_start) {
            return Err(UtilityStoreError::Validation(
                "The month is outside the utility contract dates.".to_owned(),
            ));
        }
        let source_key = existing.as_ref().map_or_else(
            || format!("app_manual:utility:{}:{}:{}", subject.id, input.month, key),
            |bill| {
                bill.source_key
                    .clone()
                    .unwrap_or_else(|| format!("app_manual:utility:{}", bill.id))
            },
        );
        let tracking = field.tracking_mode.as_deref().unwrap_or("actual");
        let rate = crate::utility_contracts::rate_for_month(
            &mut transaction,
            household_id,
            contract_id,
            input.month_start,
        )
        .await?;
        let mode = if tracking == "usage" {
            "usage"
        } else {
            "meter"
        };
        let amount_source = match entry.amount_source.as_deref() {
            Some("actual") => "actual",
            Some("auto") if tracking != "actual" => "auto",
            Some(_) => {
                return Err(UtilityStoreError::Validation(
                    "Invalid utility amount source.".to_owned(),
                ));
            }
            None if entry.amount.is_some() => "actual",
            None => existing.as_ref().map_or(
                if tracking == "actual" {
                    "actual"
                } else {
                    "auto"
                },
                |bill| bill.amount_source.as_str(),
            ),
        };
        if [entry.amount, entry.meter_reading, entry.usage_amount]
            .into_iter()
            .flatten()
            .any(|value| value.is_sign_negative() || value.scale() > 4)
        {
            return Err(UtilityStoreError::Validation(
                "Utility values must be non-negative with at most four decimals.".to_owned(),
            ));
        }
        if (tracking == "meter" && entry.usage_amount.is_some())
            || (tracking == "usage" && entry.meter_reading.is_some())
            || ((tracking == "fixed" || tracking == "actual")
                && (entry.meter_reading.is_some() || entry.usage_amount.is_some()))
        {
            return Err(UtilityStoreError::Validation(
                "Supply only the contract's configured tracking input.".to_owned(),
            ));
        }
        if entry.amount_source.is_some()
            && entry.meter_reading.is_none()
            && entry.usage_amount.is_none()
            && let Some(bill) = &existing
        {
            entry.meter_reading = bill.meter_reading;
            if tracking == "usage" {
                entry.usage_amount = bill.usage_amount;
            }
        }
        if entry.amount.is_none()
            && entry.meter_reading.is_none()
            && entry.usage_amount.is_none()
            && !(amount_source == "auto" && tracking == "fixed")
            && entry.amount_source.as_deref() != Some("auto")
        {
            if existing.is_some() {
                return Err(UtilityStoreError::Validation(
                    "Utility history cannot be cleared; enter a correction.".to_owned(),
                ));
            }
            continue;
        }
        let previous = previous_bill(
            &mut transaction,
            household_id,
            &subject,
            &key,
            input.month_start,
            scopes,
        )
        .await?;
        let usage = if mode == "usage" {
            entry.usage_amount
        } else {
            entry
                .meter_reading
                .map(|reading| {
                    checkbook_domain::utilities::meter_usage(
                        reading,
                        previous.as_ref().and_then(|bill| bill.meter_reading),
                    )
                })
                .transpose()
                .map_err(|error| UtilityStoreError::Validation(error.to_string()))?
                .flatten()
        };
        let amount = if amount_source == "actual" {
            entry
                .amount
                .or_else(|| {
                    existing
                        .as_ref()
                        .filter(|bill| bill.amount_source == "actual")
                        .map(|bill| bill.amount)
                })
                .ok_or_else(|| {
                    UtilityStoreError::Validation("An actual bill amount is required.".to_owned())
                })?
        } else if tracking == "fixed" {
            rate.ok_or_else(|| {
                UtilityStoreError::Validation("No price applies to this month.".to_owned())
            })?
        } else {
            let rate = rate.ok_or_else(|| {
                UtilityStoreError::Validation("No price applies to this month.".to_owned())
            })?;
            checkbook_domain::utilities::utility_charge(usage, rate)
                .map_err(|error| UtilityStoreError::Validation(error.to_string()))?
                .unwrap_or_default()
        };
        let extra_payload = json!({ "subject_name": subject.name.clone(), "field_key": key });
        let bill_id: Uuid = if let Some(bill) = &existing {
            sqlx::query!("UPDATE utility_bills SET amount=$3,updated_at=now() WHERE household_id=$1 AND id=$2", household_id,bill.id,amount).execute(&mut *transaction).await?;
            bill.id
        } else {
            sqlx::query_scalar!(
                "INSERT INTO utility_bills
                (household_id, property_id, contract_id, service_id, provider,
                 description, amount, currency, charge_date, owner_scope,
                 data_source, source_key, extra_payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'joint',
                     'app_manual', $10, $11)
             RETURNING id",
                household_id,
                (subject.kind == "property").then_some(subject.id),
                (subject.kind == "contract").then_some(subject.id),
                service.id,
                &subject.name,
                &service.label,
                amount,
                &input.base_currency,
                input.month_start,
                source_key,
                &extra_payload
            )
            .fetch_one(&mut *transaction)
            .await?
        };
        sqlx::query!(
            "UPDATE utility_bills SET unit_rate=$3,entry_mode=$4,usage_amount=$5,amount_source=$6,utility_contract_id=$7
            WHERE household_id=$1 AND id=$2",
            household_id,
            bill_id,
            rate,
            mode,
            usage,
            amount_source,
            contract_id
        )
        .execute(&mut *transaction)
        .await?;
        match entry.meter_reading {
            Some(reading) => {
                let previous_id = previous.and_then(|bill| bill.reading_id);
                sqlx::query!(
                    "INSERT INTO utility_meter_readings
                        (household_id, utility_bill_id, previous_reading_id,
                         reading, usage_amount, unit)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (household_id, utility_bill_id)
                     DO UPDATE SET previous_reading_id = EXCLUDED.previous_reading_id,
                                   reading = EXCLUDED.reading,
                                   usage_amount = EXCLUDED.usage_amount,
                                   unit = EXCLUDED.unit,
                                   updated_at = now()",
                    household_id,
                    bill_id,
                    previous_id,
                    reading,
                    usage,
                    service.unit
                )
                .execute(&mut *transaction)
                .await?;
            }
            None => {
                sqlx::query!(
                    "DELETE FROM utility_meter_readings
                     WHERE household_id = $1 AND utility_bill_id = $2",
                    household_id,
                    bill_id
                )
                .execute(&mut *transaction)
                .await?;
            }
        }
        recalculate_readings(&mut transaction, household_id, &subject, service.id).await?;
    }
    if let Some(completed) = input.completed {
        sqlx::query!(
            "INSERT INTO utility_months (household_id,property_id,contract_id,period,completed)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (household_id,property_id,contract_id,period)
             DO UPDATE SET completed=EXCLUDED.completed,updated_at=now()",
            household_id,
            (subject.kind == "property").then_some(subject.id),
            (subject.kind == "contract").then_some(subject.id),
            input.month_start,
            completed
        )
        .execute(&mut *transaction)
        .await?;
    }
    let response = board_response(
        &mut transaction,
        household_id,
        &subject,
        12,
        current_month,
        scopes,
    )
    .await?;
    materialize_after_write(&mut transaction, household_id, &input.household_timezone).await?;
    transaction.commit().await?;
    Ok(response)
}

pub async fn reassign(
    pool: &PgPool,
    household_id: Uuid,
    from_property_id: Uuid,
    to_property_id: Uuid,
    scopes: &[String],
    household_timezone: &str,
) -> Result<i64, UtilityStoreError> {
    let _ = (
        pool,
        household_id,
        from_property_id,
        to_property_id,
        scopes,
        household_timezone,
    );
    Err(UtilityStoreError::Validation(
        "Utility contract property ownership cannot be changed.".to_owned(),
    ))
}

pub async fn create_manual(
    pool: &PgPool,
    household_id: Uuid,
    input: ManualUtilityInput,
) -> Result<CreatedUtilityRecord, UtilityStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    if input.property_id.is_none() || input.group_id.is_some() {
        return Err(UtilityStoreError::Validation(
            "Select a property utility contract.".to_owned(),
        ));
    }
    let subject = resolve_subject(
        &mut transaction,
        household_id,
        input.property_id,
        input.group_id,
    )
    .await?;
    let period = input
        .charge_date
        .with_day(1)
        .ok_or_else(|| UtilityStoreError::Validation("Invalid utility date.".to_owned()))?;
    if month_completed(&mut transaction, household_id, &subject, period).await? {
        return Err(completed_edit_error());
    }
    let key = input.service_key.as_deref().ok_or_else(|| {
        UtilityStoreError::Validation("Select a property utility contract.".to_owned())
    })?;
    let field = subject
        .fields
        .iter()
        .find(|field| field.key == key)
        .ok_or_else(|| {
            UtilityStoreError::Validation(
                "Utility contract does not belong to this property.".to_owned(),
            )
        })?;
    if !field_overlaps_month(field, period) {
        return Err(UtilityStoreError::Validation(
            "The month is outside the utility contract dates.".to_owned(),
        ));
    }
    let contract_id = field.contract_id.ok_or(UtilityStoreError::NotFound)?;
    let services = load_services(&mut transaction, household_id).await?;
    let service = services
        .iter()
        .find(|service| service.service_key == key)
        .ok_or(UtilityStoreError::NotFound)?;
    let bill_id: Uuid = sqlx::query_scalar!(
        "INSERT INTO utility_bills
            (household_id, property_id, contract_id, service_id, provider,
             description, amount, currency, charge_date, owner_scope,
             data_source, notes, source_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 'app_manual', $11, $12)
         RETURNING id",
        household_id,
        (subject.kind == "property").then_some(subject.id),
        (subject.kind == "contract").then_some(subject.id),
        service.id,
        input.provider,
        input.description.trim(),
        input.amount,
        input.base_currency,
        input.charge_date,
        input.owner_scope,
        input.notes,
        format!("app_manual:utility:{}", Uuid::now_v7())
    )
    .fetch_one(&mut *transaction)
    .await?;
    sqlx::query!("UPDATE utility_bills SET amount_source='actual',utility_contract_id=$3,usage_amount=$4 WHERE household_id=$1 AND id=$2",
        household_id,bill_id,contract_id,input.usage_amount).execute(&mut *transaction).await?;
    if let Some(reading) = input.meter_reading {
        sqlx::query!(
            "INSERT INTO utility_meter_readings
                (household_id, utility_bill_id, reading, usage_amount, unit)
             VALUES ($1, $2, $3, $4, $5)",
            household_id,
            bill_id,
            reading,
            input.usage_amount,
            input.usage_unit
        )
        .execute(&mut *transaction)
        .await?;
    }
    materialize_after_write(&mut transaction, household_id, &input.household_timezone).await?;
    transaction.commit().await?;
    Ok(CreatedUtilityRecord {
        id: bill_id,
        name: input.description,
    })
}

async fn resolve_subject(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    property_id: Option<Uuid>,
    group_id: Option<Uuid>,
) -> Result<Subject, UtilityStoreError> {
    if let Some(property_id) = property_id {
        return property_subject(transaction, household_id, property_id).await;
    }
    if let Some(group_id) = group_id {
        return group_subject(transaction, household_id, group_id).await;
    }
    let property_id = sqlx::query_scalar!(
        "SELECT id FROM properties WHERE household_id = $1 ORDER BY created_at LIMIT 1",
        household_id
    )
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(UtilityStoreError::NotFound)?;
    property_subject(transaction, household_id, property_id).await
}

async fn property_subject(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    property_id: Uuid,
) -> Result<Subject, UtilityStoreError> {
    let row = sqlx::query_as!(
        PropertySubjectRow,
        "SELECT id, name, utility_group_type, started_on, ended_on, notes
         FROM properties WHERE household_id = $1 AND id = $2",
        household_id,
        property_id
    )
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(UtilityStoreError::NotFound)?;
    let today = sqlx::query_scalar!(
        r#"SELECT (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date AS "today!" FROM households WHERE id=$1"#,
        household_id
    ).fetch_one(&mut **transaction).await?;
    let contracts = crate::utility_contracts::list_in_transaction(
        transaction,
        household_id,
        property_id,
        today,
    )
    .await?;
    let services = load_services(transaction, household_id).await?;
    let mut fields = Vec::with_capacity(contracts.len());
    for contract in contracts {
        if let Some(service) = services
            .iter()
            .find(|service| service.service_key == contract.key)
        {
            let mut field = service_field(service.clone());
            field.contract_id = Some(contract.id);
            field.property_id = Some(contract.property_id);
            field.start_date = Some(contract.start_date);
            field.end_date = contract.end_date;
            field.tracking_mode = Some(contract.tracking_mode);
            field.retired = contract.retired;
            fields.push(field);
        }
    }
    Ok(Subject {
        id: row.id,
        kind: "property",
        name: row.name,
        group_type: row.utility_group_type,
        started_on: row.started_on,
        ended_on: row.ended_on,
        notes: row.notes,
        fields,
    })
}

async fn group_subject(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    group_id: Uuid,
) -> Result<Subject, UtilityStoreError> {
    let row = sqlx::query_as!(
        GroupSubjectRow,
        "SELECT id, name, group_type, started_on, ended_on, notes,
                tracked_fields AS \"tracked_fields: Value\"
         FROM entry_groups
         WHERE household_id = $1 AND id = $2 AND kind = 'contract'",
        household_id,
        group_id
    )
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(UtilityStoreError::NotFound)?;
    let legacy_fields = serde_json::from_value::<Vec<TrackedFieldRecord>>(row.tracked_fields)
        .map_err(|_| UtilityStoreError::Validation("Invalid tracked fields.".to_owned()))?;
    let services = load_services(transaction, household_id).await?;
    let mut fields = subject_fields(transaction, household_id, None, Some(group_id)).await?;
    for legacy in legacy_fields {
        if !fields.iter().any(|field| field.key == legacy.key)
            && let Some(service) = services
                .iter()
                .find(|service| service.service_key == legacy.key)
        {
            fields.push(service_field(service.clone()));
        }
    }
    fields.sort_by_key(|field| {
        services
            .iter()
            .position(|service| service.service_key == field.key)
    });
    Ok(Subject {
        id: row.id,
        kind: "contract",
        name: row.name,
        group_type: row.group_type,
        started_on: row.started_on,
        ended_on: row.ended_on,
        notes: row.notes,
        fields,
    })
}

async fn subject_fields(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    property_id: Option<Uuid>,
    contract_id: Option<Uuid>,
) -> Result<Vec<TrackedFieldRecord>, UtilityStoreError> {
    Ok(sqlx::query_as!(
        ServiceRow,
        "SELECT s.id, s.service_key, s.label, s.service_kind, s.unit, s.entry_mode, s.unit_rate, s.color, s.retired, s.hidden,
                EXISTS(SELECT 1 FROM utility_bills b WHERE b.household_id=s.household_id AND b.service_id=s.id) AS \"has_data!\"
         FROM utility_services s
         LEFT JOIN utility_subject_services ss
           ON ss.household_id=s.household_id AND ss.service_id=s.id
             AND ss.property_id IS NOT DISTINCT FROM $2
             AND ss.contract_id IS NOT DISTINCT FROM $3
         WHERE s.household_id = $1 AND (
           ss.service_id IS NOT NULL
           OR EXISTS(SELECT 1 FROM utility_bills b
             WHERE b.household_id=s.household_id AND b.service_id=s.id
               AND b.property_id IS NOT DISTINCT FROM $2
               AND b.contract_id IS NOT DISTINCT FROM $3))
         ORDER BY s.retired, s.sort_order, s.label, s.service_key",
        household_id,
        property_id,
        contract_id
    )
    .fetch_all(&mut **transaction)
    .await?
    .into_iter()
    .map(service_field)
    .collect())
}

async fn board_response(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    subject: &Subject,
    months: i32,
    current_month: NaiveDate,
    scopes: &[String],
) -> Result<UtilityBoardRecord, UtilityStoreError> {
    let bills = subject_bills(transaction, household_id, subject, scopes).await?;
    let completed_periods = sqlx::query_scalar!(
        "SELECT period FROM utility_months WHERE household_id=$1
         AND property_id IS NOT DISTINCT FROM $2 AND contract_id IS NOT DISTINCT FROM $3
         AND completed",
        household_id,
        (subject.kind == "property").then_some(subject.id),
        (subject.kind == "contract").then_some(subject.id)
    )
    .fetch_all(&mut **transaction)
    .await?
    .into_iter()
    .map(|period| period.format("%Y-%m").to_string())
    .collect::<std::collections::BTreeSet<_>>();
    let periods = if months > 0 {
        let count = u32::try_from(months).map_err(|_| {
            UtilityStoreError::Validation("Months must be non-negative.".to_owned())
        })?;
        (0..count)
            .rev()
            .map(|offset| {
                current_month
                    .checked_sub_months(Months::new(offset))
                    .unwrap_or(current_month)
                    .format("%Y-%m")
                    .to_string()
            })
            .collect::<Vec<_>>()
    } else {
        let mut periods = bills
            .iter()
            .map(|bill| bill.charge_date.format("%Y-%m").to_string())
            .collect::<Vec<_>>();
        periods.extend(completed_periods.iter().cloned());
        periods.sort();
        periods.dedup();
        if periods.is_empty() {
            periods.push(current_month.format("%Y-%m").to_string());
        }
        periods
    };
    let mut month_rows = periods
        .iter()
        .map(|period| {
            (
                period.clone(),
                UtilityBoardMonthRecord {
                    month: period.clone(),
                    completed: completed_periods.contains(period),
                    values: BTreeMap::new(),
                    total: Decimal::ZERO,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut trend = BTreeMap::<String, UtilitySeriesPointRecord>::new();
    for bill in bills {
        let period = bill.charge_date.format("%Y-%m").to_string();
        let trend_row = trend
            .entry(period.clone())
            .or_insert_with(|| UtilitySeriesPointRecord {
                period: period.clone(),
                values: BTreeMap::new(),
                usage: BTreeMap::new(),
                units: BTreeMap::new(),
                total: Decimal::ZERO,
            });
        *trend_row
            .values
            .entry(bill.service_key.clone())
            .or_default() += bill.amount;
        trend_row.total += bill.amount;
        if let Some(usage) = bill.usage_amount {
            *trend_row.usage.entry(bill.service_key.clone()).or_default() += usage;
        }
        if !bill.unit.is_empty() {
            trend_row
                .units
                .insert(bill.service_key.clone(), bill.unit.clone());
        }
        if let Some(month_row) = month_rows.get_mut(&period) {
            let state = month_row
                .values
                .entry(bill.service_key)
                .or_insert_with(UtilityFieldStateRecord::default);
            if !(bill.amount_source == "auto"
                && bill.meter_reading.is_some()
                && bill.unit_rate.is_some()
                && bill.entry_mode.as_deref() == Some("meter")
                && bill.usage_amount.is_none())
            {
                state.amount = Some(state.amount.unwrap_or_default() + bill.amount);
            }
            state.meter_reading = bill.meter_reading.or(state.meter_reading);
            if let Some(usage) = bill.usage_amount {
                state.usage_amount = Some(state.usage_amount.unwrap_or_default() + usage);
            }
            month_row.total += bill.amount;
        }
    }
    Ok(UtilityBoardRecord {
        subject: UtilityBoardSubjectRecord {
            id: subject.id,
            kind: subject.kind.to_owned(),
            name: subject.name.clone(),
            group_type: subject.group_type.clone(),
            started_on: subject.started_on,
            ended_on: subject.ended_on,
            notes: subject.notes.clone(),
            tracked_fields: subject.fields.clone(),
        },
        trend: trend.into_values().collect(),
        months: month_rows.into_values().collect(),
    })
}

async fn subject_bills(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    subject: &Subject,
    scopes: &[String],
) -> Result<Vec<BillRow>, sqlx::Error> {
    sqlx::query_as!(
        BillRow,
        "SELECT b.id,b.source_key,b.amount_source,b.utility_contract_id,b.unit_rate, b.entry_mode, r.id AS \"reading_id?\", b.charge_date, b.amount, s.service_key, s.unit,
                r.reading AS \"meter_reading?\", COALESCE(r.usage_amount, b.usage_amount) AS \"usage_amount?\"
         FROM utility_bills b
         JOIN utility_services s
           ON s.household_id = b.household_id AND s.id = b.service_id
         LEFT JOIN utility_meter_readings r
           ON r.household_id = b.household_id AND r.utility_bill_id = b.id
         WHERE b.household_id = $1
           AND (($2 = 'property' AND b.property_id = $3)
             OR ($2 = 'contract' AND b.contract_id = $3))
           AND b.owner_scope = ANY($4)
         ORDER BY b.charge_date, s.service_key",
        household_id,
        subject.kind,
        subject.id,
        scopes
    )
    .fetch_all(&mut **transaction)
    .await
}

async fn load_bill(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    subject: &Subject,
    service_key: &str,
    month: NaiveDate,
    scopes: &[String],
) -> Result<Option<BillRow>, sqlx::Error> {
    sqlx::query_as!(
        BillRow,
        "SELECT b.id,b.source_key,b.amount_source,b.utility_contract_id,b.unit_rate, b.entry_mode, r.id AS \"reading_id?\", b.charge_date, b.amount, s.service_key, s.unit,
                r.reading AS \"meter_reading?\", COALESCE(r.usage_amount, b.usage_amount) AS \"usage_amount?\"
         FROM utility_bills b
         JOIN utility_services s
           ON s.household_id = b.household_id AND s.id = b.service_id
         LEFT JOIN utility_meter_readings r
           ON r.household_id = b.household_id AND r.utility_bill_id = b.id
         WHERE b.household_id = $1 AND s.service_key = $2
           AND b.charge_date = $3
           AND (($4 = 'property' AND b.property_id = $5)
             OR ($4 = 'contract' AND b.contract_id = $5))
           AND b.owner_scope = ANY($6)
         LIMIT 1",
        household_id,
        service_key,
        month,
        subject.kind,
        subject.id,
        scopes
    )
    .fetch_optional(&mut **transaction)
    .await
}

async fn previous_bill(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    subject: &Subject,
    service_key: &str,
    before: NaiveDate,
    scopes: &[String],
) -> Result<Option<BillRow>, sqlx::Error> {
    sqlx::query_as!(
        BillRow,
        "SELECT b.id,b.source_key,b.amount_source,b.utility_contract_id,b.unit_rate, b.entry_mode, r.id AS \"reading_id?\", b.charge_date, b.amount, s.service_key, s.unit,
                r.reading AS \"meter_reading?\", COALESCE(r.usage_amount, b.usage_amount) AS \"usage_amount?\"
         FROM utility_bills b
         JOIN utility_services s
           ON s.household_id = b.household_id AND s.id = b.service_id
         LEFT JOIN utility_meter_readings r
           ON r.household_id = b.household_id AND r.utility_bill_id = b.id
         WHERE b.household_id = $1 AND s.service_key = $2
           AND b.charge_date < $3
           AND (($4 = 'property' AND b.property_id = $5)
             OR ($4 = 'contract' AND b.contract_id = $5))
           AND b.owner_scope = ANY($6)
         ORDER BY b.charge_date DESC
         LIMIT 1",
        household_id,
        service_key,
        before,
        subject.kind,
        subject.id,
        scopes
    )
    .fetch_optional(&mut **transaction)
    .await
}

async fn load_services(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
) -> Result<Vec<ServiceRow>, sqlx::Error> {
    sqlx::query_as!(
        ServiceRow,
        "SELECT id, service_key, label, service_kind, unit, entry_mode, unit_rate, color, retired, hidden,
                EXISTS(SELECT 1 FROM utility_bills b WHERE b.household_id=utility_services.household_id AND b.service_id=utility_services.id) AS \"has_data!\"
         FROM utility_services
         WHERE household_id = $1
         ORDER BY retired, sort_order, label, service_key",
        household_id
    )
    .fetch_all(&mut **transaction)
    .await
}

async fn ensure_subject_service(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    subject: &Subject,
    service_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "INSERT INTO utility_subject_services
            (household_id, property_id, contract_id, service_id, sort_order)
         VALUES ($1, $2, $3, $4, 0)
         ON CONFLICT DO NOTHING",
        household_id,
        (subject.kind == "property").then_some(subject.id),
        (subject.kind == "contract").then_some(subject.id),
        service_id
    )
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn materialize_after_write(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    timezone: &str,
) -> Result<(), UtilityStoreError> {
    let current_month = month_start_at(timezone, chrono::Utc::now())
        .map_err(|error| UtilityStoreError::Validation(format!("invalid timezone: {error}")))?;
    materialize_household_in_transaction(transaction, household_id, current_month)
        .await
        .map_err(|error| {
            UtilityStoreError::Validation(format!(
                "planning materialization after utility write failed: {error}"
            ))
        })
        .map(|_| ())
}

fn service_field(service: ServiceRow) -> TrackedFieldRecord {
    TrackedFieldRecord {
        contract_id: None,
        property_id: None,
        start_date: None,
        end_date: None,
        tracking_mode: None,
        color: service.color,
        retired: service.retired,
        hidden: service.hidden,
        has_data: service.has_data,
        key: service.service_key,
        label: service.label,
        kind: service.service_kind,
        unit: service.unit,
        entry_mode: service.entry_mode,
        unit_rate: service.unit_rate,
    }
}

fn normalize_service_key(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

/// Derives a household-unique service key from a utility label so callers
/// never have to invent one. Runs inside the household write transaction,
/// whose advisory lock serializes catalog writes, so the loaded catalog
/// cannot change underneath the uniqueness check.
fn generated_service_key(services: &[ServiceRow], label: &str) -> String {
    let slug = normalize_service_key(label);
    let base = if slug.is_empty() {
        "utility".to_owned()
    } else if slug.starts_with(|character: char| character.is_ascii_lowercase()) {
        slug
    } else {
        format!("u_{slug}")
    };
    let taken = services
        .iter()
        .map(|service| service.service_key.as_str())
        .collect::<std::collections::HashSet<_>>();
    if !taken.contains(base.as_str()) {
        return base;
    }
    let mut suffix = 2u32;
    loop {
        let candidate = format!("{base}_{suffix}");
        if !taken.contains(candidate.as_str()) {
            return candidate;
        }
        suffix += 1;
    }
}

fn default_entry_mode() -> String {
    "meter".to_owned()
}

async fn recalculate_readings(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    subject: &Subject,
    service_id: Uuid,
) -> Result<(), UtilityStoreError> {
    let rows = sqlx::query!("SELECT r.id,r.reading,b.id AS bill_id,b.unit_rate,b.entry_mode,b.owner_scope,b.amount_source,b.utility_contract_id,b.charge_date
        FROM utility_meter_readings r JOIN utility_bills b ON b.household_id=r.household_id AND b.id=r.utility_bill_id
        WHERE b.household_id=$1 AND b.service_id=$2
        AND (($3='property' AND b.property_id=$4) OR ($3='contract' AND b.contract_id=$4))
        ORDER BY b.owner_scope,b.charge_date,b.id",household_id,service_id,subject.kind,subject.id)
        .fetch_all(&mut **transaction).await?;
    let mut previous: Option<(Uuid, Decimal, String)> = None;
    for row in rows {
        let prior = previous
            .as_ref()
            .filter(|(_, _, scope)| scope == &row.owner_scope);
        let usage = checkbook_domain::utilities::meter_usage(
            row.reading,
            prior.map(|(_, reading, _)| *reading),
        )
        .map_err(|error| UtilityStoreError::Validation(error.to_string()))?;
        let prior_id = prior.map(|(id, _, _)| *id);
        sqlx::query!("UPDATE utility_meter_readings SET previous_reading_id=$3,usage_amount=$4,updated_at=now()
            WHERE household_id=$1 AND id=$2",household_id,row.id,prior_id,usage).execute(&mut **transaction).await?;
        sqlx::query!(
            "UPDATE utility_bills SET usage_amount=$3 WHERE household_id=$1 AND id=$2",
            household_id,
            row.bill_id,
            usage
        )
        .execute(&mut **transaction)
        .await?;
        let rate = match row.utility_contract_id {
            Some(id) => {
                crate::utility_contracts::rate_for_month(
                    transaction,
                    household_id,
                    id,
                    row.charge_date,
                )
                .await?
            }
            None => row.unit_rate,
        };
        if let Some(rate) = rate.filter(|_| row.amount_source == "auto") {
            let amount = checkbook_domain::utilities::utility_charge(usage, rate)
                .map_err(|error| UtilityStoreError::Validation(error.to_string()))?
                .unwrap_or_default();
            sqlx::query!(
                "UPDATE utility_bills SET amount=$3,usage_amount=$4,unit_rate=$5,updated_at=now()
                WHERE household_id=$1 AND id=$2",
                household_id,
                row.bill_id,
                amount,
                usage,
                rate
            )
            .execute(&mut **transaction)
            .await?;
        }
        previous = Some((row.id, row.reading, row.owner_scope));
    }
    Ok(())
}

async fn month_completed(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    subject: &Subject,
    period: NaiveDate,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar!(
        "SELECT EXISTS(SELECT 1 FROM utility_months WHERE household_id=$1
         AND property_id IS NOT DISTINCT FROM $2 AND contract_id IS NOT DISTINCT FROM $3
         AND period=$4 AND completed) AS \"completed!\"",
        household_id,
        (subject.kind == "property").then_some(subject.id),
        (subject.kind == "contract").then_some(subject.id),
        period
    )
    .fetch_one(&mut **transaction)
    .await
}

fn completed_edit_error() -> UtilityStoreError {
    UtilityStoreError::Validation(
        "Completed utility months must be reopened before editing.".to_owned(),
    )
}

fn entry_matches_bill(entry: &UtilityEntryValueInput, bill: Option<&BillRow>) -> bool {
    let Some(bill) = bill else {
        return entry.amount.is_none()
            && entry.meter_reading.is_none()
            && entry.usage_amount.is_none();
    };
    // Usage and charge derived from a meter reading are not manual inputs.
    let usage = if bill.meter_reading.is_some() {
        None
    } else {
        bill.usage_amount
    };
    let amount = if bill.amount_source == "auto" {
        None
    } else {
        Some(bill.amount)
    };
    entry
        .amount_source
        .as_deref()
        .is_none_or(|source| source == bill.amount_source)
        && entry.amount == amount
        && entry.meter_reading == bill.meter_reading
        && entry.usage_amount == usage
}

pub async fn update_lifecycle(
    pool: &PgPool,
    household_id: Uuid,
    actor: Uuid,
    key: &str,
    retired: bool,
    hidden: bool,
) -> Result<TrackedFieldRecord, UtilityStoreError> {
    if hidden && !retired {
        return Err(UtilityStoreError::Validation(
            "Only retired utilities can be hidden.".to_owned(),
        ));
    }
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let service = load_services(&mut transaction, household_id)
        .await?
        .into_iter()
        .find(|service| service.service_key == key)
        .ok_or(UtilityStoreError::NotFound)?;
    let old = service_field(service.clone());
    sqlx::query!(
        "UPDATE utility_services SET retired=$3,hidden=$4,updated_at=now()
        WHERE household_id=$1 AND id=$2",
        household_id,
        service.id,
        retired,
        hidden
    )
    .execute(&mut *transaction)
    .await?;
    let mut field = old.clone();
    field.retired = retired;
    field.hidden = hidden;
    let payload = json!({"old_config":old,"new_config":field});
    sqlx::query!(
        "INSERT INTO audit_events
        (household_id,actor_user_id,event_type,resource_type,resource_id,payload)
        VALUES ($1,$2,'utility_lifecycle_updated','utility_service',$3,$4)",
        household_id,
        actor,
        service.id,
        payload
    )
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(field)
}

pub async fn delete_service(
    pool: &PgPool,
    household_id: Uuid,
    actor: Uuid,
    key: &str,
) -> Result<(), UtilityStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let service = load_services(&mut transaction, household_id)
        .await?
        .into_iter()
        .find(|service| service.service_key == key)
        .ok_or(UtilityStoreError::NotFound)?;
    if !service.retired || service.has_data {
        return Err(UtilityStoreError::Validation(
            "Only retired utilities without recorded data can be deleted.".to_owned(),
        ));
    }
    sqlx::query!(
        "DELETE FROM utility_subject_services WHERE household_id=$1 AND service_id=$2",
        household_id,
        service.id
    )
    .execute(&mut *transaction)
    .await?;
    sqlx::query!("UPDATE entry_groups SET tracked_fields=(
        SELECT COALESCE(jsonb_agg(field ORDER BY ordinal), '[]'::jsonb)
        FROM jsonb_array_elements(tracked_fields) WITH ORDINALITY AS fields(field,ordinal)
        WHERE field->>'key' IS DISTINCT FROM $2)
        WHERE household_id=$1 AND tracked_fields @> jsonb_build_array(jsonb_build_object('key',$2::text))",household_id,key)
        .execute(&mut *transaction).await?;
    let payload = json!({"old_config":service_field(service.clone()),"new_config":null});
    sqlx::query!(
        "INSERT INTO audit_events
        (household_id,actor_user_id,event_type,resource_type,resource_id,payload)
        VALUES ($1,$2,'utility_deleted','utility_service',$3,$4)",
        household_id,
        actor,
        service.id,
        payload
    )
    .execute(&mut *transaction)
    .await?;
    sqlx::query!(
        "DELETE FROM utility_services WHERE household_id=$1 AND id=$2",
        household_id,
        service.id
    )
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

fn field_overlaps_month(field: &TrackedFieldRecord, month: NaiveDate) -> bool {
    let next = month
        .checked_add_months(Months::new(1))
        .unwrap_or(NaiveDate::MAX);
    field.start_date.is_none_or(|start| start < next)
        && field.end_date.is_none_or(|end| end >= month)
}

#[cfg(test)]
mod color_tests {
    use super::{UtilityConfigInput, valid_color};
    use serde_json::json;

    #[test]
    fn color_accepts_only_six_ascii_hex_digits() {
        for color in ["#000000", "#ffffff", "#ABCDEF", "#aB12Ef"] {
            assert!(valid_color(color));
        }
        for color in [
            "",
            "red",
            "#fff",
            "#1234567",
            "#12345g",
            " #123456",
            "#123456\n",
            "#\u{ff11}23456",
        ] {
            assert!(!valid_color(color));
        }
    }

    #[test]
    fn config_color_roundtrip_preserves_update_intent() -> anyhow::Result<()> {
        let payload = json!({"label":"Water", "unit":"m3", "entry_mode":"meter"});
        for color in [None, Some(None), Some(Some("#aB12Ef".to_owned()))] {
            let mut input: UtilityConfigInput = serde_json::from_value(payload.clone())?;
            assert_eq!(input.color, None);
            input.color = color.clone();
            let restored: UtilityConfigInput =
                serde_json::from_value(serde_json::to_value(input)?)?;
            assert_eq!(restored.color, color);
        }
        Ok(())
    }
}
