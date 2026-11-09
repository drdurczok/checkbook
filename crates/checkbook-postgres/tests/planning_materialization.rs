use checkbook_postgres::{
    auth::create_development_session, connect, migrate, planning::materialize_household, tenant,
};
use chrono::NaiveDate;
use rust_decimal_macros::dec;

fn date(year: i32, month: u32, day: u32) -> anyhow::Result<NaiveDate> {
    NaiveDate::from_ymd_opt(year, month, day).ok_or_else(|| anyhow::anyhow!("invalid test date"))
}

#[tokio::test]
async fn planning_materialization_is_idempotent_and_suppresses_actual_income() -> anyhow::Result<()>
{
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL materialization test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    migrate(&pool).await?;
    let identity = uuid::Uuid::new_v4();
    let context = create_development_session(
        &pool,
        &format!("planning-{identity}@example.com"),
        "Planning Owner",
        "owner",
        24,
    )
    .await?;
    let household_id = context.household.id;
    let source_id = {
        let mut transaction = tenant::begin(&pool, household_id, false).await?;
        let source_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO income_sources
                (household_id, name, source_type, owner_scope, source_key)
             VALUES ($1, 'Salary', 'employment', 'joint', $2)
             RETURNING id",
        )
        .bind(household_id)
        .bind(format!("test:{identity}"))
        .fetch_one(&mut *transaction)
        .await?;
        for month in 9..=12 {
            sqlx::query(
                "INSERT INTO ledger_entries
                    (household_id, direction, status, amount, entry_date, description,
                     owner_scope, data_source, income_source_id, source_key)
                 VALUES ($1, 'income', 'actual', $2, $3, 'Salary',
                         'joint', 'app_manual', $4, $5)",
            )
            .bind(household_id)
            .bind(if month == 12 { dec!(1000) } else { dec!(100) })
            .bind(date(2025, month, 15)?)
            .bind(source_id)
            .bind(format!("test:{identity}:2025-{month}"))
            .execute(&mut *transaction)
            .await?;
        }
        for month in 1..=5 {
            sqlx::query(
                "INSERT INTO ledger_entries
                    (household_id, direction, status, amount, entry_date, description,
                     owner_scope, data_source, income_source_id, source_key)
                 VALUES ($1, 'income', 'actual', 100, $2, 'Salary',
                         'joint', 'app_manual', $3, $4)",
            )
            .bind(household_id)
            .bind(date(2026, month, 15)?)
            .bind(source_id)
            .bind(format!("test:{identity}:2026-{month}"))
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        source_id
    };

    let first = materialize_household(&pool, household_id, date(2026, 6, 21)?).await?;
    assert!(first.total_changes() > 0);
    let second = materialize_household(&pool, household_id, date(2026, 6, 21)?).await?;
    assert_eq!(second.total_changes(), 0);

    let mut read_transaction = tenant::begin(&pool, household_id, true).await?;
    let (count, minimum, maximum): (i64, rust_decimal::Decimal, rust_decimal::Decimal) =
        sqlx::query_as(
            "SELECT count(*), min(o.calculated_amount), max(o.calculated_amount)
             FROM planning_occurrences o
             JOIN planning_rules r ON r.id = o.planning_rule_id
             WHERE r.household_id = $1 AND r.stable_key = $2",
        )
        .bind(household_id)
        .bind(format!("system:income:source:{source_id}"))
        .fetch_one(&mut *read_transaction)
        .await?;
    read_transaction.commit().await?;
    assert_eq!(count, 84);
    assert_eq!(minimum, dec!(100));
    assert_eq!(maximum, dec!(100));

    {
        let mut transaction = tenant::begin(&pool, household_id, false).await?;
        sqlx::query(
            "INSERT INTO ledger_entries
                (household_id, direction, status, amount, entry_date, description,
                 owner_scope, data_source, income_source_id, source_key)
             VALUES ($1, 'income', 'actual', 100, $2, 'Salary',
                     'joint', 'app_manual', $3, $4)",
        )
        .bind(household_id)
        .bind(date(2026, 7, 15)?)
        .bind(source_id)
        .bind(format!("test:{identity}:2026-7"))
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
    }
    let suppressed = materialize_household(&pool, household_id, date(2026, 6, 21)?).await?;
    assert_eq!(suppressed.rules_changed, 0);
    assert_eq!(suppressed.occurrences_changed, 1);
    let final_run = materialize_household(&pool, household_id, date(2026, 6, 21)?).await?;
    assert_eq!(final_run.total_changes(), 0);
    Ok(())
}
