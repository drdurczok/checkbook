use checkbook_domain::month_start_at;
use chrono::{Datelike, NaiveDate};
use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{planning::materialize_household_in_transaction, tenant, utilities::UtilityStoreError};

type Result<T> = std::result::Result<T, UtilityStoreError>;

#[derive(Debug, Clone, Serialize)]
pub struct ContractRecord {
    pub color: Option<String>,
    pub id: Uuid,
    pub property_id: Uuid,
    pub key: String,
    pub label: String,
    pub tracking_mode: String,
    pub unit: String,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
    pub retired: bool,
    pub sort_order: i32,
}

#[derive(Debug, Clone)]
pub struct ContractCreate {
    pub color: Option<String>,
    pub property_id: Uuid,
    pub label: String,
    pub tracking_mode: String,
    pub unit: String,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
    pub initial_price: Option<Decimal>,
}

#[derive(Debug, Clone)]
pub struct ContractUpdate {
    pub color: Option<Option<String>>,
    pub label: String,
    pub tracking_mode: String,
    pub unit: String,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
}

/// A full ordering of one property's contracts. The list must name every
/// contract on the property exactly once; the position becomes its sort order.
#[derive(Debug, Clone)]
pub struct ContractReorder {
    pub property_id: Uuid,
    pub ordered_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PriceRecord {
    pub id: Uuid,
    pub effective_on: NaiveDate,
    pub price: Decimal,
}

#[derive(Debug, Clone)]
pub struct PriceInput {
    pub effective_on: NaiveDate,
    pub price: Decimal,
}

pub async fn list(
    pool: &PgPool,
    household_id: Uuid,
    property_id: Uuid,
    today: NaiveDate,
) -> Result<Vec<ContractRecord>> {
    let mut tx = tenant::begin(pool, household_id, true).await?;
    let rows = list_in_transaction(&mut tx, household_id, property_id, today).await?;
    tx.commit().await?;
    Ok(rows)
}

pub async fn list_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    property_id: Uuid,
    today: NaiveDate,
) -> Result<Vec<ContractRecord>> {
    let property = sqlx::query_scalar!(
        "SELECT id FROM properties WHERE household_id=$1 AND id=$2",
        household_id,
        property_id
    )
    .fetch_optional(&mut **tx)
    .await?;
    if property.is_none() {
        return Err(UtilityStoreError::NotFound);
    }
    Ok(sqlx::query_as!(
        ContractRecord,
        r#"SELECT c.id,c.property_id,s.service_key AS key,s.label,s.color,c.tracking_mode,s.unit,
           c.start_date,c.end_date,COALESCE(c.end_date < $3,false) AS "retired!",c.sort_order
           FROM utility_contracts c JOIN utility_services s
             ON s.household_id=c.household_id AND s.id=c.service_id
           WHERE c.household_id=$1 AND c.property_id=$2 ORDER BY c.sort_order,c.start_date,c.id"#,
        household_id,
        property_id,
        today
    )
    .fetch_all(&mut **tx)
    .await?)
}

pub async fn create(
    pool: &PgPool,
    household_id: Uuid,
    actor: Uuid,
    input: ContractCreate,
) -> Result<ContractRecord> {
    if input
        .color
        .as_ref()
        .is_some_and(|color| !crate::utilities::valid_color(color))
    {
        return Err(invalid("Invalid utility color."));
    }
    validate_config(
        &input.label,
        &input.tracking_mode,
        &input.unit,
        input.start_date,
        input.end_date,
    )?;
    if let Some(price) = input.initial_price {
        validate_price(price)?;
    } else if input.tracking_mode != "actual" {
        return Err(invalid(
            "an initial price is required for automatic tracking",
        ));
    }
    let mut tx = tenant::begin(pool, household_id, false).await?;
    let property = sqlx::query_scalar!(
        "SELECT id FROM properties WHERE household_id=$1 AND id=$2",
        household_id,
        input.property_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if property.is_none() {
        return Err(UtilityStoreError::NotFound);
    }
    let id = Uuid::new_v4();
    let key = format!("contract_{}", id.simple());
    let kind = service_kind(&input.tracking_mode);
    let entry_mode = entry_mode(&input.tracking_mode);
    let service_id = sqlx::query_scalar!(
        "INSERT INTO utility_services (household_id,service_key,label,service_kind,unit,entry_mode,unit_rate,color)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        household_id,
        key,
        input.label.trim(),
        kind,
        input.unit.trim(),
        entry_mode,
        input.initial_price,
        input.color
    )
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query!(
        "INSERT INTO utility_contracts
         (id,household_id,property_id,service_id,start_date,end_date,tracking_mode,sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,
           (SELECT COALESCE(MAX(sort_order)+1,0) FROM utility_contracts WHERE household_id=$2 AND property_id=$3))",
        id, household_id, input.property_id, service_id, input.start_date, input.end_date, input.tracking_mode
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "INSERT INTO utility_subject_services (household_id,property_id,service_id,sort_order)
         SELECT household_id,property_id,service_id,sort_order FROM utility_contracts WHERE household_id=$1 AND id=$2",
        household_id, id
    )
    .execute(&mut *tx)
    .await?;
    if let Some(price) = input.initial_price {
        let effective_on = month_start(input.start_date);
        sqlx::query!(
            "INSERT INTO utility_contract_prices (household_id,utility_contract_id,effective_on,price) VALUES ($1,$2,$3,$4)",
            household_id, id, effective_on, price
        )
        .execute(&mut *tx)
        .await?;
    }
    let record = load(&mut tx, household_id, id).await?;
    audit(
        &mut tx,
        household_id,
        actor,
        id,
        "utility_contract_created",
        json!({"after": record}),
    )
    .await?;
    materialize(&mut tx, household_id).await?;
    tx.commit().await?;
    Ok(record)
}

pub async fn update(
    pool: &PgPool,
    household_id: Uuid,
    actor: Uuid,
    id: Uuid,
    input: ContractUpdate,
) -> Result<ContractRecord> {
    if input
        .color
        .as_ref()
        .and_then(Option::as_ref)
        .is_some_and(|color| !crate::utilities::valid_color(color))
    {
        return Err(invalid("Invalid utility color."));
    }
    validate_config(
        &input.label,
        &input.tracking_mode,
        &input.unit,
        input.start_date,
        input.end_date,
    )?;
    let mut tx = tenant::begin(pool, household_id, false).await?;
    let before = load(&mut tx, household_id, id).await?;
    if before.tracking_mode != input.tracking_mode || before.unit != input.unit.trim() {
        let has_bills = sqlx::query_scalar!(
            r#"SELECT EXISTS(SELECT 1 FROM utility_bills WHERE household_id=$1 AND utility_contract_id=$2) AS "exists!""#,
            household_id,id
        ).fetch_one(&mut *tx).await?;
        if has_bills {
            return Err(invalid(
                "tracking mode and unit cannot change after bills have been recorded; create a replacement contract",
            ));
        }
    }
    let excludes_recorded_month = sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM utility_bills
           WHERE household_id=$1 AND utility_contract_id=$2
             AND (date_trunc('month',charge_date)::date < $3
               OR ($4::date IS NOT NULL AND date_trunc('month',charge_date)::date > $4))) AS "exists!""#,
        household_id,
        id,
        month_start(input.start_date),
        input.end_date.map(month_start)
    )
    .fetch_one(&mut *tx)
    .await?;
    if excludes_recorded_month {
        return Err(invalid(
            "contract dates must include every recorded bill month",
        ));
    }
    if input.tracking_mode != "actual" {
        ensure_coverage(&mut tx, household_id, id, input.start_date).await?;
    }
    sqlx::query!(
        "UPDATE utility_contracts SET start_date=$3,end_date=$4,tracking_mode=$5,updated_at=now()
         WHERE household_id=$1 AND id=$2",
        household_id,
        id,
        input.start_date,
        input.end_date,
        input.tracking_mode
    )
    .execute(&mut *tx)
    .await?;
    let color = input.color.unwrap_or_else(|| before.color.clone());
    let kind = service_kind(&input.tracking_mode);
    let mode = entry_mode(&input.tracking_mode);
    sqlx::query!(
        "UPDATE utility_services s SET label=$3,unit=$4,service_kind=$5,entry_mode=$6,color=$7,updated_at=now()
         FROM utility_contracts c WHERE c.household_id=$1 AND c.id=$2 AND s.household_id=c.household_id AND s.id=c.service_id",
        household_id, id, input.label.trim(), input.unit.trim(), kind, mode, color
    ).execute(&mut *tx).await?;
    recalculate(&mut tx, household_id, id, None, None).await?;
    let record = load(&mut tx, household_id, id).await?;
    audit(
        &mut tx,
        household_id,
        actor,
        id,
        "utility_contract_updated",
        json!({"before": before,"after":record}),
    )
    .await?;
    materialize(&mut tx, household_id).await?;
    tx.commit().await?;
    Ok(record)
}

pub async fn reorder(
    pool: &PgPool,
    household_id: Uuid,
    actor: Uuid,
    input: ContractReorder,
) -> Result<Vec<ContractRecord>> {
    let mut tx = tenant::begin(pool, household_id, false).await?;
    let property = sqlx::query_scalar!(
        "SELECT id FROM properties WHERE household_id=$1 AND id=$2",
        household_id,
        input.property_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if property.is_none() {
        return Err(UtilityStoreError::NotFound);
    }
    let before: Vec<Uuid> = sqlx::query_scalar!(
        "SELECT id FROM utility_contracts WHERE household_id=$1 AND property_id=$2
         ORDER BY sort_order,start_date,id",
        household_id,
        input.property_id
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut provided = input.ordered_ids.clone();
    provided.sort_unstable();
    provided.dedup();
    let mut expected = before.clone();
    expected.sort_unstable();
    if input.ordered_ids.len() != expected.len() || provided != expected {
        return Err(invalid(
            "the order must list every contract on this property exactly once",
        ));
    }
    // The contract, its service, and the property link all carry the order so
    // boards and tables render columns in the configured sequence.
    for (position, id) in input.ordered_ids.iter().enumerate() {
        let position = i32::try_from(position).unwrap_or(i32::MAX);
        sqlx::query!(
            "UPDATE utility_contracts SET sort_order=$3,updated_at=now() WHERE household_id=$1 AND id=$2",
            household_id, id, position
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query!(
            "UPDATE utility_services s SET sort_order=$3,updated_at=now()
             FROM utility_contracts c
             WHERE c.household_id=$1 AND c.id=$2 AND s.household_id=c.household_id AND s.id=c.service_id",
            household_id, id, i64::from(position)
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query!(
            "UPDATE utility_subject_services ss SET sort_order=$3
             FROM utility_contracts c
             WHERE c.household_id=$1 AND c.id=$2 AND ss.household_id=c.household_id
               AND ss.property_id=c.property_id AND ss.service_id=c.service_id",
            household_id,
            id,
            position
        )
        .execute(&mut *tx)
        .await?;
    }
    audit(
        &mut tx,
        household_id,
        actor,
        input.property_id,
        "utility_contract_order_updated",
        json!({"before": before, "after": input.ordered_ids}),
    )
    .await?;
    let timezone = sqlx::query_scalar!("SELECT timezone FROM households WHERE id=$1", household_id)
        .fetch_one(&mut *tx)
        .await?;
    let today = checkbook_domain::local_date_at(&timezone, chrono::Utc::now())
        .map_err(|error| invalid(&format!("invalid timezone: {error}")))?;
    let records = list_in_transaction(&mut tx, household_id, input.property_id, today).await?;
    tx.commit().await?;
    Ok(records)
}

pub async fn prices(pool: &PgPool, household_id: Uuid, id: Uuid) -> Result<Vec<PriceRecord>> {
    let mut tx = tenant::begin(pool, household_id, true).await?;
    load(&mut tx, household_id, id).await?;
    let rows = sqlx::query_as!(PriceRecord,
        "SELECT id,effective_on,price FROM utility_contract_prices WHERE household_id=$1 AND utility_contract_id=$2 ORDER BY effective_on,id",
        household_id, id
    ).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(rows)
}

pub async fn save_price(
    pool: &PgPool,
    household_id: Uuid,
    actor: Uuid,
    contract_id: Uuid,
    price_id: Option<Uuid>,
    input: PriceInput,
) -> Result<PriceRecord> {
    validate_price(input.price)?;
    let effective_on = month_start(input.effective_on);
    let mut tx = tenant::begin(pool, household_id, false).await?;
    let contract = load(&mut tx, household_id, contract_id).await?;
    let before = if let Some(id) = price_id {
        Some(sqlx::query_as!(PriceRecord,
            "SELECT id,effective_on,price FROM utility_contract_prices WHERE household_id=$1 AND utility_contract_id=$2 AND id=$3",
            household_id, contract_id, id
        ).fetch_optional(&mut *tx).await?.ok_or(UtilityStoreError::NotFound)?)
    } else {
        None
    };
    let duplicate = sqlx::query_scalar!(
        "SELECT id FROM utility_contract_prices WHERE household_id=$1 AND utility_contract_id=$2 AND effective_on=$3 AND ($4::uuid IS NULL OR id<>$4)",
        household_id, contract_id, effective_on, price_id
    ).fetch_optional(&mut *tx).await?;
    if duplicate.is_some() {
        return Err(invalid("a price already exists for this effective month"));
    }
    let id = price_id.unwrap_or_else(Uuid::new_v4);
    let record = sqlx::query_as!(PriceRecord,
        "INSERT INTO utility_contract_prices (id,household_id,utility_contract_id,effective_on,price)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET effective_on=EXCLUDED.effective_on,price=EXCLUDED.price,updated_at=now()
         RETURNING id,effective_on,price",
        id, household_id, contract_id, effective_on, input.price
    ).fetch_one(&mut *tx).await?;
    if contract.tracking_mode != "actual" {
        ensure_coverage(&mut tx, household_id, contract_id, contract.start_date).await?;
    }
    let affected = before
        .as_ref()
        .map_or(effective_on, |old| old.effective_on.min(effective_on));
    let last_changed = before
        .as_ref()
        .map_or(effective_on, |old| old.effective_on.max(effective_on));
    let until = sqlx::query_scalar!(
        "SELECT effective_on FROM utility_contract_prices WHERE household_id=$1 AND utility_contract_id=$2 AND effective_on>$3 ORDER BY effective_on LIMIT 1",
        household_id, contract_id, last_changed
    ).fetch_optional(&mut *tx).await?;
    recalculate(&mut tx, household_id, contract_id, Some(affected), until).await?;
    audit(
        &mut tx,
        household_id,
        actor,
        contract_id,
        "utility_contract_price_saved",
        json!({"before":before,"after":record}),
    )
    .await?;
    materialize(&mut tx, household_id).await?;
    tx.commit().await?;
    Ok(record)
}

pub(crate) async fn rate_for_month(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    contract_id: Uuid,
    month: NaiveDate,
) -> Result<Option<Decimal>> {
    Ok(sqlx::query_scalar!(
        "SELECT p.price FROM utility_contract_prices p JOIN utility_contracts c
         ON c.household_id=p.household_id AND c.id=p.utility_contract_id
         WHERE c.household_id=$1 AND c.id=$2 AND p.effective_on<=$3 ORDER BY p.effective_on DESC LIMIT 1",
        household_id, contract_id, month_start(month)
    ).fetch_optional(&mut **tx).await?)
}

pub async fn contract_for_service(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    service_id: Uuid,
) -> Result<Option<ContractRecord>> {
    let id = sqlx::query_scalar!(
        "SELECT id FROM utility_contracts WHERE household_id=$1 AND service_id=$2",
        household_id,
        service_id
    )
    .fetch_optional(&mut **tx)
    .await?;
    match id {
        Some(id) => load(tx, household_id, id).await.map(Some),
        None => Ok(None),
    }
}

async fn load(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    id: Uuid,
) -> Result<ContractRecord> {
    let timezone = sqlx::query_scalar!("SELECT timezone FROM households WHERE id=$1", household_id)
        .fetch_one(&mut **tx)
        .await?;
    let today = checkbook_domain::local_date_at(&timezone, chrono::Utc::now())
        .map_err(|error| invalid(&format!("invalid timezone: {error}")))?;
    sqlx::query_as!(ContractRecord,
        r#"SELECT c.id,c.property_id,s.service_key AS key,s.label,s.color,c.tracking_mode,s.unit,c.start_date,c.end_date,
         COALESCE(c.end_date < $3,false) AS "retired!",c.sort_order FROM utility_contracts c JOIN utility_services s
         ON s.household_id=c.household_id AND s.id=c.service_id WHERE c.household_id=$1 AND c.id=$2"#,
        household_id,id,today
    ).fetch_optional(&mut **tx).await?.ok_or(UtilityStoreError::NotFound)
}

async fn ensure_coverage(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    id: Uuid,
    start: NaiveDate,
) -> Result<()> {
    let first = sqlx::query_scalar!(
        "SELECT effective_on FROM utility_contract_prices WHERE household_id=$1 AND utility_contract_id=$2 ORDER BY effective_on LIMIT 1",
        household_id,id
    ).fetch_optional(&mut **tx).await?;
    if first.is_none_or(|first| first > month_start(start)) {
        return Err(invalid("price history must cover the contract start month"));
    }
    Ok(())
}

async fn recalculate(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    id: Uuid,
    since: Option<NaiveDate>,
    until: Option<NaiveDate>,
) -> Result<()> {
    // Rate corrections never replace an explicitly entered amount. Historical usage is
    // already the meter delta, so both usage modes use the persisted usage quantity.
    sqlx::query!(
        "WITH repriced AS (
           SELECT b.id,c.tracking_mode,p.price,b.usage_amount
           FROM utility_bills b JOIN utility_contracts c ON c.household_id=b.household_id AND c.id=b.utility_contract_id
           JOIN LATERAL (SELECT price FROM utility_contract_prices
             WHERE household_id=b.household_id AND utility_contract_id=c.id
             AND effective_on<=date_trunc('month',b.charge_date)::date ORDER BY effective_on DESC LIMIT 1) p ON true
           WHERE b.household_id=$1 AND c.id=$2 AND b.amount_source='auto'
             AND ($3::date IS NULL OR b.charge_date >= $3) AND ($4::date IS NULL OR b.charge_date < $4)
             AND c.tracking_mode<>'actual'
         ) UPDATE utility_bills b SET amount=round(CASE WHEN r.tracking_mode='fixed' THEN r.price
           ELSE r.price*r.usage_amount END,2),unit_rate=r.price,updated_at=now()
           FROM repriced r WHERE b.household_id=$1 AND b.id=r.id AND (r.tracking_mode='fixed' OR r.usage_amount IS NOT NULL)",
        household_id,id,since,until
    ).execute(&mut **tx).await?;
    Ok(())
}

async fn materialize(tx: &mut Transaction<'_, Postgres>, household_id: Uuid) -> Result<()> {
    let timezone = sqlx::query_scalar!("SELECT timezone FROM households WHERE id=$1", household_id)
        .fetch_one(&mut **tx)
        .await?;
    let month = month_start_at(&timezone, chrono::Utc::now())
        .map_err(|error| invalid(&format!("invalid timezone: {error}")))?;
    materialize_household_in_transaction(tx, household_id, month)
        .await
        .map_err(|error| {
            invalid(&format!(
                "planning materialization after utility contract write failed: {error}"
            ))
        })?;
    Ok(())
}

async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    actor: Uuid,
    id: Uuid,
    event: &str,
    payload: serde_json::Value,
) -> Result<()> {
    sqlx::query!(
        "INSERT INTO audit_events (household_id,actor_user_id,event_type,resource_type,resource_id,payload)
         VALUES ($1,$2,$3,'utility_contract',$4,$5)",
        household_id,actor,event,id,payload
    ).execute(&mut **tx).await?;
    Ok(())
}

fn month_start(date: NaiveDate) -> NaiveDate {
    date.with_day(1).unwrap_or(date)
}
fn invalid(message: &str) -> UtilityStoreError {
    UtilityStoreError::Validation(message.to_owned())
}
fn service_kind(mode: &str) -> &str {
    if matches!(mode, "usage" | "meter") {
        "metered"
    } else {
        "cost"
    }
}
fn entry_mode(mode: &str) -> &str {
    if mode == "usage" { "usage" } else { "meter" }
}

fn validate_price(price: Decimal) -> Result<()> {
    if price < Decimal::ZERO || price.scale() > 6 || price >= Decimal::from(100_000_000_000_000_i64)
    {
        return Err(invalid(
            "price must be nonnegative, below 100000000000000, and have at most six decimal places",
        ));
    }
    Ok(())
}

fn validate_config(
    label: &str,
    mode: &str,
    unit: &str,
    start: NaiveDate,
    end: Option<NaiveDate>,
) -> Result<()> {
    if label.trim().is_empty() || label.len() > 200 {
        return Err(invalid("label must contain 1 to 200 characters"));
    }
    if !matches!(mode, "actual" | "fixed" | "usage" | "meter") {
        return Err(invalid("invalid tracking mode"));
    }
    if unit.len() > 50 || (matches!(mode, "usage" | "meter") && unit.trim().is_empty()) {
        return Err(invalid(
            "usage and meter tracking require a unit of at most 50 characters",
        ));
    }
    checkbook_domain::utilities::validate_contract_dates(
        checkbook_domain::utilities::ContractDates {
            start_date: start,
            end_date: end,
        },
    )
    .map_err(|error| invalid(&error.to_string()))
}
