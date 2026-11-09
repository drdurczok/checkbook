use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use checkbook_api::{ApiState, router};
use checkbook_postgres::{auth::authenticate, connect, migrate, tenant};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

async fn response_json(response: axum::response::Response) -> anyhow::Result<Value> {
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

async fn test_router() -> anyhow::Result<Option<(Router, PgPool)>> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        return Ok(None);
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
    Ok(Some((app, pool)))
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

async fn login(app: &Router, relationship: &str) -> anyhow::Result<String> {
    let response = request(
        app,
        "POST",
        "/api/auth/dev-login",
        None,
        Some(json!({
            "email": format!("import-api-{}@example.com", uuid::Uuid::new_v4()),
            "full_name": "Import Contract",
            "relationship_kind": relationship
        })),
    )
    .await?;
    anyhow::ensure!(response.status() == StatusCode::OK);
    let payload = response_json(response).await?;
    payload["token"]
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow::anyhow!("token missing"))
}

#[tokio::test]
async fn bulk_load_history_raw_data_and_bulk_import_match_the_frontend_contract()
-> anyhow::Result<()> {
    let Some((app, pool)) = test_router().await? else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let token = login(&app, "owner").await?;
    let context = authenticate(&pool, &token).await?;
    let mut transaction = tenant::begin(&pool, context.household.id, false).await?;
    sqlx::query(
        "INSERT INTO ledger_entries
            (household_id, direction, status, amount, currency, entry_date,
             description, owner_scope, data_source)
         VALUES ($1,'expense','actual',125.50,'PLN','2026-06-01',
                 'Contract expense','joint','app_manual')",
    )
    .bind(context.household.id)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "INSERT INTO data_load_runs
            (household_id, idempotency_key, status, archive_version, counts,
             warnings, errors, archive_path, archive_sha256, committed_at)
         VALUES ($1,$2,'committed',2,$3,'[]'::jsonb,'[]'::jsonb,
                 '/tmp/contract.zip',$4,now())",
    )
    .bind(context.household.id)
    .bind(format!("contract-{}", uuid::Uuid::new_v4()))
    .bind(json!({"inserted": 1}))
    .bind("contract-digest")
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;

    let history = request(&app, "GET", "/api/imports/history", Some(&token), None).await?;
    assert_eq!(history.status(), StatusCode::OK);
    let history = response_json(history).await?;
    let first = history
        .as_array()
        .and_then(|runs| runs.first())
        .ok_or_else(|| anyhow::anyhow!("import history missing"))?;
    assert_eq!(first["source_type"], "bulk_archive");
    assert_eq!(first["status"], "committed");
    assert_eq!(first["counts"]["inserted"], 1);
    assert!(first["warnings"].is_array());
    assert!(first["started_at"].is_string());
    assert!(first["finished_at"].is_string());

    let raw = request(&app, "GET", "/api/imports/raw-data", Some(&token), None).await?;
    assert_eq!(raw.status(), StatusCode::OK);
    let raw = response_json(raw).await?;
    let tables = raw["tables"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("raw tables missing"))?;
    assert_eq!(tables.len(), 7);
    let expenses = tables
        .iter()
        .find(|table| table["key"] == "expenses")
        .ok_or_else(|| anyhow::anyhow!("expenses table missing"))?;
    assert_eq!(expenses["label"], "Expenses");
    assert_eq!(expenses["count"], 1);
    assert_eq!(expenses["rows"][0]["description"], "Contract expense");
    assert_eq!(expenses["rows"][0]["amount"], "125.50");
    let bulk = request(
        &app,
        "POST",
        "/api/imports/bulk",
        Some(&token),
        Some(json!({
            "source": "contract-test",
            "expenses": [{
                "source_key": "contract:bulk:expense:1",
                "entry_date": "2026-06-02",
                "amount": 42.0,
                "description": "Bulk import expense",
                "owner_scope": "joint",
                "category": "Food"
            }],
            "properties": [{
                "source_key": "contract:property:1",
                "name": "Test Flat",
                "valuation": 500000.0,
                "valuation_date": "2026-01-01",
                "status": "active",
                "projects": [{
                    "source_key": "contract:project:1",
                    "name": "Renovation",
                    "budget": 10000.0,
                    "rooms": [{
                        "name": "Bathroom",
                        "sections": [{
                            "name": "Tiling",
                            "items": [{"name": "Tiles", "unit_price": 45.0, "quantity": 6.0, "total_cost": 270.0}]
                        }]
                    }]
                }]
            }],
            "utilities": [{
                "service_key": "rent",
                "label": "Rent",
                "service_kind": "cost",
                "property_source_key": "contract:property:1",
                "bills": [{
                    "source_key": "contract:bill:1",
                    "provider": "Landlord",
                    "description": "June rent",
                    "amount": 820.98,
                    "charge_date": "2026-06-01",
                    "owner_scope": "joint"
                }]
            }]
        })),
    )
    .await?;
    assert_eq!(bulk.status(), StatusCode::OK);
    let bulk = response_json(bulk).await?;
    assert!(bulk["run_id"].is_string());
    let by_entity = &bulk["counts"]["by_entity"];
    assert_eq!(by_entity["expense_entries"], 1);
    assert_eq!(by_entity["properties"], 1);
    assert_eq!(by_entity["project_items"], 1);
    assert_eq!(by_entity["utility_bills"], 1);
    Ok(())
}

#[tokio::test]
async fn contributor_can_read_imports_but_cannot_start_one() -> anyhow::Result<()> {
    let Some((app, pool)) = test_router().await? else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let token = login(&app, "member").await?;
    let context = authenticate(&pool, &token).await?;
    let mut transaction = tenant::begin(&pool, context.household.id, false).await?;
    sqlx::query(
        "UPDATE household_memberships
         SET role = 'contributor', updated_at = now()
         WHERE household_id = $1 AND id = $2",
    )
    .bind(context.household.id)
    .bind(context.membership.id)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    let history = request(&app, "GET", "/api/imports/history", Some(&token), None).await?;
    assert_eq!(history.status(), StatusCode::OK);
    let write = request(
        &app,
        "POST",
        "/api/imports/bulk",
        Some(&token),
        Some(json!({ "expenses": [] })),
    )
    .await?;
    assert_eq!(write.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(write).await?,
        json!({"detail": "Permission denied."})
    );
    Ok(())
}
