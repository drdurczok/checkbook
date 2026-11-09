use checkbook_postgres::{
    auth::create_development_session,
    bulk_import::{BulkImportRequest, run_bulk_import},
    connect, tenant,
};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

fn payload(property: &str, label: &str, bill_key: &str, amount: i32) -> Value {
    json!({
        "source": "utility-contract-regression",
        "properties": [{"source_key": property, "name": property,
            "valuation_date": "2026-01-01", "started_on": "2026-01-01"}],
        "utilities": [{"property_source_key": property, "service_key": "electricity",
            "label": label, "service_kind": "metered", "unit": "kWh",
            "bills": [{"source_key": bill_key, "charge_date": "2026-02-01",
                "amount": amount, "reading": 1234, "usage_amount": 50}]}]
    })
}

#[tokio::test]
async fn imports_are_property_owned_idempotent_and_preserve_actual_amounts() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; utility bulk import integration test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let context = create_development_session(
        &pool,
        &format!("utility-import-{}@example.com", Uuid::new_v4()),
        "Utility Import Owner",
        "owner",
        24,
    )
    .await?;
    let household = context.household.id;
    let first = payload("home-a", "Electricity A", "bill-a", 17);
    let second = payload("home-b", "Electricity B", "bill-b", 99);
    for value in [&first, &second, &first] {
        let request: BulkImportRequest = serde_json::from_value(value.clone())?;
        run_bulk_import(&pool, household, request).await?;
    }
    let mut tx = tenant::begin(&pool, household, true).await?;
    let rows = sqlx::query(
        "SELECT c.id, c.property_id, c.start_date::text, c.tracking_mode, s.service_key,
                s.label, b.amount, b.amount_source, r.reading
         FROM utility_contracts c JOIN utility_services s ON s.id=c.service_id
         JOIN utility_bills b ON b.utility_contract_id=c.id
         JOIN utility_meter_readings r ON r.utility_bill_id=b.id
         WHERE c.household_id=$1 ORDER BY s.label",
    )
    .bind(household)
    .fetch_all(&mut *tx)
    .await?;
    assert_eq!(rows.len(), 2);
    assert_ne!(
        rows[0].try_get::<Uuid, _>("id")?,
        rows[1].try_get::<Uuid, _>("id")?
    );
    for (row, label, amount) in [
        (&rows[0], "Electricity A", dec!(17)),
        (&rows[1], "Electricity B", dec!(99)),
    ] {
        let property: Uuid = row.try_get("property_id")?;
        assert_eq!(
            row.try_get::<String, _>("service_key")?,
            format!("import_{}_electricity", property.simple())
        );
        assert_eq!(row.try_get::<String, _>("label")?, label);
        assert_eq!(row.try_get::<Decimal, _>("amount")?, amount);
        assert_eq!(row.try_get::<String, _>("amount_source")?, "actual");
        assert_eq!(row.try_get::<String, _>("tracking_mode")?, "actual");
        assert_eq!(row.try_get::<String, _>("start_date")?, "2026-02-01");
        assert_eq!(row.try_get::<Decimal, _>("reading")?, dec!(1234));
    }
    tx.commit().await?;

    for field in ["unit", "service_kind"] {
        let mut incompatible = first.clone();
        incompatible["utilities"][0][field] = if field == "unit" {
            json!("m3")
        } else {
            json!("cost")
        };
        assert!(
            run_bulk_import(&pool, household, serde_json::from_value(incompatible)?)
                .await
                .is_err()
        );
    }

    // Neither changing property nor changing the external utility key can steal
    // an existing bill, even when the import otherwise supplies valid data.
    let mut moved = payload("home-b", "Moved", "bill-a", 500);
    assert!(
        run_bulk_import(&pool, household, serde_json::from_value(moved.clone())?)
            .await
            .is_err()
    );
    moved["utilities"][0]["property_source_key"] = json!("home-a");
    moved["utilities"][0]["service_key"] = json!("water");
    assert!(
        run_bulk_import(&pool, household, serde_json::from_value(moved)?)
            .await
            .is_err()
    );
    let mut tx = tenant::begin(&pool, household, true).await?;
    let amount: Decimal = sqlx::query_scalar(
        "SELECT amount FROM utility_bills WHERE household_id=$1 AND source_key='bill-a'",
    )
    .bind(household)
    .fetch_one(&mut *tx)
    .await?;
    assert_eq!(amount, dec!(17));
    tx.commit().await?;
    Ok(())
}

#[tokio::test]
async fn empty_import_creates_one_contract_and_later_bills_extend_start() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; utility bulk import integration test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let context = create_development_session(
        &pool,
        &format!("utility-empty-import-{}@example.com", Uuid::new_v4()),
        "Utility Import Owner",
        "owner",
        24,
    )
    .await?;
    let household = context.household.id;
    let mut input = payload("home", "Power", "bill", 21);
    input["utilities"][0]["bills"] = json!([]);
    for _ in 0..2 {
        run_bulk_import(&pool, household, serde_json::from_value(input.clone())?).await?;
    }
    let mut tx = tenant::begin(&pool, household, true).await?;
    let (id, start): (Uuid, String) =
        sqlx::query_as("SELECT id,start_date::text FROM utility_contracts WHERE household_id=$1")
            .bind(household)
            .fetch_one(&mut *tx)
            .await?;
    assert_eq!(start, "2026-01-01");
    tx.commit().await?;
    // Migrated contracts have contract_<uuid> keys instead of import_* keys.
    // Provenance must still find them even without an overlapping bill key.
    let mut tx = tenant::begin(&pool, household, false).await?;
    sqlx::query("UPDATE utility_services SET service_key=$3 WHERE household_id=$1 AND id=(SELECT service_id FROM utility_contracts WHERE household_id=$1 AND id=$2)")
        .bind(household).bind(id).bind(format!("contract_{id}"))
        .execute(&mut *tx).await?;
    tx.commit().await?;
    let mut input = payload("home", "Power", "bill", 21);
    input["utilities"][0]["bills"][0]["charge_date"] = json!("2025-12-01");
    run_bulk_import(&pool, household, serde_json::from_value(input)?).await?;
    let mut tx = tenant::begin(&pool, household, true).await?;
    let rows: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT id,start_date::text FROM utility_contracts WHERE household_id=$1")
            .bind(household)
            .fetch_all(&mut *tx)
            .await?;
    assert_eq!(rows, vec![(id, "2025-12-01".to_owned())]);
    tx.commit().await?;
    let mut tx = tenant::begin(&pool, household, false).await?;
    sqlx::query(
        "UPDATE utility_contracts SET tracking_mode='usage' WHERE household_id=$1 AND id=$2",
    )
    .bind(household)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO utility_contract_prices (household_id,utility_contract_id,effective_on,price) VALUES ($1,$2,'2025-12-01',0.25)")
        .bind(household).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut earlier = payload("home", "Power", "earlier-bill", 10);
    earlier["utilities"][0]["bills"][0]["charge_date"] = json!("2025-11-01");
    assert!(
        run_bulk_import(&pool, household, serde_json::from_value(earlier)?)
            .await
            .is_err()
    );
    Ok(())
}

// Lifetime guards are whole-month: a bill inside the start or end month is
// accepted even when its day precedes the start or follows the end, but a
// bill beyond the end month is rejected atomically.
#[tokio::test]
async fn imports_respect_contract_lifetime_month_boundaries() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; utility bulk import lifetime test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let context = create_development_session(
        &pool,
        &format!("utility-lifetime-{}@example.com", Uuid::new_v4()),
        "Utility Lifetime Owner",
        "owner",
        24,
    )
    .await?;
    let household = context.household.id;
    let mut seed = payload("home-life", "Power", "life-seed", 30);
    seed["utilities"][0]["bills"][0]["charge_date"] = json!("2026-02-10");
    run_bulk_import(&pool, household, serde_json::from_value(seed)?).await?;
    let mut tx = tenant::begin(&pool, household, false).await?;
    let (id, start): (Uuid, String) =
        sqlx::query_as("SELECT id,start_date::text FROM utility_contracts WHERE household_id=$1")
            .bind(household)
            .fetch_one(&mut *tx)
            .await?;
    assert_eq!(start, "2026-02-10");
    sqlx::query(
        "UPDATE utility_contracts SET tracking_mode='usage' WHERE household_id=$1 AND id=$2",
    )
    .bind(household)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO utility_contract_prices (household_id,utility_contract_id,effective_on,price) VALUES ($1,$2,'2026-02-01',0.25)")
        .bind(household)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    // Same start month, earlier day: automatic tracking accepts the bill.
    let mut same_month = payload("home-life", "Power", "life-feb-first", 11);
    same_month["utilities"][0]["bills"][0]["charge_date"] = json!("2026-02-01");
    run_bulk_import(&pool, household, serde_json::from_value(same_month)?).await?;

    let mut tx = tenant::begin(&pool, household, false).await?;
    sqlx::query(
        "UPDATE utility_contracts SET end_date='2026-02-28' WHERE household_id=$1 AND id=$2",
    )
    .bind(household)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    // Same end month, later day: still inside the lifetime month.
    let mut last_month = payload("home-life", "Power", "life-feb-late", 12);
    last_month["utilities"][0]["bills"][0]["charge_date"] = json!("2026-02-20");
    run_bulk_import(&pool, household, serde_json::from_value(last_month)?).await?;

    let mut beyond = payload("home-life", "Power", "life-march", 13);
    beyond["utilities"][0]["bills"][0]["charge_date"] = json!("2026-03-05");
    assert!(
        run_bulk_import(&pool, household, serde_json::from_value(beyond)?)
            .await
            .is_err()
    );
    let mut tx = tenant::begin(&pool, household, true).await?;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM utility_bills WHERE household_id=$1 AND source_key='life-march'",
    )
    .bind(household)
    .fetch_one(&mut *tx)
    .await?;
    assert_eq!(count, 0, "rejected import must not persist its bills");
    tx.commit().await?;
    Ok(())
}
