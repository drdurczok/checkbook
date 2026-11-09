use std::{borrow::Cow, str::FromStr};

use checkbook_postgres::{MIGRATOR, bootstrap_application_role, tenant};
use serde_json::{Value, json};
use sqlx::{
    PgPool,
    migrate::Migrator,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use uuid::Uuid;

// Runtime queries intentionally exercise both pre-0017 and post-0017 schemas;
// the current-schema SQLx metadata cannot describe the legacy fixtures.
async fn seed_loan(
    pool: &PgPool,
    household_id: Uuid,
    name: &str,
    terms: Value,
) -> anyhow::Result<Uuid> {
    let account_id: Uuid = sqlx::query_scalar(
        "INSERT INTO financial_accounts
             (household_id, name, account_kind, account_type, owner_scope, source_key)
         VALUES ($1, $2, 'liability', 'loan', 'joint', $2) RETURNING id",
    )
    .bind(household_id)
    .bind(name)
    .fetch_one(pool)
    .await?;
    Ok(sqlx::query_scalar(
        "INSERT INTO loans
             (household_id, account_id, name, liability_type, owner_scope,
              original_balance, current_balance, terms_payload, source_key)
         VALUES ($1, $2, $3, 'loan', 'joint', 10000, 10000, $4, $3) RETURNING id",
    )
    .bind(household_id)
    .bind(account_id)
    .bind(name)
    .bind(terms)
    .fetch_one(pool)
    .await?)
}

async fn seed_payment(
    pool: &PgPool,
    household_id: Uuid,
    loan_id: Uuid,
    id: Uuid,
    date: &str,
    order: i32,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO loan_payments
             (id, household_id, loan_id, payment_date, total_payment, source_key,
              source_fingerprint, extra_payload, created_at)
         VALUES ($1, $2, $3, $4::text::date, 99.99, $1::text, 'legacy-fingerprint',
                 '{\"legacy\":true}', '2020-01-01'::timestamptz + $5 * interval '1 second')",
    )
    .bind(id)
    .bind(household_id)
    .bind(loan_id)
    .bind(date)
    .bind(order)
    .execute(pool)
    .await?;
    Ok(())
}

#[tokio::test]
async fn upgrades_legacy_schedule_without_rounding_or_calendar_inference() -> anyhow::Result<()> {
    let Ok(admin_url) = std::env::var("ADMIN_DATABASE_URL") else {
        eprintln!("ADMIN_DATABASE_URL is not set; loan-payment migration test skipped");
        return Ok(());
    };
    let Ok(app_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; loan-payment migration test skipped");
        return Ok(());
    };
    let app_password =
        std::env::var("DB_APP_PASSWORD").unwrap_or_else(|_| "checkbook-app".to_owned());
    let database_name = format!("checkbook_loan_migration_{}", Uuid::new_v4().simple());
    let admin_options = PgConnectOptions::from_str(&admin_url)?;
    let app_options = PgConnectOptions::from_str(&app_url)?;
    let maintenance = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(admin_options.clone())
        .await?;
    // This identifier contains only a fixed prefix and a locally generated UUID.
    sqlx::query(&format!("CREATE DATABASE {database_name}"))
        .execute(&maintenance)
        .await?;

    let result = async {
        let pool = PgPoolOptions::new().max_connections(2).connect_with(admin_options.database(&database_name)).await?;
        let legacy = Migrator {
            migrations: Cow::Owned(MIGRATOR.iter().filter(|migration| migration.version < 17).cloned().collect()),
            ..Migrator::DEFAULT
        };
        anyhow::ensure!(legacy.iter().count() == 16, "expected sixteen legacy migrations");
        legacy.run(&pool).await?;
        let household_id: Uuid = sqlx::query_scalar("INSERT INTO households (name) VALUES ('Loan migration') RETURNING id")
            .fetch_one(&pool).await?;
        let precise = "123.123456789123456789";
        let loan_id = seed_loan(&pool, household_id, "legacy", json!({
            "period_count": 360,
            "payment_schedule": [
                {"date":"2001-01-01", "payment":precise, "principal":"100.000000000000000001", "interest":"23.123456789123456788", "extra_principal":"0.000000000000000001", "outstanding_loan_balance":"9876.876543210876543211", "interest_balance":"0.123456789123456789", "projected":true},
                {"date":"2001-01-01", "payment":"20.000000000000000002", "outstanding_loan_balance":"9000.50", "completed":true, "projected":true},
                {"date":"2199-01-01", "payment":"30.000000000000000003", "principal":"10.00", "extra_principal":"2.00"},
                {"date":"2199-02-01", "payment":"40.000000000000000004", "principal":"999.00", "outstanding_loan_balance":"1.00", "completed":false, "projected":false},
                {"date":"2199-03-01", "payment":"50.000000000000000005", "principal":"5.00", "extra_principal":"0.25", "projected":false}
            ]
        })).await?;
        let empty_id = seed_loan(&pool, household_id, "empty", json!({"payment_schedule":[]})).await?;
        let absent_id = seed_loan(&pool, household_id, "absent", json!({"period_count":12})).await?;
        let first_id = Uuid::new_v4();
        let second_id = Uuid::new_v4();
        let retained_id = Uuid::new_v4();
        seed_payment(&pool, household_id, loan_id, first_id, "2001-01-01", 0).await?;
        seed_payment(&pool, household_id, loan_id, second_id, "2001-01-01", 1).await?;
        seed_payment(&pool, household_id, loan_id, Uuid::new_v4(), "2000-01-01", 0).await?;
        seed_payment(&pool, household_id, empty_id, Uuid::new_v4(), "2000-01-01", 0).await?;
        seed_payment(&pool, household_id, absent_id, retained_id, "2000-01-01", 0).await?;

        // Migration 0017's ON COMMIT DROP staging table requires a single transaction.
        let migration = MIGRATOR.iter().find(|migration| migration.version == 17)
            .ok_or_else(|| anyhow::anyhow!("migration 0017 missing"))?;
        let mut tx = pool.begin().await?;
        sqlx::raw_sql(&migration.sql).execute(&mut *tx).await?;
        tx.commit().await?;
        bootstrap_application_role(&pool, &app_password).await?;
        pool.close().await;

        let app_pool = PgPoolOptions::new().max_connections(1).connect_with(app_options.database(&database_name)).await?;
        let mut tx = tenant::begin(&app_pool, household_id, true).await?;
        let terms: Value = sqlx::query_scalar("SELECT terms_payload FROM loans WHERE id = $1")
            .bind(loan_id).fetch_one(&mut *tx).await?;
        assert_eq!(terms, json!({"period_count":360}));
        let legacy_schedules: i64 = sqlx::query_scalar("SELECT count(*) FROM loans WHERE terms_payload ? 'payment_schedule'")
            .fetch_one(&mut *tx).await?;
        assert_eq!(legacy_schedules, 0);
        let schedule: Value = sqlx::query_scalar("SELECT app.loan_terms_with_schedule(household_id, id, terms_payload)->'payment_schedule' FROM loans WHERE id = $1")
            .bind(loan_id).fetch_one(&mut *tx).await?;
        let rows = schedule.as_array().ok_or_else(|| anyhow::anyhow!("schedule is not an array"))?;
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[0], json!({
            "id": first_id, "date":"2001-01-01", "payment":precise,
            "principal":"100.000000000000000001", "interest":"23.123456789123456788",
            "extra_principal":"0.000000000000000001", "outstanding_loan_balance":"9876.876543210876543211",
            "interest_balance":"0.123456789123456789", "completed":false, "projected":true
        }));
        assert_eq!(rows[1], json!({"id":second_id, "date":"2001-01-01", "payment":"20.000000000000000002", "outstanding_loan_balance":"9000.50", "completed":true, "projected":false}));
        let balance: String = sqlx::query_scalar("SELECT current_balance::text FROM loans WHERE id = $1")
            .bind(loan_id).fetch_one(&mut *tx).await?;
        assert_eq!(balance, "8983.25");
        for (row, completed) in rows.iter().zip([false, true, true, false, true]) {
            assert_eq!(row["completed"], completed);
            assert_eq!(row["projected"], !completed);
        }
        let preserved: (String, String, Value) = sqlx::query_as("SELECT source_key, source_fingerprint, extra_payload FROM loan_payments WHERE id = $1")
            .bind(first_id).fetch_one(&mut *tx).await?;
        assert_eq!(preserved, (first_id.to_string(), "legacy-fingerprint".to_owned(), json!({"legacy":true})));
        let empty_count: i64 = sqlx::query_scalar("SELECT count(*) FROM loan_payments WHERE loan_id = $1")
            .bind(empty_id).fetch_one(&mut *tx).await?;
        assert_eq!(empty_count, 0);
        let retained: (Uuid, bool, String) = sqlx::query_as("SELECT id, completed, total_payment::text FROM loan_payments WHERE loan_id = $1")
            .bind(absent_id).fetch_one(&mut *tx).await?;
        assert_eq!(retained, (retained_id, true, "99.99".to_owned()));
        tx.commit().await?;
        app_pool.close().await;
        anyhow::Ok(())
    }.await;

    sqlx::query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()")
        .bind(&database_name).execute(&maintenance).await?;
    // Drop only the UUID-named isolated database created by this test.
    sqlx::query(&format!("DROP DATABASE IF EXISTS {database_name}"))
        .execute(&maintenance)
        .await?;
    maintenance.close().await;
    result
}
