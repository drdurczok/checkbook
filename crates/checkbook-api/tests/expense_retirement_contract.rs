use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use checkbook_api::{ApiState, router};
use checkbook_postgres::{connect, migrate, tenant};
use serde_json::{Value, json};
use tower::ServiceExt;

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
            "email": format!("records-{}@example.com", uuid::Uuid::new_v4()),
            "full_name": "Records Owner",
            "relationship_kind": "owner"
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
async fn expense_retirement_and_delete_capabilities_match_contract() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; expense retirement API test skipped");
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
    for resource in ["expense-groups", "expense-categories"] {
        let base = format!("/api/household/{resource}");
        let created = request(
            &app,
            "POST",
            &base,
            Some(&token),
            Some(json!({"name": resource, "is_retired": true})),
        )
        .await?;
        assert_eq!(created.status(), StatusCode::OK);
        let created = response_json(created).await?;
        assert_eq!(created["is_retired"], true);
        assert_eq!(created["can_delete"], true);
        assert_eq!(created["is_source_linked"], false);
        let id = created["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing id"))?;
        let path = format!("{base}/{id}");
        let updated = request(
            &app,
            "PUT",
            &path,
            Some(&token),
            Some(json!({"name": resource})),
        )
        .await?;
        assert_eq!(updated.status(), StatusCode::OK);
        let updated = response_json(updated).await?;
        assert_eq!(updated["is_retired"], true);
        assert_eq!(updated["is_source_linked"], false);
        let forbidden = request(
            &app,
            "PUT",
            &path,
            Some(&other),
            Some(json!({"name": "Cross tenant mutation", "is_retired": false})),
        )
        .await?;
        assert_eq!(forbidden.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            request(&app, "DELETE", &path, Some(&other), None)
                .await?
                .status(),
            StatusCode::NOT_FOUND
        );
        if resource == "expense-categories" {
            let detail =
                response_json(request(&app, "GET", &path, Some(&token), None).await?).await?;
            assert_eq!(detail["is_retired"], true);
            assert_eq!(detail["can_delete"], true);
            assert_eq!(detail["is_source_linked"], false);
        }
        let restored = request(
            &app,
            "PUT",
            &path,
            Some(&token),
            Some(json!({"name": resource, "is_retired": false})),
        )
        .await?;
        assert_eq!(response_json(restored).await?["is_retired"], false);
        assert_eq!(
            request(&app, "DELETE", &path, Some(&token), None)
                .await?
                .status(),
            StatusCode::OK
        );
    }
    let quick_add = request(
        &app,
        "POST",
        "/api/household/expenses",
        Some(&token),
        Some(json!({
            "description": "Manual quick add",
            "amount": 12,
            "entry_date": "2026-01-01",
            "category_name": "Quick add manual category",
            "subcategory_name": "Quick add manual child"
        })),
    )
    .await?;
    assert_eq!(quick_add.status(), StatusCode::OK);
    let quick_board = response_json(
        request(
            &app,
            "GET",
            "/api/household/expenses/board",
            Some(&token),
            None,
        )
        .await?,
    )
    .await?;
    let quick_category = quick_board["categories"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["name"] == "Quick add manual category")
        })
        .ok_or_else(|| anyhow::anyhow!("manual quick-add category missing"))?;
    assert_eq!(quick_category["can_delete"], true);
    let quick_id = quick_category["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("manual quick-add id missing"))?;
    assert_eq!(
        request(
            &app,
            "DELETE",
            &format!("/api/household/expense-categories/{quick_id}"),
            Some(&token),
            None
        )
        .await?
        .status(),
        StatusCode::OK
    );

    let context = checkbook_postgres::auth::authenticate(&pool, &token).await?;
    let mut tx = tenant::begin(&pool, context.household.id, false).await?;
    let auto_group: uuid::Uuid = sqlx::query_scalar("INSERT INTO expense_groups (household_id, name, normalized_name) VALUES ($1, 'Automatic', 'automatic') RETURNING id")
        .bind(context.household.id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    let board = response_json(
        request(
            &app,
            "GET",
            "/api/household/expenses/board",
            Some(&token),
            None,
        )
        .await?,
    )
    .await?;
    let groups = board["groups"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("groups missing"))?;
    let group = groups
        .iter()
        .find(|g| g["id"] == auto_group.to_string())
        .ok_or_else(|| anyhow::anyhow!("automatic group missing"))?;
    assert_eq!(group["can_delete"], false);
    assert_eq!(group["is_source_linked"], false);
    assert_eq!(group["is_retired"], false);
    let rejected = request(
        &app,
        "DELETE",
        &format!("/api/household/expense-groups/{auto_group}"),
        Some(&token),
        None,
    )
    .await?;
    assert_eq!(rejected.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        response_json(rejected).await?["detail"]
            .as_str()
            .is_some_and(|d| d.contains("retire"))
    );
    Ok(())
}

#[test]
fn source_linkage_is_a_required_boolean_in_expense_response_contracts() -> anyhow::Result<()> {
    let document = checkbook_api::openapi_document()?;
    for name in [
        "ExpenseGroupResponse",
        "ExpenseCategorySummaryResponse",
        "ExpenseCategoryDetailResponse",
    ] {
        let schema = &document["components"]["schemas"][name];
        assert_eq!(schema["properties"]["is_source_linked"]["type"], "boolean");
        assert!(
            schema["required"]
                .as_array()
                .is_some_and(|fields| { fields.iter().any(|field| field == "is_source_linked") }),
            "{name}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn source_linkage_survives_board_detail_and_write_responses() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; expense source linkage API test skipped");
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
    let context = checkbook_postgres::auth::authenticate(&pool, &token).await?;
    let household_id = context.household.id;
    let mut tx = tenant::begin(&pool, household_id, false).await?;
    sqlx::query("INSERT INTO properties (household_id, name, category, valuation, valuation_date, status, data_source, source_key) VALUES ($1, 'Car', 'vehicle', 100, CURRENT_DATE, 'active', 'app_manual', $2)")
        .bind(household_id).bind(format!("api-source:{}:car", household_id)).execute(&mut *tx).await?;
    let account_id: uuid::Uuid = sqlx::query_scalar("INSERT INTO financial_accounts (household_id, name, account_kind, account_type, owner_scope, source_key) VALUES ($1, 'Loan', 'liability', 'loan', 'joint', $2) RETURNING id")
        .bind(household_id).bind(format!("api-source:{}:account", household_id)).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO loans (household_id, account_id, name, liability_type, owner_scope, original_balance, current_balance, source_key) VALUES ($1, $2, 'Loan', 'loan', 'joint', 100, 100, $3)")
        .bind(household_id).bind(account_id).bind(format!("api-source:{}:loan", household_id)).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO projects (household_id, name, valuation_date, stored_status, data_source, source_key) VALUES ($1, 'Project', CURRENT_DATE, 'active', 'app_manual', $2)")
        .bind(household_id).bind(format!("api-source:{}:project", household_id)).execute(&mut *tx).await?;
    tx.commit().await?;
    let board = response_json(
        request(
            &app,
            "GET",
            "/api/household/expenses/board",
            Some(&token),
            None,
        )
        .await?,
    )
    .await?;
    for (collection, resource, name, linked) in [
        ("groups", "expense-groups", "Car", true),
        ("categories", "expense-categories", "Loan", true),
        ("categories", "expense-categories", "Project", false),
    ] {
        let row = board[collection]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["name"] == name))
            .ok_or_else(|| anyhow::anyhow!("{name} missing"))?;
        assert_eq!(row["is_source_linked"], linked, "{name}");
        assert_eq!(row["can_delete"], false, "{name}");
        let id = row["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("id missing"))?;
        let path = format!("/api/household/{resource}/{id}");
        if collection == "categories" {
            let detail =
                response_json(request(&app, "GET", &path, Some(&token), None).await?).await?;
            assert_eq!(detail["is_source_linked"], linked, "{name}");
        }
        let updated = request(
            &app,
            "PUT",
            &path,
            Some(&token),
            Some(json!({"name": name, "is_retired": true})),
        )
        .await?;
        assert_eq!(updated.status(), StatusCode::OK, "{name}");
        assert_eq!(
            response_json(updated).await?["is_source_linked"],
            linked,
            "{name}"
        );
    }
    Ok(())
}
