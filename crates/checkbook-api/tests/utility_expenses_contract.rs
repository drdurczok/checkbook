use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use checkbook_api::{ApiState, router};
use checkbook_postgres::{auth::create_development_session, connect, tenant};
use serde_json::Value;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn expense_board_identifies_projected_utility_source() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; utility expense API test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    let identity = Uuid::new_v4();
    let context = create_development_session(
        &pool,
        &format!("utility-api-{identity}@example.com"),
        "Utility owner",
        "owner",
        24,
    )
    .await?;
    let token = context
        .token
        .ok_or_else(|| anyhow::anyhow!("session token missing"))?;
    let household_id = context.household.id;
    let mut tx = tenant::begin(&pool, household_id, false).await?;
    let property_id = sqlx::query_scalar!(
        "INSERT INTO properties (household_id, name, category, valuation, valuation_date,
             status, data_source, source_key)
         VALUES ($1, 'Utility API house', 'property', 100, CURRENT_DATE, 'active', 'app_manual', $2)
         RETURNING id",
        household_id,
        format!("utility-api:{identity}")
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let app = router(
        ApiState {
            pool,
            dev_auth_enabled: true,
            session_hours: 24,
            cloudflare: None,
            google: None,
            backup_admin_root: None,
        },
        Vec::new(),
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/household/expenses/board")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4 * 1024 * 1024).await?)?;
    let categories = body["categories"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("categories missing"))?;
    let utilities = categories
        .iter()
        .find(|row| row["id"] == property_id.to_string())
        .ok_or_else(|| anyhow::anyhow!("utility projection missing"))?;
    assert_eq!(utilities["utility_property_id"], property_id.to_string());
    assert_eq!(utilities["name"], "Utilities");
    assert_eq!(utilities["is_source_linked"], true);
    assert_eq!(utilities["can_delete"], false);
    assert_eq!(utilities["entry_count"], 0);
    assert!(utilities["expense_group_id"].is_string());
    assert!(
        categories
            .iter()
            .filter(|row| row["id"] != property_id.to_string())
            .all(|row| row["utility_property_id"].is_null())
    );
    Ok(())
}
