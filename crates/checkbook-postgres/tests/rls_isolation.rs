use checkbook_postgres::{auth::create_development_session, connect, migrate, ready, tenant};

#[tokio::test]
async fn forced_rls_hides_cross_household_rows_even_from_the_table_owner() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL RLS test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    migrate(&pool).await?;
    assert!(ready(&pool).await);
    let audit_privileges = sqlx::query_as::<_, (bool, bool, bool)>(
        "SELECT
            has_table_privilege(current_user, 'audit_events', 'INSERT'),
            has_table_privilege(current_user, 'audit_events', 'UPDATE'),
            has_table_privilege(current_user, 'audit_events', 'DELETE')",
    )
    .fetch_one(&pool)
    .await?;
    assert_eq!(audit_privileges, (true, false, false));
    let identity = uuid::Uuid::new_v4();
    let first = create_development_session(
        &pool,
        &format!("rls-first-{identity}@example.com"),
        "RLS First",
        "owner",
        24,
    )
    .await?;
    let second = create_development_session(
        &pool,
        &format!("rls-second-{identity}@example.com"),
        "RLS Second",
        "owner",
        24,
    )
    .await?;
    {
        let mut transaction = tenant::begin(&pool, second.household.id, false).await?;
        sqlx::query(
            "INSERT INTO buyers (household_id, name)
             VALUES ($1, 'Second household buyer')",
        )
        .bind(second.household.id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
    }
    let mut transaction = tenant::begin(&pool, first.household.id, true).await?;
    let visible_without_filter: i64 = sqlx::query_scalar("SELECT count(*) FROM buyers")
        .fetch_one(&mut *transaction)
        .await?;
    let visible_with_foreign_filter: i64 =
        sqlx::query_scalar("SELECT count(*) FROM buyers WHERE household_id = $1")
            .bind(second.household.id)
            .fetch_one(&mut *transaction)
            .await?;
    transaction.commit().await?;
    assert_eq!(visible_without_filter, 0);
    assert_eq!(visible_with_foreign_filter, 0);
    Ok(())
}
