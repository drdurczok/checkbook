use checkbook_postgres::{
    auth::create_development_session,
    backup::{BackupStoreError, restore_household, snapshot_household},
    connect, migrate, tenant,
};
use rust_decimal_macros::dec;
use serde_json::Value;

#[tokio::test]
async fn backup_round_trip_includes_buyers_income_sources_and_rejects_broken_refs()
-> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL backup test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    migrate(&pool).await?;
    let identity = uuid::Uuid::new_v4();
    let context = create_development_session(
        &pool,
        &format!("backup-{identity}@example.com"),
        "Backup Owner",
        "owner",
        24,
    )
    .await?;
    let household_id = context.household.id;
    let (buyer_id, income_source_id, ledger_id) = {
        let mut transaction = tenant::begin(&pool, household_id, false).await?;
        let buyer_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO buyers (household_id, name, nip, address)
             VALUES ($1,'Buyer','123','Warsaw') RETURNING id",
        )
        .bind(household_id)
        .fetch_one(&mut *transaction)
        .await?;
        let income_source_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO income_sources
                (household_id, name, source_type, owner_scope, source_key)
             VALUES ($1,'Salary','employment','self',$2)
             RETURNING id",
        )
        .bind(household_id)
        .bind(format!("backup-source-{identity}"))
        .fetch_one(&mut *transaction)
        .await?;
        let category_id: uuid::Uuid = sqlx::query_scalar(
            "SELECT id FROM categories
             WHERE household_id = $1 AND kind = 'income'
             ORDER BY created_at LIMIT 1",
        )
        .bind(household_id)
        .fetch_one(&mut *transaction)
        .await?;
        let ledger_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO ledger_entries
                (household_id, direction, status, amount, entry_date, description,
                 owner_scope, data_source, category_id, income_source_id, source_key)
             VALUES ($1,'income','actual',$2,'2026-06-01','Backup salary',
                     'self','app_manual',$3,$4,$5)
             RETURNING id",
        )
        .bind(household_id)
        .bind(dec!(1234.56))
        .bind(category_id)
        .bind(income_source_id)
        .bind(format!("backup-ledger-{identity}"))
        .fetch_one(&mut *transaction)
        .await?;
        transaction.commit().await?;
        (buyer_id, income_source_id, ledger_id)
    };

    checkbook_postgres::net_worth_months::upsert_month(
        &pool,
        household_id,
        chrono::NaiveDate::from_ymd_opt(2026, 6, 1).ok_or_else(|| anyhow::anyhow!("date"))?,
        true,
        vec![
            checkbook_postgres::net_worth_months::NetWorthComponentInput {
                group_key: "savings".to_owned(),
                label: "Manual cash".to_owned(),
                value: dec!(42.123456),
            },
        ],
    )
    .await?;
    let month =
        chrono::NaiveDate::from_ymd_opt(2026, 6, 1).ok_or_else(|| anyhow::anyhow!("date"))?;
    let planner_input = checkbook_postgres::payday::Input {
        position: Some(7),
        title: "Future reserve".to_owned(),
        section: "flexible".to_owned(),
        kind: "savings".to_owned(),
        expense_group_id: None,
        category_id: None,
        subcategory_id: None,
        amount: dec!(321.09),
        notes: "Planner snapshot must survive restore".to_owned(),
        completed: true,
        recurring: None,
        template_id: None,
        source_key: None,
    };
    checkbook_postgres::payday::save(
        &pool,
        household_id,
        month,
        None,
        &planner_input,
        chrono::Utc::now(),
    )
    .await?;
    let attempted = chrono::Utc::now();
    checkbook_postgres::holding_prices::claim(&pool, household_id, "VTI", attempted).await?;
    checkbook_postgres::holding_prices::finish(
        &pool,
        household_id,
        "VTI",
        attempted,
        Ok(checkbook_domain::holding_prices::DailyClose {
            close: dec!(349.39),
            price_date: attempted.date_naive(),
        }),
    )
    .await?;
    let mut tx = tenant::begin(&pool, household_id, false).await?;
    let utility_property = sqlx::query_scalar!(
        "INSERT INTO properties (household_id, name, category, valuation, valuation_date,
          status, data_source, source_key, utilities_enabled, expenses_enabled)
         VALUES ($1,'Backup utility house','property',100,CURRENT_DATE,'active','app_manual',$2,true,true)
         RETURNING id", household_id, format!("backup-utility:{identity}")
    ).fetch_one(&mut *tx).await?;
    sqlx::query!("INSERT INTO utility_months (household_id,property_id,period,completed) VALUES ($1,$2,'2026-06-01',true)", household_id, utility_property).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut utility_keys = checkbook_postgres::utilities::field_catalog(&pool, household_id)
        .await?
        .into_iter()
        .map(|field| field.key)
        .collect::<Vec<_>>();
    utility_keys.reverse();
    checkbook_postgres::utilities::reorder_fields(
        &pool,
        household_id,
        context.user.id,
        utility_keys.clone(),
    )
    .await?;
    let snapshot = snapshot_household(&pool, household_id).await?;
    assert_eq!(snapshot.tables["utility_months"][0]["completed"], "true");
    assert_eq!(
        snapshot.tables["payday_allocations"][0]["position"],
        serde_json::json!("7")
    );
    assert_eq!(
        snapshot.tables["net_worth_months"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(
        snapshot.tables["net_worth_month_components"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    assert_eq!(snapshot.tables["buyers"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        snapshot.tables["income_sources"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(
        snapshot.tables["household_settings"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    assert_eq!(
        snapshot.tables["role_permissions"].as_array().map(Vec::len),
        Some(8)
    );
    {
        let mut transaction = tenant::begin(&pool, household_id, false).await?;
        sqlx::query("DELETE FROM buyers WHERE household_id = $1")
            .bind(household_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO buyers (household_id, name)
             VALUES ($1,'Replacement')",
        )
        .bind(household_id)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "UPDATE household_settings SET privacy_mode = 'full_visibility'
             WHERE household_id = $1",
        )
        .bind(household_id)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "UPDATE role_permissions SET can_write = NOT can_write
             WHERE household_id = $1 AND module = 'imports' AND role = 'owner'",
        )
        .bind(household_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
    }
    let restored = restore_household(&pool, household_id, context.user.id, &snapshot).await?;
    assert_eq!(restored["buyers"], 1);
    assert_eq!(restored["payday_months"], 1);
    assert_eq!(restored["payday_allocations"], 1);
    assert_eq!(restored["net_worth_months"], 1);
    assert_eq!(restored["net_worth_month_components"], 1);
    assert_eq!(
        checkbook_postgres::utilities::field_catalog(&pool, household_id)
            .await?
            .into_iter()
            .map(|field| field.key)
            .collect::<Vec<_>>(),
        utility_keys
    );
    let roundtrip = snapshot_household(&pool, household_id).await?;
    assert_eq!(restored["utility_months"], 1);
    assert_eq!(roundtrip.tables["utility_months"][0]["completed"], "true");
    assert_eq!(
        roundtrip.tables["utility_months"][0]["property_id"],
        utility_property.to_string()
    );
    assert_eq!(
        roundtrip.tables["holding_price_cache"],
        snapshot.tables["holding_price_cache"]
    );
    assert_eq!(restored["holding_price_cache"], 1);
    let mut duplicate_cache = snapshot.clone();
    duplicate_cache.tables.insert(
        "holding_price_cache".to_owned(),
        serde_json::json!([
            snapshot.tables["holding_price_cache"][0],
            snapshot.tables["holding_price_cache"][0]
        ]),
    );
    assert!(checkbook_postgres::backup::validate_snapshot(&duplicate_cache, household_id).is_err());
    assert_eq!(
        roundtrip.tables["payday_months"],
        snapshot.tables["payday_months"]
    );
    assert_eq!(
        roundtrip.tables["payday_allocations"],
        snapshot.tables["payday_allocations"]
    );
    assert_eq!(
        roundtrip.tables["net_worth_months"],
        snapshot.tables["net_worth_months"]
    );
    assert_eq!(
        roundtrip.tables["net_worth_month_components"],
        snapshot.tables["net_worth_month_components"]
    );
    assert_eq!(restored["income_sources"], 1);
    assert_eq!(restored["household_settings"], 1);
    assert_eq!(restored["role_permissions"], 8);
    let mut settings_transaction = tenant::begin(&pool, household_id, true).await?;
    let (privacy_mode, imports_owner_can_write): (String, bool) = sqlx::query_as(
        "SELECT
            (SELECT privacy_mode FROM household_settings WHERE household_id = $1),
            (SELECT can_write FROM role_permissions
             WHERE household_id = $1 AND module = 'imports' AND role = 'owner')",
    )
    .bind(household_id)
    .fetch_one(&mut *settings_transaction)
    .await?;
    settings_transaction.commit().await?;
    assert_eq!(privacy_mode, "private_joint");
    assert!(imports_owner_can_write);
    let mut read_transaction = tenant::begin(&pool, household_id, true).await?;
    let restored_values: (String, String, rust_decimal::Decimal) = sqlx::query_as(
        "SELECT
            (SELECT name FROM buyers WHERE household_id = $1 AND id = $2),
            (SELECT name FROM income_sources WHERE household_id = $1 AND id = $3),
            (SELECT amount FROM ledger_entries WHERE household_id = $1 AND id = $4)",
    )
    .bind(household_id)
    .bind(buyer_id)
    .bind(income_source_id)
    .bind(ledger_id)
    .fetch_one(&mut *read_transaction)
    .await?;
    read_transaction.commit().await?;
    assert_eq!(restored_values.0, "Buyer");
    assert_eq!(restored_values.1, "Salary");
    assert_eq!(restored_values.2, dec!(1234.56));

    let mut broken = snapshot.clone();
    let rows = broken
        .tables
        .get_mut("ledger_entries")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow::anyhow!("ledger rows missing"))?;
    rows[0]["category_id"] = Value::String(uuid::Uuid::new_v4().to_string());
    assert!(matches!(
        restore_household(&pool, household_id, context.user.id, &broken).await,
        Err(BackupStoreError::Validation(_))
    ));
    let mut read_transaction = tenant::begin(&pool, household_id, true).await?;
    let buyer_still_present: bool = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM buyers WHERE household_id = $1 AND id = $2
         )",
    )
    .bind(household_id)
    .bind(buyer_id)
    .fetch_one(&mut *read_transaction)
    .await?;
    read_transaction.commit().await?;
    assert!(buyer_still_present);
    Ok(())
}
