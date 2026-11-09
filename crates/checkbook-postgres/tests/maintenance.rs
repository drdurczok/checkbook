use checkbook_postgres::{
    auth::create_development_session, connect, maintenance::run_once, migrate,
};

#[tokio::test]
async fn application_role_can_run_global_maintenance_without_bypassing_rls() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL maintenance test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    migrate(&pool).await?;
    let identity = uuid::Uuid::new_v4();
    let context = create_development_session(
        &pool,
        &format!("maintenance-{identity}@example.com"),
        "Maintenance Owner",
        "owner",
        -1,
    )
    .await?;

    let result = run_once(&pool).await?;
    assert!(result.households_processed >= 1);
    assert!(result.sessions_deleted >= 1);

    let session_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE user_id = $1)")
            .bind(context.user.id)
            .fetch_one(&pool)
            .await?;
    assert!(!session_exists);
    Ok(())
}
