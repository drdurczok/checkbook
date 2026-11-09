use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use checkbook_api::{ApiState, router};
use checkbook_postgres::{auth::create_development_session, connect, migrate};
use serde_json::Value;
use tower::ServiceExt;
use utoipa::OpenApi;

#[test]
fn suggestions_have_a_typed_required_contract() -> anyhow::Result<()> {
    let doc = serde_json::to_value(checkbook_api::ApiDoc::openapi())?;
    let operation = &doc["paths"]["/api/household/expenses/suggestions"]["get"];
    assert_eq!(operation["operationId"], "getExpenseNameSuggestions");
    assert_eq!(
        operation["responses"]["200"]["content"]["application/json"]["schema"]["type"],
        "array"
    );
    let schema = &doc["components"]["schemas"]["ExpenseNameSuggestion"];
    for field in [
        "description",
        "category_id",
        "category_name",
        "expense_group_id",
    ] {
        assert!(
            schema["required"]
                .as_array()
                .is_some_and(|fields| fields.iter().any(|value| value == field))
        );
    }
    Ok(())
}

#[tokio::test]
async fn suggestions_authenticate_and_validate_bounded_queries() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; expense suggestions API test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    migrate(&pool).await?;
    let owner = create_development_session(
        &pool,
        &format!("suggestion-api-{}@example.com", uuid::Uuid::new_v4()),
        "Owner",
        "owner",
        24,
    )
    .await?;
    let token = owner
        .token
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("missing session token"))?;
    let app = router(
        ApiState {
            pool: pool.clone(),
            dev_auth_enabled: true,
            session_hours: 24,
            cloudflare: None,
            google: None,
            backup_admin_root: None,
        },
        Vec::new(),
    );
    for (query, token, expected) in [
        ("coffee".to_owned(), None, StatusCode::UNAUTHORIZED),
        (
            "coffee".to_owned(),
            Some("invalid"),
            StatusCode::UNAUTHORIZED,
        ),
        ("c".to_owned(), Some(token), StatusCode::OK),
        ("".to_owned(), Some(token), StatusCode::OK),
        (
            "c".repeat(121),
            Some(token),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
    ] {
        let mut request =
            Request::builder().uri(format!("/api/household/expenses/suggestions?query={query}"));
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = app.clone().oneshot(request.body(Body::empty())?).await?;
        assert_eq!(response.status(), expected);
        let json: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await?)?;
        if expected == StatusCode::OK {
            assert_eq!(json, serde_json::json!([]));
        } else {
            assert!(json["detail"].is_string());
        }
    }
    let category = checkbook_postgres::expenses::create_category(
        &pool,
        owner.household.id,
        checkbook_postgres::expenses::ExpenseCategoryInput {
            name: "API history category".to_owned(),
            expense_group_id: None,
            sort_order: 0,
            is_retired: None,
        },
    )
    .await?;
    let mut tx = checkbook_postgres::tenant::begin(&pool, owner.household.id, false).await?;
    sqlx::query("INSERT INTO ledger_entries (id, household_id, source_key, direction, status, amount, entry_date, description, owner_scope, data_source, category_id) VALUES ($1,$2,$3,'expense','actual',1,'2020-01-01','Coffee history','self','app_manual',$4)")
        .bind(uuid::Uuid::new_v4()).bind(owner.household.id).bind(uuid::Uuid::new_v4().to_string())
        .bind(category.id).execute(&mut *tx).await?;
    tx.commit().await?;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/household/expenses/suggestions?query=coffee")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    let json: Value = serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await?)?;
    assert_eq!(
        json,
        serde_json::json!([{
            "description": "Coffee history", "category_id": category.id,
            "category_name": "API history category", "expense_group_id": null,
        }])
    );
    Ok(())
}
