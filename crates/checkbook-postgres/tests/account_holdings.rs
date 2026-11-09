use checkbook_postgres::{
    assets::{
        AccountHoldingInput, AssetInput, create_asset, delete_asset, list_assets, update_asset,
    },
    auth::create_development_session,
    connect, migrate, tenant,
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use uuid::Uuid;

fn date(year: i32, month: u32, day: u32) -> anyhow::Result<NaiveDate> {
    NaiveDate::from_ymd_opt(year, month, day).ok_or_else(|| anyhow::anyhow!("invalid test date"))
}

fn input(category: &str, holdings: Vec<AccountHoldingInput>) -> anyhow::Result<AssetInput> {
    Ok(AssetInput {
        name: "Brokerage".to_owned(),
        total_cost: dec!(5000),
        valuation_date: date(2026, 6, 1)?,
        status: "active".to_owned(),
        started_on: None,
        ended_on: None,
        notes: String::new(),
        kind: "asset".to_owned(),
        category: category.to_owned(),
        account_type: (category == "account").then(|| "stocks".to_owned()),
        account_registration: (category == "account").then(|| "regular".to_owned()),
        holdings,
        depreciation_rate: Decimal::ZERO,
        depreciation_enabled: true,
        utilities_enabled: true,
        projects_enabled: true,
        expenses_enabled: true,
        linked_category_ids: Vec::new(),
        details: serde_json::json!({}),
        base_currency: "USD".to_owned(),
        household_timezone: "UTC".to_owned(),
    })
}

fn holding(name: &str, value: Decimal) -> anyhow::Result<AccountHoldingInput> {
    Ok(AccountHoldingInput {
        name: name.to_owned(),
        ticker: (name == "VTI").then(|| " vti ".to_owned()),
        quantity: Some(dec!(2)),
        unit_price: Some(dec!(50)),
        value,
        purchased_on: Some(date(2026, 1, 10)?),
        sold_on: None,
        sell_value: None,
        notes: String::new(),
    })
}

#[tokio::test]
async fn account_assets_store_holdings_link_account_type_and_cascade() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; account holdings integration test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    migrate(&pool).await?;
    let identity = Uuid::new_v4();
    let context = create_development_session(
        &pool,
        &format!("account-assets-{}@example.com", identity),
        "Account Owner",
        "owner",
        24,
    )
    .await?;
    let household = context.household.id;

    // Create with two holdings; registration defaults to 'regular' at the API
    // layer, so the store receives it explicitly.
    let created = create_asset(
        &pool,
        household,
        input(
            "account",
            vec![holding("VTI", dec!(750))?, holding("Cash", dec!(4250))?],
        )?,
    )
    .await?;
    let details = list_assets(&pool, household)
        .await?
        .into_iter()
        .find(|details| details.row.id == created.id)
        .ok_or_else(|| anyhow::anyhow!("created account missing from list"))?;
    assert_eq!(details.row.category, "account");
    assert_eq!(details.row.account_type.as_deref(), Some("stocks"));
    assert_eq!(details.row.account_registration.as_deref(), Some("regular"));
    assert_eq!(details.holdings.len(), 2);
    assert_eq!(details.holdings[0].name, "VTI");
    assert_eq!(details.holdings[0].value, dec!(750));
    assert_eq!(details.holdings[1].name, "Cash");
    assert_eq!(details.holdings[0].ticker.as_deref(), Some("VTI"));
    use checkbook_domain::holding_prices::DailyClose;
    use checkbook_postgres::holding_prices::{account_tickers, cached, claim, finish};
    for account_type in ["savings", "options"] {
        let mut excluded = input("account", vec![holding("VTI", dec!(100))?])?;
        excluded.name = format!("Excluded {account_type}");
        excluded.account_type = Some(account_type.to_owned());
        let excluded = create_asset(&pool, household, excluded).await?;
        assert!(
            account_tickers(&pool, household, excluded.id)
                .await
                .is_err()
        );
        delete_asset(&pool, household, excluded.id, "UTC").await?;
    }
    let now = chrono::Utc::now();
    assert_eq!(
        account_tickers(&pool, household, created.id).await?,
        vec!["VTI"]
    );
    assert!(claim(&pool, household, "VTI", now).await?);
    assert!(!claim(&pool, household, "VTI", now).await?);
    finish(
        &pool,
        household,
        "VTI",
        now,
        Ok(DailyClose {
            close: dec!(349.39),
            price_date: now.date_naive(),
        }),
    )
    .await?;
    let success = cached(&pool, household, "VTI")
        .await?
        .ok_or_else(|| anyhow::anyhow!("cache missing"))?;
    assert_eq!(success.close, Some(dec!(349.39)));
    assert!(success.error.is_none());
    let foreign = Uuid::new_v4();
    assert!(cached(&pool, foreign, "VTI").await?.is_none());
    let mut foreign_tx = tenant::begin(&pool, foreign, true).await?;
    let visible =
        sqlx::query_scalar!("SELECT COUNT(*) FROM holding_price_cache WHERE ticker = 'VTI'")
            .fetch_one(&mut *foreign_tx)
            .await?;
    assert_eq!(visible, Some(0));
    foreign_tx.commit().await?;
    let mut foreign_tx = tenant::begin(&pool, foreign, false).await?;
    assert!(sqlx::query!("INSERT INTO holding_price_cache (household_id, ticker, last_attempt_at) VALUES ($1, 'MSFT', $2)", household, now).execute(&mut *foreign_tx).await.is_err());
    foreign_tx.rollback().await?;
    let retry = now + chrono::Duration::days(1);
    assert!(claim(&pool, household, "VTI", retry).await?);
    finish(
        &pool,
        household,
        "VTI",
        retry,
        Err("Provider unavailable.".to_owned()),
    )
    .await?;
    let failure = cached(&pool, household, "VTI")
        .await?
        .ok_or_else(|| anyhow::anyhow!("cache missing"))?;
    assert_eq!(failure.close, success.close);
    assert_eq!(failure.last_success_at, success.last_success_at);
    assert!(failure.error.is_some());
    let retry = retry + chrono::Duration::minutes(31);
    assert!(claim(&pool, household, "VTI", retry).await?);
    finish(
        &pool,
        household,
        "VTI",
        retry,
        Ok(DailyClose {
            close: dec!(100),
            price_date: now.date_naive() - chrono::Duration::days(1),
        }),
    )
    .await?;
    assert_eq!(
        cached(&pool, household, "VTI")
            .await?
            .and_then(|row| row.close),
        success.close
    );
    assert!(details.holdings[0].id != details.holdings[1].id);

    // The linked financial account carries the subtype, never 'account', so
    // net-worth classifiers can group it.
    {
        let mut tx = tenant::begin(&pool, household, true).await?;
        let account_type: String = sqlx::query_scalar(
            "SELECT a.account_type
             FROM financial_accounts a
             JOIN properties p
               ON p.household_id = a.household_id AND p.account_id = a.id
             WHERE p.household_id = $1 AND p.id = $2",
        )
        .bind(household)
        .bind(created.id)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        assert_eq!(account_type, "stocks");
    }

    // Snapshots preserve every holding field and decimal lexeme, and restore
    // recreates the ordered rows atomically along with their parent account.
    let snapshot = checkbook_postgres::backup::snapshot_household(&pool, household).await?;
    let archived_holdings = snapshot.tables["account_holdings"].clone();
    checkbook_postgres::backup::restore_household(&pool, household, context.user.id, &snapshot)
        .await?;
    let restored = checkbook_postgres::backup::snapshot_household(&pool, household).await?;
    assert_eq!(restored.tables["account_holdings"], archived_holdings);
    assert_eq!(restored.tables["properties"], snapshot.tables["properties"]);

    // Update replaces the holdings list wholesale.
    let updated = update_asset(
        &pool,
        household,
        created.id,
        input("account", vec![holding("VXUS", dec!(100))?])?,
    )
    .await?;
    assert_eq!(updated.holdings.len(), 1);
    assert_eq!(updated.holdings[0].name, "VXUS");
    assert_eq!(updated.holdings[0].quantity, Some(dec!(2)));

    // Converting the account clears its discriminators and holdings and
    // updates the linked financial-account classification.
    let converted =
        update_asset(&pool, household, created.id, input("property", Vec::new())?).await?;
    assert_eq!(converted.row.category, "property");
    assert!(converted.row.account_type.is_none());
    assert!(converted.row.account_registration.is_none());
    assert!(converted.holdings.is_empty());
    update_asset(
        &pool,
        household,
        created.id,
        input("account", vec![holding("Restored position", dec!(50))?])?,
    )
    .await?;

    // Projects cannot silently discard account-specific input.
    let mut project_input = input("account", Vec::new())?;
    project_input.kind = "project".to_owned();
    assert!(matches!(
        create_asset(&pool, household, project_input).await,
        Err(checkbook_postgres::assets::AssetStoreError::Validation(_))
    ));
    let mut project_input = input("property", Vec::new())?;
    project_input.kind = "project".to_owned();
    let project = create_asset(&pool, household, project_input).await?;
    assert!(matches!(
        update_asset(&pool, household, project.id, input("account", Vec::new())?).await,
        Err(checkbook_postgres::assets::AssetStoreError::Validation(_))
    ));

    // Deleting the property cascades its holdings away.
    delete_asset(&pool, household, created.id, "UTC").await?;
    let mut tx = tenant::begin(&pool, household, true).await?;
    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM account_holdings WHERE household_id = $1")
            .bind(household)
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;
    assert_eq!(
        remaining, 0,
        "holdings must cascade-delete with the account"
    );
    Ok(())
}

#[tokio::test]
async fn account_holdings_are_household_isolated_by_rls() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; account holdings RLS test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    migrate(&pool).await?;
    let identity = Uuid::new_v4();
    let first = create_development_session(
        &pool,
        &format!("holdings-first-{}@example.com", identity),
        "First",
        "owner",
        24,
    )
    .await?;
    let second = create_development_session(
        &pool,
        &format!("holdings-second-{}@example.com", identity),
        "Second",
        "owner",
        24,
    )
    .await?;
    let created = create_asset(
        &pool,
        first.household.id,
        input("account", vec![holding("VTI", dec!(750))?])?,
    )
    .await?;

    // The foreign household sees no holdings rows, even with an explicit
    // household_id filter, and cannot insert cross-household rows.
    let mut tx = tenant::begin(&pool, second.household.id, true).await?;
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM account_holdings")
        .fetch_one(&mut *tx)
        .await?;
    let visible_with_filter: i64 =
        sqlx::query_scalar("SELECT count(*) FROM account_holdings WHERE household_id = $1")
            .bind(first.household.id)
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;
    assert_eq!(visible, 0, "RLS must hide foreign holdings");
    assert_eq!(visible_with_filter, 0, "RLS must hide foreign holdings");

    let mut tx = tenant::begin(&pool, second.household.id, false).await?;
    let injected = sqlx::query(
        "INSERT INTO account_holdings (household_id, property_id, name, value)
         VALUES ($1, $2, 'Stolen', 1)",
    )
    .bind(second.household.id)
    .bind(created.id)
    .execute(&mut *tx)
    .await;
    tx.rollback().await?;
    assert!(
        injected.is_err(),
        "composite FK must reject foreign property"
    );

    let mut tx = tenant::begin(&pool, first.household.id, true).await?;
    let own: i64 =
        sqlx::query_scalar("SELECT count(*) FROM account_holdings WHERE household_id = $1")
            .bind(first.household.id)
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;
    assert_eq!(own, 1, "the owning household still sees its holdings");
    Ok(())
}
