use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use checkbook_api::{ApiState, router};
use checkbook_postgres::{auth::authenticate, connect, migrate, tenant};
use chrono::{Days, Utc};
use serde_json::{Value, json};
use tower::ServiceExt;

const BASE: &str = "/api/household/expenses/recurring";

async fn response_json(response: axum::response::Response) -> anyhow::Result<Value> {
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> anyhow::Result<axum::response::Response> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let body = if let Some(payload) = body {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        Body::from(payload.to_string())
    } else {
        Body::empty()
    };
    Ok(app.clone().oneshot(builder.body(body)?).await?)
}

async fn login(app: &Router) -> anyhow::Result<String> {
    let response = request(
        app,
        "POST",
        "/api/auth/dev-login",
        None,
        Some(json!({
            "email": format!("recurring-contract-{}@example.com", uuid::Uuid::new_v4()),
            "full_name": "Recurring Owner",
            "relationship_kind": "owner"
        })),
    )
    .await?;
    anyhow::ensure!(response.status() == StatusCode::OK);
    response_json(response).await?["token"]
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow::anyhow!("login token missing"))
}

#[tokio::test]
async fn recurring_expense_lifecycle_preserves_numeric_history_and_auth_boundaries()
-> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; recurring expense API contract test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    migrate(&pool).await?;
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
    let token = login(&app).await?;
    let other = login(&app).await?;
    let context = authenticate(&pool, &token).await?;
    let today = checkbook_domain::local_date_at(&context.household.timezone, Utc::now())?;
    let start = today + Days::new(30);
    let mut payload = json!({
        "description": "Contract recurring subscription",
        "amount": 12.34,
        "start_date": start,
        "end_date": null,
        "owner_scope": "joint",
        "category_name": "Contract subscriptions",
        "notes": "Recurring lifecycle"
    });

    for (method, body) in [("GET", None), ("POST", Some(payload.clone()))] {
        let response = request(&app, method, BASE, None, body).await?;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(response_json(response).await?["detail"].is_string());
    }
    let mut invalid = payload.clone();
    invalid["amount"] = json!(-1);
    let response = request(&app, "POST", BASE, Some(&token), Some(invalid)).await?;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(response_json(response).await?["detail"].is_string());

    let response = request(&app, "POST", BASE, Some(&token), Some(payload.clone())).await?;
    assert_eq!(response.status(), StatusCode::OK);
    let created = response_json(response).await?;
    let id = created["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("recurring expense id missing"))?;
    let path = format!("{BASE}/{id}");
    assert_eq!(created["amount"], json!(12.34));
    assert!(created["amount"].is_number());
    assert_eq!(created["cadence"], "monthly");
    assert_eq!(created["next_due_date"], start.to_string());
    assert_eq!(created["is_active"], true);
    assert!(created["category_id"].is_string());
    assert_eq!(created["price_history"].as_array().map(Vec::len), Some(1));
    assert_eq!(created["price_history"][0]["amount"], json!(12.34));
    assert!(created["price_history"][0]["amount"].is_number());
    assert!(created["price_history"][0]["changed_at"].is_string());

    let response = request(&app, "GET", BASE, Some(&token), None).await?;
    assert_eq!(response.status(), StatusCode::OK);
    let listed = response_json(response).await?;
    let listed = listed
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == id))
        .ok_or_else(|| anyhow::anyhow!("created schedule missing from list"))?;
    assert_eq!(listed, &created);

    payload["amount"] = json!(45.67);
    let response = request(&app, "PUT", &path, Some(&other), Some(payload.clone())).await?;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let response = request(&app, "PUT", &path, Some(&token), Some(payload)).await?;
    assert_eq!(response.status(), StatusCode::OK);
    let updated = response_json(response).await?;
    assert_eq!(updated["amount"], json!(45.67));
    assert_eq!(updated["price_history"].as_array().map(Vec::len), Some(2));
    assert_eq!(updated["price_history"][0]["amount"], json!(12.34));
    assert_eq!(updated["price_history"][1]["amount"], json!(45.67));
    assert!(updated["price_history"][1]["amount"].is_number());

    let response = request(
        &app,
        "POST",
        &format!("{path}/expense-now"),
        Some(&token),
        None,
    )
    .await?;
    assert_eq!(response.status(), StatusCode::OK);
    let expensed = response_json(response).await?;
    let expected_next = checkbook_domain::recurring_date(start, "monthly", 1)?;
    assert_eq!(expensed["next_due_date"], expected_next.to_string());
    assert_eq!(expensed["price_history"], updated["price_history"]);
    let mut transaction = tenant::begin(&pool, context.household.id, true).await?;
    // Verify the user action created an actual ledger expense, not just a cursor update.
    let source_pattern = format!("app_recurring:{id}:%");
    let entries = sqlx::query!(
        "SELECT direction, status, amount, entry_date FROM ledger_entries
         WHERE household_id = $1 AND source_key LIKE $2",
        context.household.id,
        source_pattern
    )
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].direction, "expense");
    assert_eq!(entries[0].status, "actual");
    assert_eq!(entries[0].amount, "45.67".parse::<rust_decimal::Decimal>()?);
    assert_eq!(entries[0].entry_date, Some(today));

    let response = request(&app, "POST", &format!("{path}/retire"), Some(&token), None).await?;
    assert_eq!(response.status(), StatusCode::OK);
    let retired = response_json(response).await?;
    assert_eq!(retired["is_active"], false);
    assert!(retired["next_due_date"].is_null());
    assert_eq!(retired["price_history"], updated["price_history"]);
    let response = request(&app, "GET", BASE, Some(&token), None).await?;
    assert_eq!(response.status(), StatusCode::OK);
    let listed = response_json(response).await?;
    let retired = listed
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == id))
        .ok_or_else(|| anyhow::anyhow!("retired schedule missing from list"))?;
    assert_eq!(retired["is_active"], false);
    assert!(retired["next_due_date"].is_null());
    let response = request(
        &app,
        "POST",
        &format!("{path}/expense-now"),
        Some(&token),
        None,
    )
    .await?;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    Ok(())
}
