use std::str::FromStr;

use checkbook_postgres::{bootstrap_application_role, migrate, ready};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

#[tokio::test]
async fn migrates_empty_database_bootstraps_app_role_and_reports_ready() -> anyhow::Result<()> {
    let Ok(admin_database_url) = std::env::var("ADMIN_DATABASE_URL") else {
        eprintln!("ADMIN_DATABASE_URL is not set; migrate-from-empty test skipped");
        return Ok(());
    };
    let Ok(app_database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; migrate-from-empty test skipped");
        return Ok(());
    };
    let app_password =
        std::env::var("DB_APP_PASSWORD").unwrap_or_else(|_| "checkbook-app".to_owned());
    let database_name = format!("checkbook_migrate_{}", uuid::Uuid::new_v4().simple());
    let admin_options = PgConnectOptions::from_str(&admin_database_url)?;
    let app_options = PgConnectOptions::from_str(&app_database_url)?;
    let maintenance_pool = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(admin_options.clone())
        .await?;

    sqlx::query(&format!("CREATE DATABASE {database_name}"))
        .execute(&maintenance_pool)
        .await?;

    let result = async {
        let admin_pool = PgPoolOptions::new()
            .max_connections(5)
            .connect_with(admin_options.database(&database_name))
            .await?;
        anyhow::ensure!(
            !ready(&admin_pool).await,
            "empty database unexpectedly reported ready before migration"
        );

        migrate(&admin_pool).await?;
        anyhow::ensure!(
            !ready(&admin_pool).await,
            "admin connection reported ready before app-role bootstrap"
        );

        bootstrap_application_role(&admin_pool, &app_password).await?;
        admin_pool.close().await;

        let app_pool = PgPoolOptions::new()
            .max_connections(2)
            .connect_with(app_options.database(&database_name))
            .await?;
        anyhow::ensure!(
            ready(&app_pool).await,
            "bootstrapped application role did not report ready"
        );
        let audit_privileges = sqlx::query_as::<_, (bool, bool, bool)>(
            "SELECT
                has_table_privilege(current_user, 'audit_events', 'INSERT'),
                has_table_privilege(current_user, 'audit_events', 'UPDATE'),
                has_table_privilege(current_user, 'audit_events', 'DELETE')",
        )
        .fetch_one(&app_pool)
        .await?;
        anyhow::ensure!(
            audit_privileges == (true, false, false),
            "audit_events privileges are not restricted: {audit_privileges:?}"
        );
        let holding_privileges = sqlx::query_as::<_, (bool, bool, bool, bool, bool, bool)>(
            "SELECT
                has_table_privilege(current_user, 'account_holdings', 'SELECT'),
                has_table_privilege(current_user, 'account_holdings', 'INSERT'),
                has_table_privilege(current_user, 'account_holdings', 'UPDATE'),
                has_table_privilege(current_user, 'account_holdings', 'DELETE'),
                relrowsecurity, relforcerowsecurity
             FROM pg_class WHERE oid = 'account_holdings'::regclass",
        )
        .fetch_one(&app_pool)
        .await?;
        anyhow::ensure!(
            holding_privileges == (true, true, true, true, true, true),
            "account_holdings privileges/RLS are not ready: {holding_privileges:?}"
        );
        let cache_privileges = sqlx::query_as::<_, (bool, bool, bool, bool, bool, bool)>(
            "SELECT has_table_privilege(current_user, 'holding_price_cache', 'SELECT'), has_table_privilege(current_user, 'holding_price_cache', 'INSERT'), has_table_privilege(current_user, 'holding_price_cache', 'UPDATE'), has_table_privilege(current_user, 'holding_price_cache', 'DELETE'), relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'holding_price_cache'::regclass"
        ).fetch_one(&app_pool).await?;
        anyhow::ensure!(cache_privileges == (true, true, true, true, true, true), "holding_price_cache privileges/RLS not ready: {cache_privileges:?}");
        app_pool.close().await;
        anyhow::Ok(())
    }
    .await;

    sqlx::query(
        "SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()",
    )
    .bind(&database_name)
    .execute(&maintenance_pool)
    .await?;
    sqlx::query(&format!("DROP DATABASE IF EXISTS {database_name}"))
        .execute(&maintenance_pool)
        .await?;
    maintenance_pool.close().await;
    result
}
