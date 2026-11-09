use checkbook_postgres::{
    auth::create_development_session,
    connect, tenant,
    utilities::{self, UtilityEntryValueInput, UtilityUpsertInput},
    utility_contracts::{self, ContractCreate},
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use uuid::Uuid;

#[tokio::test]
async fn contract_dates_allow_historical_corrections_and_reject_outside_months()
-> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; utility lifecycle test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let context = create_development_session(
        &pool,
        &format!("lifecycle-{}@example.com", Uuid::new_v4()),
        "Owner",
        "owner",
        24,
    )
    .await?;
    let household = context.household.id;
    let mut tx = tenant::begin(&pool, household, false).await?;
    let property=sqlx::query_scalar!("INSERT INTO properties (household_id,name,category,valuation,valuation_date,status,data_source,utilities_enabled,expenses_enabled) VALUES ($1,'Lifecycle house','property',100,CURRENT_DATE,'active','app_manual',true,true) RETURNING id",household).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    let date = |value: &str| NaiveDate::parse_from_str(value, "%Y-%m-%d");
    let contract = utility_contracts::create(
        &pool,
        household,
        context.user.id,
        ContractCreate {
            color: None,
            property_id: property,
            label: "Expired contract".to_owned(),
            tracking_mode: "actual".to_owned(),
            unit: String::new(),
            start_date: date("2020-02-15")?,
            end_date: Some(date("2020-03-15")?),
            initial_price: None,
        },
    )
    .await?;
    let scopes = vec!["joint".to_owned()];
    let today = date("2026-11-01")?;
    let save = |month: &str, amount: i64| -> anyhow::Result<UtilityUpsertInput> {
        Ok(UtilityUpsertInput {
            month: month.to_owned(),
            month_start: date(&format!("{month}-01"))?,
            completed: None,
            entries: vec![UtilityEntryValueInput {
                field_key: contract.key.clone(),
                amount: Some(Decimal::from(amount)),
                amount_source: Some("actual".to_owned()),
                meter_reading: None,
                usage_amount: None,
            }],
            base_currency: "PLN".to_owned(),
            household_timezone: "Europe/Warsaw".to_owned(),
        })
    };
    for month in ["2020-02", "2020-03"] {
        utilities::upsert(
            &pool,
            household,
            Some(property),
            None,
            save(month, 10)?,
            today,
            &scopes,
        )
        .await?;
    }
    utilities::upsert(
        &pool,
        household,
        Some(property),
        None,
        save("2020-02", 20)?,
        today,
        &scopes,
    )
    .await?;
    for month in ["2020-01", "2020-04"] {
        assert!(
            utilities::upsert(
                &pool,
                household,
                Some(property),
                None,
                save(month, 10)?,
                today,
                &scopes
            )
            .await
            .is_err()
        );
        assert!(
            utilities::form(
                &pool,
                household,
                Some(property),
                None,
                month.to_owned(),
                date(&format!("{month}-01"))?,
                &scopes
            )
            .await?
            .fields
            .is_empty()
        );
    }
    let board = utilities::board(&pool, household, Some(property), None, 0, today, &scopes).await?;
    assert_eq!(board.subject.tracked_fields.len(), 1);
    assert!(board.subject.tracked_fields[0].retired);
    assert_eq!(
        board.subject.tracked_fields[0].contract_id,
        Some(contract.id)
    );
    assert_eq!(board.subject.tracked_fields[0].property_id, Some(property));
    let other = create_development_session(
        &pool,
        &format!("lifecycle-other-{}@example.com", Uuid::new_v4()),
        "Other",
        "owner",
        24,
    )
    .await?;
    assert!(
        utilities::form(
            &pool,
            other.household.id,
            Some(property),
            None,
            "2020-02".to_owned(),
            date("2020-02-01")?,
            &scopes
        )
        .await
        .is_err()
    );
    assert!(
        utilities::reassign(
            &pool,
            household,
            property,
            property,
            &scopes,
            "Europe/Warsaw"
        )
        .await
        .is_err()
    );
    Ok(())
}
