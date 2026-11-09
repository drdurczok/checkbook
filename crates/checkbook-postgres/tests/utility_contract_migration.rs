use std::{borrow::Cow, str::FromStr};

use checkbook_postgres::MIGRATOR;
use sqlx::{
    Row,
    migrate::Migrator,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use uuid::Uuid;

// Runtime SQL intentionally targets both the legacy and current schemas.
#[tokio::test]
async fn preserves_bills_reading_chains_and_unowned_legacy_data() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("ADMIN_DATABASE_URL") else {
        eprintln!("ADMIN_DATABASE_URL missing; utility contract migration test skipped");
        return Ok(());
    };
    let options = PgConnectOptions::from_str(&url)?;
    let maintenance = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(options.clone())
        .await?;
    let name = format!("checkbook_utility_migration_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&maintenance)
        .await?;
    let result = async {
        let pool = PgPoolOptions::new().max_connections(1).connect_with(options.database(&name)).await?;
        let legacy = Migrator { migrations: Cow::Owned(MIGRATOR.iter().filter(|m| m.version < 33).cloned().collect()), ..Migrator::DEFAULT };
        legacy.run(&pool).await?;
        let household: Uuid = sqlx::query_scalar("INSERT INTO households(name) VALUES ('Utility migration') RETURNING id").fetch_one(&pool).await?;
        let property: Uuid = sqlx::query_scalar("INSERT INTO properties(household_id,name,valuation_date,status,data_source) VALUES ($1,'Home','2020-01-01','active','app_manual') RETURNING id").bind(household).fetch_one(&pool).await?;
        let other: Uuid = sqlx::query_scalar("INSERT INTO properties(household_id,name,valuation_date,status,data_source,source_key) VALUES ($1,'Other','2020-01-01','active','app_manual','other') RETURNING id").bind(household).fetch_one(&pool).await?;
        let service: Uuid = sqlx::query_scalar("INSERT INTO utility_services(household_id,service_key,label,service_kind,unit,unit_rate,retired) VALUES ($1,'power','Power','metered','kWh',0.123456,true) RETURNING id").bind(household).fetch_one(&pool).await?;
        for p in [property,other] {
            sqlx::query("INSERT INTO utility_subject_services(household_id,property_id,service_id) VALUES ($1,$2,$3)").bind(household).bind(p).bind(service).execute(&pool).await?;
        }
        let group: Uuid = sqlx::query_scalar("INSERT INTO entry_groups(household_id,kind,name) VALUES ($1,'contract','Legacy unknown owner') RETURNING id").bind(household).fetch_one(&pool).await?;
        let standalone: Uuid = sqlx::query_scalar("INSERT INTO utility_bills(household_id,contract_id,service_id,provider,description,amount,charge_date,owner_scope,data_source) VALUES ($1,$2,$3,'Legacy','unowned',7.77,'2020-01-01','joint','app_manual') RETURNING id").bind(household).bind(group).bind(service).fetch_one(&pool).await?;
        let first = Uuid::new_v4(); let second = Uuid::new_v4();
        for (id,date) in [(first,"2020-01-01"),(second,"2020-02-01")] {
            sqlx::query("INSERT INTO utility_bills(id,household_id,property_id,service_id,provider,description,amount,charge_date,owner_scope,data_source,unit_rate,entry_mode,source_key) VALUES ($1,$2,$3,$4,'Provider','preserve',12.34,$5::text::date,'joint','app_manual',0.123456,'meter',$1::text)").bind(id).bind(household).bind(property).bind(service).bind(date).execute(&pool).await?;
        }
        let reading: Uuid = sqlx::query_scalar("INSERT INTO utility_meter_readings(household_id,utility_bill_id,reading,unit) VALUES ($1,$2,100,'kWh') RETURNING id").bind(household).bind(first).fetch_one(&pool).await?;
        sqlx::query("INSERT INTO utility_meter_readings(household_id,utility_bill_id,previous_reading_id,reading,unit) VALUES ($1,$2,$3,200,'kWh')").bind(household).bind(second).bind(reading).execute(&pool).await?;
        MIGRATOR.run(&pool).await?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM utility_contracts WHERE household_id=$1 AND end_date IS NULL").bind(household).fetch_one(&pool).await?;
        anyhow::ensure!(count==2,"expected bill and link-only property contracts, no inferred retirement");
        let preserved: i64 = sqlx::query_scalar("SELECT count(*) FROM utility_bills WHERE id IN ($1,$2) AND amount=12.34 AND unit_rate=0.123456 AND amount_source='auto' AND utility_contract_id IS NOT NULL AND source_key=id::text").bind(first).bind(second).fetch_one(&pool).await?;
        anyhow::ensure!(preserved==2,"bill identity/financial snapshots changed");
        let legacy_unchanged: bool = sqlx::query_scalar("SELECT utility_contract_id IS NULL AND service_id=$2 AND amount=7.77 AND amount_source='actual' FROM utility_bills WHERE id=$1").bind(standalone).bind(service).fetch_one(&pool).await?;
        anyhow::ensure!(legacy_unchanged,"unknown ownership must remain unmapped");
        let imports: i64 = sqlx::query_scalar("SELECT count(*) FROM utility_contract_import_sources WHERE household_id=$1 AND source_service_key='power'").bind(household).fetch_one(&pool).await?;
        anyhow::ensure!(imports==2,"original importer identity mapping lost");
        let previous: Uuid = sqlx::query_scalar("SELECT previous_reading_id FROM utility_meter_readings WHERE utility_bill_id=$1").bind(second).fetch_one(&pool).await?;
        anyhow::ensure!(previous==reading,"meter chain changed");
        let originals: i64 = sqlx::query_scalar("SELECT count(*) FROM utility_services WHERE id=$1 AND retired").bind(service).fetch_one(&pool).await?;
        anyhow::ensure!(originals==1,"original provenance service lost");
        let prices: i64 = sqlx::query_scalar("SELECT count(*) FROM utility_contract_prices WHERE household_id=$1 AND price=0.123456").bind(household).fetch_one(&pool).await?;
        anyhow::ensure!(prices==3,"bill snapshots and link-only initial price were not preserved");
        let moved = sqlx::query("UPDATE utility_contracts SET property_id=$1 WHERE property_id=$2").bind(other).bind(property).execute(&pool).await;
        anyhow::ensure!(moved.is_err(),"property reassignment must be blocked");
        pool.close().await;
        Ok::<(),anyhow::Error>(())
    }.await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&maintenance)
        .await?;
    result
}

// Automatic contracts whose earliest bill was an actual observation still need
// a price covering the start month; a rate cleared after priced history keeps
// automatic tracking derived from the latest priced bill.
#[tokio::test]
async fn automatic_contracts_keep_start_month_coverage_and_rate_cleared_tracking()
-> anyhow::Result<()> {
    let Ok(url) = std::env::var("ADMIN_DATABASE_URL") else {
        eprintln!("ADMIN_DATABASE_URL missing; utility contract coverage migration test skipped");
        return Ok(());
    };
    let options = PgConnectOptions::from_str(&url)?;
    let maintenance = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(options.clone())
        .await?;
    let name = format!("checkbook_utility_coverage_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&maintenance)
        .await?;
    let result = async {
        let pool = PgPoolOptions::new().max_connections(1).connect_with(options.database(&name)).await?;
        let legacy = Migrator { migrations: Cow::Owned(MIGRATOR.iter().filter(|m| m.version < 33).cloned().collect()), ..Migrator::DEFAULT };
        legacy.run(&pool).await?;
        let household: Uuid = sqlx::query_scalar("INSERT INTO households(name) VALUES ('Coverage') RETURNING id").fetch_one(&pool).await?;
        let mixed: Uuid = sqlx::query_scalar("INSERT INTO properties(household_id,name,valuation_date,status,data_source,source_key) VALUES ($1,'Mixed','2020-01-01','active','app_manual','coverage-mixed') RETURNING id").bind(household).fetch_one(&pool).await?;
        let cleared: Uuid = sqlx::query_scalar("INSERT INTO properties(household_id,name,valuation_date,status,data_source,source_key) VALUES ($1,'Cleared','2020-01-01','active','app_manual','coverage-cleared') RETURNING id").bind(household).fetch_one(&pool).await?;
        let rated: Uuid = sqlx::query_scalar("INSERT INTO utility_services(household_id,service_key,label,service_kind,unit,unit_rate,entry_mode) VALUES ($1,'rated','Rated','metered','kWh',0.5,'meter') RETURNING id").bind(household).fetch_one(&pool).await?;
        let rateless: Uuid = sqlx::query_scalar("INSERT INTO utility_services(household_id,service_key,label,service_kind,unit,unit_rate,entry_mode) VALUES ($1,'cleared','Cleared','metered','kWh',NULL,'meter') RETURNING id").bind(household).fetch_one(&pool).await?;
        for (property, tag) in [(mixed, "m"), (cleared, "c")] {
            let service = if property == mixed { rated } else { rateless };
            sqlx::query("INSERT INTO utility_subject_services(household_id,property_id,service_id) VALUES ($1,$2,$3)").bind(household).bind(property).bind(service).execute(&pool).await?;
            // January is an actual observation with no tariff evidence.
            sqlx::query("INSERT INTO utility_bills(household_id,property_id,service_id,provider,description,amount,charge_date,owner_scope,data_source,entry_mode,source_key) VALUES ($1,$2,$3,'P','jan',9.01,'2020-01-05','joint','app_manual','meter',$4)").bind(household).bind(property).bind(service).bind(format!("{tag}-jan")).execute(&pool).await?;
            // February carries the priced snapshot.
            sqlx::query("INSERT INTO utility_bills(household_id,property_id,service_id,provider,description,amount,charge_date,owner_scope,data_source,entry_mode,unit_rate,source_key) VALUES ($1,$2,$3,'P','feb',12.34,'2020-02-05','joint','app_manual','meter',0.42,$4)").bind(household).bind(property).bind(service).bind(format!("{tag}-feb")).execute(&pool).await?;
        }
        MIGRATOR.run(&pool).await?;
        for (property, expected_jan) in [(mixed, "0.500000"), (cleared, "0.420000")] {
            let (contract, tracking): (Uuid, String) = sqlx::query(
                "SELECT id, tracking_mode FROM utility_contracts WHERE household_id=$1 AND property_id=$2",
            )
            .bind(household)
            .bind(property)
            .map(|row| (row.get(0), row.get(1)))
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(tracking == "meter", "expected derived automatic tracking, got {tracking}");
            let jan_price: Option<String> = sqlx::query_scalar("SELECT price::text FROM utility_contract_prices WHERE household_id=$1 AND utility_contract_id=$2 AND effective_on='2020-01-01'").bind(household).bind(contract).fetch_optional(&pool).await?;
            anyhow::ensure!(jan_price.as_deref() == Some(expected_jan), "start month price {jan_price:?} != {expected_jan}");
            let feb_price: String = sqlx::query_scalar("SELECT price::text FROM utility_contract_prices WHERE household_id=$1 AND utility_contract_id=$2 AND effective_on='2020-02-01'").bind(household).bind(contract).fetch_one(&pool).await?;
            anyhow::ensure!(feb_price == "0.420000", "february snapshot changed: {feb_price}");
            let amounts: Vec<(String, String)> = sqlx::query("SELECT amount::text,amount_source FROM utility_bills WHERE household_id=$1 AND utility_contract_id=$2 ORDER BY charge_date").bind(household).bind(contract)
                .map(|row| (row.get(0), row.get(1))).fetch_all(&pool).await?;
            anyhow::ensure!(amounts == vec![("9.01".into(), "actual".into()), ("12.34".into(), "auto".into())], "bill amounts or sources changed: {amounts:?}");
        }
        pool.close().await;
        Ok::<(),anyhow::Error>(())
    }.await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&maintenance)
        .await?;
    result
}
