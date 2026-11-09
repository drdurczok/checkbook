pub mod archive;
pub mod assets;
pub mod auth;
pub mod backup;
pub mod bulk_import;
pub mod dashboard;
pub mod data_loads;
pub mod expenses;
pub mod holding_prices;
pub mod household;
pub mod imports;
pub mod invoices;
mod loan_payments;
pub mod maintenance;
pub mod net_worth_months;
pub mod payday;
pub mod planning;
pub mod records;
pub mod recurring_expenses;
pub mod seed;
pub mod settings;
pub mod tenant;
pub mod utilities;
pub mod utility_contracts;

use std::time::Duration;

use sqlx::{PgPool, postgres::PgPoolOptions};

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub async fn connect(database_url: &str, max_connections: u32) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(5))
        .idle_timeout(Duration::from_secs(600))
        .max_lifetime(Duration::from_secs(1_800))
        .after_connect(|connection, _metadata| {
            Box::pin(async move {
                // Per-connection session GUCs. These are fixed `SET` utility statements with no
                // binds and no caller input; Postgres cannot describe/prepare `SET`, so the
                // compile-checked `query!` macro is not applicable here.
                for statement in [
                    "SET statement_timeout = '60s'",
                    "SET lock_timeout = '5s'",
                    "SET idle_in_transaction_session_timeout = '60s'",
                ] {
                    sqlx::query(statement).execute(&mut *connection).await?;
                }
                Ok(())
            })
        })
        .connect(database_url)
        .await
}

pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    if ready(pool).await {
        return Ok(());
    }
    MIGRATOR.run(pool).await
}

pub async fn bootstrap_application_role(pool: &PgPool, password: &str) -> Result<(), sqlx::Error> {
    let quoted_password = sqlx::query!(
        r#"SELECT quote_literal($1) AS "quoted_password!""#,
        password
    )
    .fetch_one(pool)
    .await?
    .quoted_password;
    let exists = sqlx::query!(
        r#"SELECT EXISTS(
            SELECT 1 FROM pg_roles WHERE rolname = 'checkbook_app'
        ) AS "exists!""#
    )
    .fetch_one(pool)
    .await?
    .exists;
    if !exists {
        // Role/DDL bootstrap. `CREATE ROLE` is a utility statement that Postgres cannot
        // describe/prepare, so `query!` is not applicable; the statement is a fixed literal
        // with no caller input.
        sqlx::query(
            "CREATE ROLE checkbook_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT",
        )
        .execute(pool)
        .await?;
    }
    // Intentionally dynamic: the password literal is produced by Postgres' own `quote_literal`
    // (see `quoted_password` above), never string-formatted from raw input. `ALTER ROLE` is a
    // non-preparable utility statement, so this cannot be a macro.
    sqlx::query(&format!(
        "ALTER ROLE checkbook_app PASSWORD {quoted_password}"
    ))
    .execute(pool)
    .await?;
    let grant_database = sqlx::query!(
        r#"SELECT format(
            'GRANT CONNECT ON DATABASE %I TO checkbook_app',
            current_database()
         ) AS "grant_database!""#
    )
    .fetch_one(pool)
    .await?
    .grant_database;
    // Intentionally dynamic: the GRANT text is assembled by Postgres' `format(... %I ...,
    // current_database())` (identifier-quoted server-side), not from caller input. `GRANT` is a
    // non-preparable utility statement.
    sqlx::query(&grant_database).execute(pool).await?;
    // Fixed GRANT/REVOKE/ALTER DEFAULT PRIVILEGES bootstrap statements (no binds, no caller
    // input). These are non-preparable utility statements, so `query!` is not applicable.
    for statement in [
        "GRANT USAGE ON SCHEMA public TO checkbook_app",
        "GRANT USAGE ON SCHEMA app TO checkbook_app",
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO checkbook_app",
        "REVOKE UPDATE, DELETE ON TABLE audit_events FROM checkbook_app",
        "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO checkbook_app",
        "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO checkbook_app",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public
             GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO checkbook_app",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public
             GRANT USAGE, SELECT ON SEQUENCES TO checkbook_app",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA app
             GRANT EXECUTE ON FUNCTIONS TO checkbook_app",
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

pub async fn ready(pool: &PgPool) -> bool {
    let exists = sqlx::query!(
        r#"SELECT EXISTS(
            SELECT 1 FROM pg_catalog.pg_tables
            WHERE schemaname = 'public' AND tablename = '_sqlx_migrations'
         ) AS "exists!""#
    )
    .fetch_one(pool)
    .await
    .map(|row| row.exists)
    .unwrap_or(false);
    if !exists {
        return false;
    }
    let Ok(applied) = sqlx::query!(
        "SELECT version, success, checksum
         FROM _sqlx_migrations
         ORDER BY version"
    )
    .fetch_all(pool)
    .await
    else {
        return false;
    };
    let migrations_ready = applied.len() == MIGRATOR.migrations.len()
        && applied
            .iter()
            .zip(MIGRATOR.migrations.iter())
            .all(|(row, migration)| {
                row.success
                    && row.version == migration.version
                    && row.checksum.as_slice() == migration.checksum.as_ref()
            });
    if !migrations_ready {
        return false;
    }

    let Ok(privileges) = sqlx::query!(
        r#"SELECT
            has_table_privilege(current_user, 'audit_events', 'INSERT') AS "can_insert!",
            has_table_privilege(current_user, 'audit_events', 'UPDATE') AS "can_update!",
            has_table_privilege(current_user, 'audit_events', 'DELETE') AS "can_delete!""#,
    )
    .fetch_one(pool)
    .await
    else {
        return false;
    };
    privileges.can_insert && !privileges.can_update && !privileges.can_delete
}
