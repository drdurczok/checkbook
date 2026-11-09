use checkbook_postgres::{
    auth::create_development_session,
    connect, tenant,
    utilities::{self, UtilityEntryValueInput, UtilityUpsertInput},
    utility_contracts::{self, ContractCreate, PriceInput},
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use uuid::Uuid;

#[tokio::test]
async fn effective_prices_actual_overrides_and_meter_corrections() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; utility pricing test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let context = create_development_session(
        &pool,
        &format!("pricing-{}@example.com", Uuid::new_v4()),
        "Owner",
        "owner",
        24,
    )
    .await?;
    let household = context.household.id;
    let mut tx = tenant::begin(&pool, household, false).await?;
    let property = sqlx::query_scalar!("INSERT INTO properties (household_id,name,category,valuation,valuation_date,status,data_source,utilities_enabled,expenses_enabled) VALUES ($1,'Pricing house','property',100,CURRENT_DATE,'active','app_manual',true,true) RETURNING id", household).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    let date = |value: &str| NaiveDate::parse_from_str(value, "%Y-%m-%d");
    let today = date("2026-11-01")?;
    let contract = utility_contracts::create(
        &pool,
        household,
        context.user.id,
        ContractCreate {
            color: Some("#aB12Ef".to_owned()),
            property_id: property,
            label: "Water".to_owned(),
            tracking_mode: "meter".to_owned(),
            unit: "m3".to_owned(),
            start_date: date("2026-01-01")?,
            end_date: None,
            initial_price: Some(Decimal::from(2)),
        },
    )
    .await?;
    let scopes = vec!["joint".to_owned()];
    let save = |month: &str,
                reading: i64,
                amount: Option<i64>,
                source: &str|
     -> anyhow::Result<UtilityUpsertInput> {
        Ok(UtilityUpsertInput {
            month: month.to_owned(),
            month_start: date(&format!("{month}-01"))?,
            completed: None,
            entries: vec![UtilityEntryValueInput {
                field_key: contract.key.clone(),
                amount: amount.map(Decimal::from),
                amount_source: Some(source.to_owned()),
                meter_reading: Some(Decimal::from(reading)),
                usage_amount: None,
            }],
            base_currency: "PLN".to_owned(),
            household_timezone: "Europe/Warsaw".to_owned(),
        })
    };
    for (month, reading, amount, source) in [
        ("2026-01", 100, None, "auto"),
        ("2026-03", 160, Some(77), "actual"),
        ("2026-02", 130, None, "auto"),
    ] {
        utilities::upsert(
            &pool,
            household,
            Some(property),
            None,
            save(month, reading, amount, source)?,
            today,
            &scopes,
        )
        .await?;
    }
    let march = utilities::form(
        &pool,
        household,
        Some(property),
        None,
        "2026-03".to_owned(),
        date("2026-03-01")?,
        &scopes,
    )
    .await?;
    assert_eq!(march.fields[0].amount, Some(Decimal::from(77)));
    assert_eq!(march.fields[0].amount_source, "actual");
    assert_eq!(march.fields[0].usage_amount, Some(Decimal::from(30)));
    utility_contracts::save_price(
        &pool,
        household,
        context.user.id,
        contract.id,
        None,
        PriceInput {
            effective_on: date("2026-03-01")?,
            price: Decimal::from(3),
        },
    )
    .await?;
    let march = utilities::form(
        &pool,
        household,
        Some(property),
        None,
        "2026-03".to_owned(),
        date("2026-03-01")?,
        &scopes,
    )
    .await?;
    assert_eq!(march.fields[0].amount, Some(Decimal::from(77)));
    assert_eq!(march.fields[0].unit_rate, Some(Decimal::from(3)));
    utilities::upsert(
        &pool,
        household,
        Some(property),
        None,
        save("2026-03", 160, None, "auto")?,
        today,
        &scopes,
    )
    .await?;
    let march = utilities::form(
        &pool,
        household,
        Some(property),
        None,
        "2026-03".to_owned(),
        date("2026-03-01")?,
        &scopes,
    )
    .await?;
    assert_eq!(march.fields[0].amount, Some(Decimal::from(90)));
    assert_eq!(march.fields[0].amount_source, "auto");
    utilities::upsert(
        &pool,
        household,
        Some(property),
        None,
        save("2026-02", 140, None, "auto")?,
        today,
        &scopes,
    )
    .await?;
    let march = utilities::form(
        &pool,
        household,
        Some(property),
        None,
        "2026-03".to_owned(),
        date("2026-03-01")?,
        &scopes,
    )
    .await?;
    assert_eq!(march.fields[0].amount, Some(Decimal::from(60)));
    let fixed = utility_contracts::create(
        &pool,
        household,
        context.user.id,
        ContractCreate {
            color: None,
            property_id: property,
            label: "Internet".to_owned(),
            tracking_mode: "fixed".to_owned(),
            unit: String::new(),
            start_date: date("2026-01-01")?,
            end_date: None,
            initial_price: Some(Decimal::from(30)),
        },
    )
    .await?;
    let mut input = save("2026-04", 160, None, "auto")?;
    input.entries = vec![UtilityEntryValueInput {
        field_key: fixed.key.clone(),
        amount: None,
        amount_source: Some("auto".to_owned()),
        meter_reading: None,
        usage_amount: None,
    }];
    utilities::upsert(
        &pool,
        household,
        Some(property),
        None,
        input,
        today,
        &scopes,
    )
    .await?;
    let april = utilities::form(
        &pool,
        household,
        Some(property),
        None,
        "2026-04".to_owned(),
        date("2026-04-01")?,
        &scopes,
    )
    .await?;
    assert_eq!(
        april
            .fields
            .iter()
            .find(|field| field.key == fixed.key)
            .and_then(|field| field.amount),
        Some(Decimal::from(30))
    );
    assert_eq!(contract.color.as_deref(), Some("#aB12Ef"));
    assert_eq!(march.fields[0].color.as_deref(), Some("#aB12Ef"));
    let update = |color| utility_contracts::ContractUpdate {
        color,
        label: contract.label.clone(),
        tracking_mode: contract.tracking_mode.clone(),
        unit: contract.unit.clone(),
        start_date: contract.start_date,
        end_date: contract.end_date,
    };
    for color in [
        "red",
        "#fff",
        "#12345g",
        "#1234567",
        "#123456\n",
        "#\u{ff11}23456",
    ] {
        assert!(matches!(
            utility_contracts::update(
                &pool,
                household,
                context.user.id,
                contract.id,
                update(Some(Some(color.to_owned())))
            )
            .await,
            Err(utilities::UtilityStoreError::Validation(_))
        ));
    }
    let preserved =
        utility_contracts::update(&pool, household, context.user.id, contract.id, update(None))
            .await?;
    assert_eq!(preserved.color.as_deref(), Some("#aB12Ef"));
    let listed = utility_contracts::list(&pool, household, property, today).await?;
    assert_eq!(
        listed
            .iter()
            .find(|row| row.id == contract.id)
            .and_then(|row| row.color.as_deref()),
        Some("#aB12Ef")
    );
    let cleared = utility_contracts::update(
        &pool,
        household,
        context.user.id,
        contract.id,
        update(Some(None)),
    )
    .await?;
    assert_eq!(cleared.color, None);
    let mut tx = tenant::begin(&pool, household, true).await?;
    let changes = sqlx::query_scalar!("SELECT payload FROM audit_events WHERE household_id=$1 AND resource_id=$2 AND event_type='utility_contract_updated' ORDER BY created_at", household, contract.id).fetch_all(&mut *tx).await?;
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[1]["before"]["color"], "#aB12Ef");
    assert!(changes[1]["after"]["color"].is_null());
    tx.commit().await?;
    Ok(())
}
