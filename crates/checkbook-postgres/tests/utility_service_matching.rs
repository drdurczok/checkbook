use checkbook_postgres::{
    auth::create_development_session,
    connect, tenant,
    utilities::{self, ManualUtilityInput, UtilityEntryValueInput, UtilityUpsertInput},
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use uuid::Uuid;

#[tokio::test]
async fn manual_writes_reuse_imported_services_with_raw_keys() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; utility service matching test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    let identity = Uuid::new_v4();
    let context = create_development_session(
        &pool,
        &format!("utility-matching-{identity}@example.com"),
        "Utility matching owner",
        "owner",
        24,
    )
    .await?;
    let household_id = context.household.id;

    // Mirror the production shape: a bulk-imported service keeps its raw,
    // un-normalized key and is already tracked for the property.
    let mut tx = tenant::begin(&pool, household_id, false).await?;
    let property_id = sqlx::query_scalar!(
        "INSERT INTO properties (household_id, name, category, valuation, valuation_date,
             status, data_source, source_key, utilities_enabled, expenses_enabled)
         VALUES ($1, 'Matching house', 'property', 100, CURRENT_DATE, 'active',
                 'app_manual', $2, true, true)
         RETURNING id",
        household_id,
        format!("utility-matching:{identity}:property")
    )
    .fetch_one(&mut *tx)
    .await?;
    let imported_service_id = sqlx::query_scalar!(
        "INSERT INTO utility_services (household_id, service_key, label, service_kind, unit)
         VALUES ($1, 'util:Czynsz', 'Czynsz', 'cost', '') RETURNING id",
        household_id
    )
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query!(
        "INSERT INTO utility_subject_services (household_id, property_id, service_id)
         VALUES ($1, $2, $3)",
        household_id,
        property_id,
        imported_service_id
    )
    .execute(&mut *tx)
    .await?;
    let contract_id = sqlx::query_scalar!("INSERT INTO utility_contracts (household_id,property_id,service_id,start_date,tracking_mode) VALUES ($1,$2,$3,'2020-01-01','actual') RETURNING id",household_id,property_id,imported_service_id).fetch_one(&mut *tx).await?;
    let imported_bill_id = sqlx::query_scalar!("INSERT INTO utility_bills (household_id,property_id,service_id,utility_contract_id,provider,description,amount,currency,charge_date,owner_scope,data_source,source_key,amount_source) VALUES ($1,$2,$3,$4,'Community','Imported',1,'PLN','2026-10-01','joint','app_manual',NULL,'actual') RETURNING id",household_id,property_id,imported_service_id,contract_id).fetch_one(&mut *tx).await?;
    tx.commit().await?;

    let scopes = vec!["joint".to_owned()];
    let month_start = NaiveDate::parse_from_str("2026-10-01", "%Y-%m-%d")?;
    utilities::upsert(
        &pool,
        household_id,
        Some(property_id),
        None,
        UtilityUpsertInput {
            completed: None,
            month: "2026-10".to_owned(),
            month_start,
            entries: vec![UtilityEntryValueInput {
                amount_source: None,
                usage_amount: None,
                field_key: "util:Czynsz".to_owned(),
                amount: Some(Decimal::new(82098, 2)),
                meter_reading: None,
            }],
            base_currency: "PLN".to_owned(),
            household_timezone: "Europe/Warsaw".to_owned(),
        },
        month_start,
        &scopes,
    )
    .await?;

    // The write must reuse the imported service, not create a normalized
    // duplicate (new households no longer receive global service seeds).
    // Verification reads run inside the household tenant context because RLS
    // hides rows from direct app-role queries.
    let mut verify = tenant::begin(&pool, household_id, true).await?;
    let services = sqlx::query_scalar!(
        "SELECT count(*) FROM utility_services WHERE household_id = $1",
        household_id
    )
    .fetch_one(&mut *verify)
    .await?;
    assert_eq!(services, Some(1));
    let imported_bills = sqlx::query_scalar!(
        r#"SELECT count(*) FROM utility_bills b
           JOIN utility_services s ON s.id = b.service_id
           WHERE b.household_id = $1
             AND b.property_id = $2
             AND s.id = $3"#,
        household_id,
        property_id,
        imported_service_id
    )
    .fetch_one(&mut *verify)
    .await?;
    assert_eq!(imported_bills, Some(1));
    let stray_bills = sqlx::query_scalar!(
        r#"SELECT count(*) FROM utility_bills b
           JOIN utility_services s ON s.id = b.service_id
           WHERE b.household_id = $1 AND b.property_id = $2 AND s.id <> $3"#,
        household_id,
        property_id,
        imported_service_id
    )
    .fetch_one(&mut *verify)
    .await?;
    assert_eq!(stray_bills, Some(0));
    let preserved = sqlx::query!("SELECT id,source_key,utility_contract_id FROM utility_bills WHERE household_id=$1 AND id=$2",household_id,imported_bill_id).fetch_one(&mut *verify).await?;
    assert_eq!(preserved.id, imported_bill_id);
    assert_eq!(preserved.source_key, None);
    assert_eq!(preserved.utility_contract_id, Some(contract_id));
    verify.commit().await?;

    // The monthly form still exposes the raw imported field with the amount
    // recorded on it, so editing the month keeps targeting the same service.
    let form = utilities::form(
        &pool,
        household_id,
        Some(property_id),
        None,
        "2026-10".to_owned(),
        month_start,
        &scopes,
    )
    .await?;
    let czynsz = form
        .fields
        .iter()
        .find(|field| field.key == "util:Czynsz")
        .ok_or_else(|| anyhow::anyhow!("imported field missing from form"))?;
    assert_eq!(czynsz.amount, Some(Decimal::new(82098, 2)));
    // Completing and identically saving raw imported service keys is a no-op.
    for entries in [
        vec![],
        vec![UtilityEntryValueInput {
            amount_source: None,
            field_key: "util:Czynsz".to_owned(),
            amount: Some(Decimal::new(82098, 2)),
            meter_reading: None,
            usage_amount: None,
        }],
    ] {
        utilities::upsert(
            &pool,
            household_id,
            Some(property_id),
            None,
            UtilityUpsertInput {
                month: "2026-10".to_owned(),
                completed: Some(true),
                month_start,
                entries,
                base_currency: "PLN".to_owned(),
                household_timezone: "Europe/Warsaw".to_owned(),
            },
            month_start,
            &scopes,
        )
        .await?;
    }

    let manual_date = NaiveDate::parse_from_str("2026-11-05", "%Y-%m-%d")?;
    let manual_input = || ManualUtilityInput {
        provider: "Community".to_owned(),
        description: "Czynsz".to_owned(),
        amount: Decimal::new(100, 0),
        charge_date: manual_date,
        owner_scope: "joint".to_owned(),
        property_id: Some(property_id),
        group_id: None,
        service_key: Some("util:Czynsz".to_owned()),
        usage_amount: None,
        usage_unit: String::new(),
        meter_reading: None,
        notes: String::new(),
        base_currency: "PLN".to_owned(),
        household_timezone: "Europe/Warsaw".to_owned(),
    };
    utilities::create_manual(&pool, household_id, manual_input()).await?;
    let mut verify = tenant::begin(&pool, household_id, true).await?;
    let services_after_manual = sqlx::query_scalar!(
        "SELECT count(*) FROM utility_services WHERE household_id = $1",
        household_id
    )
    .fetch_one(&mut *verify)
    .await?;
    assert_eq!(services_after_manual, Some(1));
    let imported_bills_after_manual = sqlx::query_scalar!(
        r#"SELECT count(*) FROM utility_bills b
           JOIN utility_services s ON s.id = b.service_id
           WHERE b.household_id = $1
             AND b.property_id = $2
             AND s.id = $3"#,
        household_id,
        property_id,
        imported_service_id
    )
    .fetch_one(&mut *verify)
    .await?;
    assert_eq!(imported_bills_after_manual, Some(2));
    verify.commit().await?;
    let mut tx = tenant::begin(&pool, household_id, false).await?;
    let destination = sqlx::query_scalar!(
        "INSERT INTO properties (household_id, name, category, valuation, valuation_date,
             status, data_source, source_key, utilities_enabled, expenses_enabled)
         VALUES ($1, 'Destination house', 'property', 100, CURRENT_DATE, 'active',
                 'app_manual', $2, true, true) RETURNING id",
        household_id,
        format!("utility-matching:{identity}:destination")
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let completion = |property, completed| {
        utilities::upsert(
            &pool,
            household_id,
            Some(property),
            None,
            UtilityUpsertInput {
                completed: Some(completed),
                month: "2026-11".to_owned(),
                month_start: NaiveDate::from_ymd_opt(2026, 11, 1).unwrap_or(month_start),
                entries: vec![],
                base_currency: "PLN".to_owned(),
                household_timezone: "Europe/Warsaw".to_owned(),
            },
            month_start,
            &scopes,
        )
    };
    // Completed destinations are protected even without bills of their own.
    completion(destination, true).await?;
    assert!(
        utilities::reassign(
            &pool,
            household_id,
            property_id,
            destination,
            &scopes,
            "Europe/Warsaw"
        )
        .await
        .is_err()
    );
    completion(destination, false).await?;
    completion(property_id, true).await?;
    assert!(
        utilities::create_manual(&pool, household_id, manual_input())
            .await
            .is_err()
    );
    assert!(
        utilities::reassign(
            &pool,
            household_id,
            property_id,
            destination,
            &scopes,
            "Europe/Warsaw"
        )
        .await
        .is_err()
    );
    completion(property_id, false).await?;
    utilities::upsert(
        &pool,
        household_id,
        Some(property_id),
        None,
        UtilityUpsertInput {
            month: "2026-10".to_owned(),
            completed: Some(false),
            month_start,
            entries: vec![],
            base_currency: "PLN".to_owned(),
            household_timezone: "Europe/Warsaw".to_owned(),
        },
        month_start,
        &scopes,
    )
    .await?;
    assert!(
        utilities::reassign(
            &pool,
            household_id,
            property_id,
            destination,
            &scopes,
            "Europe/Warsaw"
        )
        .await
        .is_err()
    );
    let empty = utilities::form(
        &pool,
        household_id,
        Some(destination),
        None,
        "2026-10".to_owned(),
        month_start,
        &scopes,
    )
    .await?;
    assert!(empty.fields.is_empty());
    let mut wrong_property = manual_input();
    wrong_property.property_id = Some(destination);
    assert!(
        utilities::create_manual(&pool, household_id, wrong_property)
            .await
            .is_err()
    );
    let mut unknown = manual_input();
    unknown.service_key = Some("unknown".to_owned());
    assert!(
        utilities::create_manual(&pool, household_id, unknown)
            .await
            .is_err()
    );
    Ok(())
}
