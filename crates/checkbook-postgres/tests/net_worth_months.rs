use checkbook_postgres::{
    auth::create_development_session,
    connect,
    dashboard::{DashboardFilter, load_overview_data},
    net_worth_months::{NetWorthComponentInput, upsert_month},
    tenant,
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use uuid::Uuid;

fn month(month: u32) -> anyhow::Result<NaiveDate> {
    NaiveDate::from_ymd_opt(2026, month, 1).ok_or_else(|| anyhow::anyhow!("invalid test month"))
}

fn component(group_key: &str, label: &str, value: Decimal) -> NetWorthComponentInput {
    NetWorthComponentInput {
        group_key: group_key.to_owned(),
        label: label.to_owned(),
        value,
    }
}

#[tokio::test]
async fn curated_months_persist_reopen_and_stay_household_isolated() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; net worth month integration test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let context = create_development_session(
        &pool,
        &format!("net-worth-months-{}@example.com", Uuid::new_v4()),
        "Net Worth Owner",
        "owner",
        24,
    )
    .await?;
    let household = context.household.id;
    let february = month(2)?;

    // Seed snapshot-derived history for two months.
    {
        let mut tx = tenant::begin(&pool, household, false).await?;
        let investing: Uuid = sqlx::query_scalar(
            "INSERT INTO financial_accounts (household_id, name, account_kind, account_type, owner_scope, source_key)
             VALUES ($1, 'Broker', 'asset', 'investing', 'joint', 'test:broker') RETURNING id",
        )
        .bind(household)
        .fetch_one(&mut *tx)
        .await?;
        let liability: Uuid = sqlx::query_scalar(
            "INSERT INTO financial_accounts (household_id, name, account_kind, account_type, owner_scope, source_key)
             VALUES ($1, 'Mortgage', 'liability', 'loan', 'joint', 'test:mortgage') RETURNING id",
        )
        .bind(household)
        .fetch_one(&mut *tx)
        .await?;
        for (index, account, balance) in [(1, investing, dec!(1000)), (2, liability, dec!(400))] {
            sqlx::query(
                "INSERT INTO account_balance_snapshots
                     (household_id, account_id, effective_date, balance, source_key, data_source)
                 VALUES ($1, $2, $3, $4, $5, 'app_manual')",
            )
            .bind(household)
            .bind(account)
            .bind(month(index)?)
            .bind(balance)
            .bind(format!("test:{account}:{index}"))
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
    }

    let records = || async {
        let data = load_overview_data(
            &pool,
            household,
            &["self".to_owned(), "spouse".to_owned(), "joint".to_owned()],
            DashboardFilter::default(),
            month(3)?,
        )
        .await?;
        anyhow::Ok(data.net_worth_records)
    };

    // A curated month can be created directly as completed.
    upsert_month(
        &pool,
        household,
        month(2)?,
        true,
        vec![
            component("investing", "ETF", dec!(300)),
            component("debt", "Mortgage", dec!(150)),
        ],
    )
    .await?;
    let stored = records().await?;
    let record = stored
        .iter()
        .find(|record| record.period == february)
        .ok_or_else(|| anyhow::anyhow!("curated month missing"))?;
    assert_eq!(
        record.components,
        vec![
            component("debt", "Mortgage", dec!(150)),
            component("investing", "ETF", dec!(300)),
        ]
    );

    // Snapshot recalculations cannot alter the canonical completed month.
    {
        let mut tx = tenant::begin(&pool, household, false).await?;
        sqlx::query("UPDATE account_balance_snapshots SET balance = 99999 WHERE household_id = $1")
            .bind(household)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    let after_recalculation = records().await?;
    let frozen_record = after_recalculation
        .iter()
        .find(|record| record.period == february)
        .ok_or_else(|| anyhow::anyhow!("canonical month missing"))?;
    assert!(frozen_record.completed);
    assert_eq!(frozen_record.components, record.components);

    let scoped = load_overview_data(
        &pool,
        household,
        &["joint".to_owned()],
        DashboardFilter::default(),
        month(3)?,
    )
    .await?;
    assert!(
        scoped.net_worth_records.is_empty(),
        "restricted scopes must not see household-wide manual values"
    );
    let filtered = load_overview_data(
        &pool,
        household,
        &["self".to_owned(), "spouse".to_owned(), "joint".to_owned()],
        DashboardFilter {
            start_date: Some(month(3)?),
            ..DashboardFilter::default()
        },
        month(3)?,
    )
    .await?;
    assert!(filtered.net_worth_records.is_empty());
    let future = load_overview_data(
        &pool,
        household,
        &["self".to_owned(), "spouse".to_owned(), "joint".to_owned()],
        DashboardFilter::default(),
        month(1)?,
    )
    .await?;
    // Months curated past today stay visible: a newly added future month
    // must keep showing its data instead of vanishing until it arrives.
    let future_record = future
        .net_worth_records
        .iter()
        .find(|record| record.period == february)
        .ok_or_else(|| anyhow::anyhow!("curated month past today missing"))?;
    assert!(future_record.completed);

    // Component edits are rejected while completed, even alongside a new period.
    let frozen = upsert_month(
        &pool,
        household,
        month(2)?,
        true,
        vec![component("investing", "ETF", dec!(301))],
    )
    .await;
    assert!(matches!(
        frozen,
        Err(checkbook_postgres::assets::AssetStoreError::Validation(_))
    ));

    // An identical save stays accepted (idempotent completion).
    upsert_month(
        &pool,
        household,
        month(2)?,
        true,
        vec![
            component("investing", "ETF", dec!(300)),
            component("debt", "Mortgage", dec!(150)),
        ],
    )
    .await?;

    // Reopening unlocks the month for edits in the same request.
    upsert_month(
        &pool,
        household,
        month(2)?,
        false,
        vec![
            component("investing", "ETF", dec!(310)),
            component("savings", "Cash", dec!(40)),
        ],
    )
    .await?;
    let stored = records().await?;
    let record = stored
        .iter()
        .find(|record| record.period == february)
        .ok_or_else(|| anyhow::anyhow!("reopened month missing"))?;
    assert!(!record.completed);
    assert_eq!(record.components.len(), 2);
    assert!(
        record
            .components
            .iter()
            .any(|item| item.group_key == "savings" && item.label == "Cash")
    );

    // RLS: a foreign household sees none of these months and cannot inject one.
    let outsider = create_development_session(
        &pool,
        &format!("net-worth-outsider-{}@example.com", Uuid::new_v4()),
        "Outsider",
        "owner",
        24,
    )
    .await?;
    let foreign = upsert_month(
        &pool,
        outsider.household.id,
        month(2)?,
        false,
        vec![component("investing", "Stolen", dec!(1))],
    )
    .await?;
    assert_eq!(foreign.period, month(2)?);
    let mut tx = tenant::begin(&pool, household, true).await?;
    let visible: i64 =
        sqlx::query_scalar("SELECT count(*) FROM net_worth_months WHERE period = $1")
            .bind(month(2)?)
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;
    assert_eq!(visible, 1, "only the household's own month is visible");
    let mut tx = tenant::begin(&pool, outsider.household.id, false).await?;
    let stolen: i64 =
        sqlx::query_scalar("SELECT count(*) FROM net_worth_month_components WHERE label = 'ETF'")
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;
    assert_eq!(stolen, 0);
    Ok(())
}
