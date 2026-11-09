use checkbook_postgres::{
    auth::create_development_session,
    connect, tenant,
    utilities::UtilityStoreError,
    utility_contracts::{self, ContractCreate, ContractUpdate, PriceInput},
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use uuid::Uuid;

fn date(value: &str) -> anyhow::Result<NaiveDate> {
    Ok(NaiveDate::parse_from_str(value, "%Y-%m-%d")?)
}

#[tokio::test]
async fn contract_prices_preserve_actual_amounts_validate_coverage_and_isolate_tenants()
-> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; utility contracts test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let context = create_development_session(
        &pool,
        &format!("contracts-{}@example.com", Uuid::new_v4()),
        "Contract owner",
        "owner",
        24,
    )
    .await?;
    let household = context.household.id;
    let actor = context.user.id;
    let mut tx = tenant::begin(&pool, household, false).await?;
    let property = sqlx::query_scalar!(
        "INSERT INTO properties (household_id,name,category,valuation,valuation_date,status,data_source,utilities_enabled,expenses_enabled)
         VALUES ($1,'Contracts house','property',100,CURRENT_DATE,'active','app_manual',true,true) RETURNING id", household
    ).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    let input = ContractCreate {
        color: None,
        property_id: property,
        label: "Water".to_owned(),
        tracking_mode: "usage".to_owned(),
        unit: "m3".to_owned(),
        start_date: date("2026-01-15")?,
        end_date: None,
        initial_price: Some(Decimal::from(2)),
    };
    assert!(matches!(
        utility_contracts::create(
            &pool,
            household,
            actor,
            ContractCreate {
                initial_price: None,
                ..input.clone()
            }
        )
        .await,
        Err(UtilityStoreError::Validation(_))
    ));
    let contract = utility_contracts::create(&pool, household, actor, input).await?;
    let initial = utility_contracts::prices(&pool, household, contract.id).await?;
    assert_eq!(initial.len(), 1);
    assert_eq!(initial[0].effective_on, date("2026-01-01")?);
    let mut tx = tenant::begin(&pool, household, false).await?;
    for (month, source, amount) in [
        ("2026-02-01", "auto", 20_i64),
        ("2026-03-01", "actual", 77_i64),
        ("2026-04-01", "auto", 20_i64),
    ] {
        sqlx::query!(
            "INSERT INTO utility_bills (household_id,property_id,service_id,utility_contract_id,provider,description,amount,currency,charge_date,owner_scope,data_source,usage_amount,unit_rate,entry_mode,amount_source,source_key)
             SELECT $1,$2,service_id,id,'Water','Water',$4,'PLN',$5,'joint','app_manual',10,2,'usage',$6,'contract-test:' || id::text || ':' || $5::date::text
             FROM utility_contracts WHERE household_id=$1 AND id=$3",
            household, property, contract.id, Decimal::from(amount), date(month)?, source
        ).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    let april = utility_contracts::save_price(
        &pool,
        household,
        actor,
        contract.id,
        None,
        PriceInput {
            effective_on: date("2026-04-22")?,
            price: Decimal::from(4),
        },
    )
    .await?;
    assert_eq!(april.effective_on, date("2026-04-01")?);
    utility_contracts::save_price(
        &pool,
        household,
        actor,
        contract.id,
        Some(initial[0].id),
        PriceInput {
            effective_on: date("2026-01-20")?,
            price: Decimal::from(3),
        },
    )
    .await?;
    let mut tx = tenant::begin(&pool, household, true).await?;
    let bills = sqlx::query!("SELECT amount,unit_rate,amount_source FROM utility_bills WHERE household_id=$1 AND utility_contract_id=$2 ORDER BY charge_date",household,contract.id).fetch_all(&mut *tx).await?;
    assert_eq!(bills.len(), 3);
    assert_eq!(bills[0].amount, Decimal::from(30));
    assert_eq!(bills[1].amount, Decimal::from(77));
    assert_eq!(bills[1].unit_rate, Some(Decimal::from(2)));
    assert_eq!(bills[2].amount, Decimal::from(40));
    tx.commit().await?;
    for input in [
        PriceInput {
            effective_on: date("2026-04-01")?,
            price: Decimal::ONE,
        },
        PriceInput {
            effective_on: date("2026-05-01")?,
            price: Decimal::NEGATIVE_ONE,
        },
        PriceInput {
            effective_on: date("2026-05-01")?,
            price: Decimal::new(1, 7),
        },
    ] {
        assert!(matches!(
            utility_contracts::save_price(&pool, household, actor, contract.id, None, input).await,
            Err(UtilityStoreError::Validation(_))
        ));
    }
    assert!(matches!(
        utility_contracts::save_price(
            &pool,
            household,
            actor,
            contract.id,
            Some(initial[0].id),
            PriceInput {
                effective_on: date("2026-02-01")?,
                price: Decimal::ONE
            }
        )
        .await,
        Err(UtilityStoreError::Validation(_))
    ));
    for (mode, unit) in [("meter", "m3"), ("usage", "kWh")] {
        assert!(matches!(
            utility_contracts::update(
                &pool,
                household,
                actor,
                contract.id,
                ContractUpdate {
                    color: None,
                    label: "Water".to_owned(),
                    tracking_mode: mode.to_owned(),
                    unit: unit.to_owned(),
                    start_date: date("2026-01-15")?,
                    end_date: None,
                }
            )
            .await,
            Err(UtilityStoreError::Validation(_))
        ));
    }
    for (start_date, end_date) in [
        (date("2026-03-01")?, None),
        (date("2026-01-15")?, Some(date("2026-03-31")?)),
    ] {
        assert!(matches!(
            utility_contracts::update(
                &pool,
                household,
                actor,
                contract.id,
                ContractUpdate {
                    color: None,
                    label: "Rejected lifetime".to_owned(),
                    tracking_mode: "usage".to_owned(),
                    unit: "m3".to_owned(),
                    start_date,
                    end_date,
                }
            )
            .await,
            Err(UtilityStoreError::Validation(_))
        ));
    }
    let unchanged =
        utility_contracts::list(&pool, household, property, date("2026-07-01")?).await?;
    let unchanged = unchanged
        .iter()
        .find(|row| row.id == contract.id)
        .ok_or_else(|| anyhow::anyhow!("contract missing"))?;
    assert_eq!(unchanged.start_date, date("2026-01-15")?);
    assert_eq!(unchanged.end_date, None);
    assert_eq!(unchanged.label, "Water");
    // February and April bills fall on day one; narrowing within their months is valid.
    let updated = utility_contracts::update(
        &pool,
        household,
        actor,
        contract.id,
        ContractUpdate {
            color: None,
            label: "Renamed water".to_owned(),
            tracking_mode: "usage".to_owned(),
            unit: "m3".to_owned(),
            start_date: date("2026-02-28")?,
            end_date: Some(date("2026-04-01")?),
        },
    )
    .await?;
    assert_eq!(updated.property_id, property);
    let listed = utility_contracts::list(&pool, household, property, date("2026-07-01")?).await?;
    assert!(
        listed
            .iter()
            .any(|row| row.id == contract.id && row.retired)
    );
    let other = create_development_session(
        &pool,
        &format!("contracts-other-{}@example.com", Uuid::new_v4()),
        "Other owner",
        "owner",
        24,
    )
    .await?;
    assert!(matches!(
        utility_contracts::prices(&pool, other.household.id, contract.id).await,
        Err(UtilityStoreError::NotFound)
    ));
    assert!(matches!(
        utility_contracts::save_price(
            &pool,
            other.household.id,
            other.user.id,
            contract.id,
            None,
            PriceInput {
                effective_on: date("2026-01-01")?,
                price: Decimal::ONE
            }
        )
        .await,
        Err(UtilityStoreError::NotFound)
    ));
    let fixed = utility_contracts::create(
        &pool,
        household,
        actor,
        ContractCreate {
            color: None,
            property_id: property,
            label: "Rent".to_owned(),
            tracking_mode: "fixed".to_owned(),
            unit: String::new(),
            start_date: date("2026-01-01")?,
            end_date: None,
            initial_price: Some(Decimal::from(100)),
        },
    )
    .await?;
    let mut tx = tenant::begin(&pool, household, false).await?;
    sqlx::query!(
        "INSERT INTO utility_bills (household_id,property_id,service_id,utility_contract_id,provider,description,amount,currency,charge_date,owner_scope,data_source,amount_source,source_key)
         SELECT $1,$2,service_id,id,'Rent','Rent',100,'PLN','2026-01-01'::date,'joint','app_manual','auto','contract-test:' || id::text || ':2026-01-01'
         FROM utility_contracts WHERE household_id=$1 AND id=$3", household, property, fixed.id
    ).execute(&mut *tx).await?;
    tx.commit().await?;
    let initial_fixed = utility_contracts::prices(&pool, household, fixed.id).await?;
    utility_contracts::save_price(
        &pool,
        household,
        actor,
        fixed.id,
        Some(initial_fixed[0].id),
        PriceInput {
            effective_on: date("2026-01-01")?,
            price: Decimal::from(150),
        },
    )
    .await?;
    let mut tx = tenant::begin(&pool, household, true).await?;
    let fixed_amount = sqlx::query_scalar!(
        "SELECT amount FROM utility_bills WHERE household_id=$1 AND utility_contract_id=$2",
        household,
        fixed.id
    )
    .fetch_one(&mut *tx)
    .await?;
    assert_eq!(fixed_amount, Decimal::from(150));
    let count=sqlx::query_scalar!("SELECT count(*) FROM audit_events WHERE household_id=$1 AND resource_type='utility_contract' AND resource_id=$2",household,contract.id).fetch_one(&mut *tx).await?;
    assert_eq!(count, Some(4));
    tx.commit().await?;
    Ok(())
}
