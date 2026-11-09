use checkbook_postgres::{
    auth::create_development_session,
    connect, tenant, utilities,
    utility_contracts::{self, ContractCreate, ContractUpdate},
};
use chrono::NaiveDate;
use uuid::Uuid;

#[tokio::test]
async fn property_contract_order_and_identity_survive_duplicate_names_and_retirement()
-> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; utility ordering test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let owner = create_development_session(
        &pool,
        &format!("order-{}@example.com", Uuid::new_v4()),
        "Owner",
        "owner",
        24,
    )
    .await?;
    let household = owner.household.id;
    let actor = owner.user.id;
    let mut tx = tenant::begin(&pool, household, false).await?;
    let mut properties = Vec::new();
    for name in ["First house", "Second house"] {
        properties.push(sqlx::query_scalar!(
            "INSERT INTO properties (household_id,name,category,valuation,valuation_date,status,data_source,utilities_enabled,expenses_enabled,source_key)
             VALUES ($1,$2,'property',100,CURRENT_DATE,'active','app_manual',true,true,'contract-order:' || $2::text) RETURNING id",
            household, name
        ).fetch_one(&mut *tx).await?);
    }
    tx.commit().await?;
    let today = NaiveDate::parse_from_str("2026-11-01", "%Y-%m-%d")?;
    let start = NaiveDate::parse_from_str("2026-01-01", "%Y-%m-%d")?;
    let input = |property_id, label: &str| ContractCreate {
        color: Some("#018aFc".to_owned()),
        property_id,
        label: label.to_owned(),
        tracking_mode: "actual".to_owned(),
        unit: String::new(),
        start_date: start,
        end_date: None,
        initial_price: None,
    };
    assert!(
        utility_contracts::list(&pool, household, properties[0], today)
            .await?
            .is_empty()
    );
    let first = utility_contracts::create(
        &pool,
        household,
        actor,
        input(properties[0], "Water & Sewer"),
    )
    .await?;
    let duplicate = utility_contracts::create(
        &pool,
        household,
        actor,
        input(properties[0], "Water & Sewer"),
    )
    .await?;
    let third =
        utility_contracts::create(&pool, household, actor, input(properties[0], "AAA new")).await?;
    let elsewhere = utility_contracts::create(
        &pool,
        household,
        actor,
        input(properties[1], "Water & Sewer"),
    )
    .await?;
    assert_ne!(first.id, duplicate.id);
    assert_ne!(first.key, duplicate.key);
    assert_ne!(first.key, elsewhere.key);
    assert_eq!(
        (first.sort_order, duplicate.sort_order, third.sort_order),
        (0, 1, 2)
    );
    assert_eq!(elsewhere.sort_order, 0);
    let ids = |rows: Vec<utility_contracts::ContractRecord>| {
        rows.into_iter().map(|row| row.id).collect::<Vec<_>>()
    };
    assert_eq!(
        ids(utility_contracts::list(&pool, household, properties[0], today).await?),
        vec![first.id, duplicate.id, third.id]
    );
    assert_eq!(
        ids(utility_contracts::list(&pool, household, properties[1], today).await?),
        vec![elsewhere.id]
    );
    let retired = utility_contracts::update(
        &pool,
        household,
        actor,
        first.id,
        ContractUpdate {
            color: None,
            label: "Renamed water".to_owned(),
            tracking_mode: "actual".to_owned(),
            unit: String::new(),
            start_date: start,
            end_date: Some(NaiveDate::parse_from_str("2026-06-30", "%Y-%m-%d")?),
        },
    )
    .await?;
    assert_eq!(retired.id, first.id);
    assert_eq!(retired.key, first.key);
    assert_eq!(retired.sort_order, 0);
    let contracts = utility_contracts::list(&pool, household, properties[0], today).await?;
    // Contract order is property-local creation order, not alphabetical or retired-last.
    assert_eq!(contracts[0].id, first.id);
    assert!(contracts[0].retired);
    assert_eq!(contracts[0].label, "Renamed water");
    assert_eq!(contracts[1].id, duplicate.id);
    assert_eq!(contracts[1].label, "Water & Sewer");
    let board = utilities::board(
        &pool,
        household,
        Some(properties[0]),
        None,
        12,
        today,
        &["joint".to_owned()],
    )
    .await?;
    assert!(
        board
            .subject
            .tracked_fields
            .iter()
            .all(|field| field.color.as_deref() == Some("#018aFc"))
    );
    assert_eq!(
        board
            .subject
            .tracked_fields
            .into_iter()
            .map(|field| field.key)
            .collect::<Vec<_>>(),
        vec![first.key, duplicate.key, third.key]
    );
    let fourth = utility_contracts::create(
        &pool,
        household,
        actor,
        input(properties[0], "Water & Sewer"),
    )
    .await?;
    assert_eq!(fourth.sort_order, 3);
    assert_eq!(
        ids(utility_contracts::list(&pool, household, properties[0], today).await?),
        vec![first.id, duplicate.id, third.id, fourth.id]
    );
    Ok(())
}
