use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use checkbook_api::{ApiState, router};
use checkbook_postgres::{
    auth::{authenticate, generate_opaque_token, hash_opaque_token},
    connect, migrate, tenant,
};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

async fn response_json(response: axum::response::Response) -> anyhow::Result<Value> {
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> anyhow::Result<axum::response::Response> {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    let body = if let Some(payload) = body {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        Body::from(payload.to_string())
    } else {
        Body::empty()
    };
    Ok(app.clone().oneshot(builder.body(body)?).await?)
}

async fn owner_login(app: &Router) -> anyhow::Result<String> {
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/auth/dev-login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "email": format!("scope-owner-{}@example.com", Uuid::new_v4()),
                        "full_name": "Scope Owner",
                        "relationship_kind": "owner"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    anyhow::ensure!(response.status() == StatusCode::OK);
    response_json(response).await?["token"]
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow::anyhow!("owner token missing"))
}

async fn create_contributor_session(pool: &PgPool, household_id: Uuid) -> anyhow::Result<String> {
    let identity = Uuid::new_v4();
    let email = format!("scope-spouse-{identity}@example.com");
    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (email, full_name)
         VALUES ($1, 'Scope Spouse')
         RETURNING id",
    )
    .bind(&email)
    .fetch_one(pool)
    .await?;
    sqlx::query(
        "INSERT INTO external_identities (user_id, provider, subject)
         VALUES ($1, 'development', $2)",
    )
    .bind(user_id)
    .bind(&email)
    .execute(pool)
    .await?;
    let token = generate_opaque_token()?;
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    sqlx::query(
        "INSERT INTO household_memberships
            (household_id, user_id, role, relationship_kind)
         VALUES ($1,$2,'contributor','spouse')",
    )
    .bind(household_id)
    .bind(user_id)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "UPDATE role_permissions
         SET can_delete = true
         WHERE household_id = $1 AND role = 'contributor'
           AND module IN ('planning','records')",
    )
    .bind(household_id)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "INSERT INTO sessions (user_id, household_id, token_hash, expires_at)
         VALUES ($1,$2,$3,$4)",
    )
    .bind(user_id)
    .bind(household_id)
    .bind(hash_opaque_token(&token))
    .bind(Utc::now() + Duration::hours(24))
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(token)
}

async fn create_property(app: &Router, token: &str, name: &str) -> anyhow::Result<String> {
    let response = request(
        app,
        "POST",
        "/api/household/assets",
        token,
        Some(json!({
            "name": name,
            "total_cost": 100000,
            "valuation_date": "2026-06-01",
            "status": "active",
            "kind": "asset",
            "details": {}
        })),
    )
    .await?;
    anyhow::ensure!(response.status() == StatusCode::OK);
    response_json(response).await?["id"]
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow::anyhow!("property id missing"))
}

async fn assert_forbidden(response: axum::response::Response) -> anyhow::Result<()> {
    anyhow::ensure!(response.status() == StatusCode::FORBIDDEN);
    anyhow::ensure!(response_json(response).await? == json!({"detail": "Permission denied."}));
    Ok(())
}

#[tokio::test]
async fn contributors_cannot_read_or_mutate_the_other_members_personal_resources()
-> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 8).await?;
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
    let owner_token = owner_login(&app).await?;
    let owner = authenticate(&pool, &owner_token).await?;
    let contributor_token = create_contributor_session(&pool, owner.household.id).await?;

    let source_payload = json!({
        "name": "Owner-only employment",
        "source_type": "employment",
        "owner_scope": "self",
        "started_on": "2026-01-01",
        "ended_on": null,
        "notes": "",
        "lines": [],
        "fields": [],
        "milestones": [],
        "sort_order": 0
    });
    let source = request(
        &app,
        "POST",
        "/api/household/income-sources",
        &owner_token,
        Some(source_payload.clone()),
    )
    .await?;
    anyhow::ensure!(source.status() == StatusCode::OK);
    let source_id = response_json(source).await?["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("source id missing"))?
        .to_owned();
    let listed = request(
        &app,
        "GET",
        "/api/household/income-sources",
        &contributor_token,
        None,
    )
    .await?;
    anyhow::ensure!(listed.status() == StatusCode::OK);
    anyhow::ensure!(
        response_json(listed)
            .await?
            .as_array()
            .is_some_and(Vec::is_empty)
    );
    let mut source_update = source_payload;
    source_update["owner_scope"] = json!("spouse");
    assert_forbidden(
        request(
            &app,
            "PUT",
            &format!("/api/household/income-sources/{source_id}"),
            &contributor_token,
            Some(source_update),
        )
        .await?,
    )
    .await?;
    assert_forbidden(
        request(
            &app,
            "POST",
            &format!("/api/household/income-sources/{source_id}/entries"),
            &contributor_token,
            Some(json!({
                "description": "Unauthorized",
                "amount": 100,
                "entry_date": "2026-06-01",
                "owner_scope": "spouse",
                "notes": "",
                "extra_payload": {}
            })),
        )
        .await?,
    )
    .await?;

    let loan = request(
        &app,
        "POST",
        "/api/household/loans",
        &owner_token,
        Some(json!({
            "name": "Owner loan",
            "current_balance": 5000,
            "monthly_payment": 500,
            "original_balance": 6000,
            "interest_rate": 0.05,
            "liability_type": "loan",
            "owner_scope": "self",
            "start_date": "2026-01-01",
            "end_date": null,
            "notes": ""
        })),
    )
    .await?;
    anyhow::ensure!(loan.status() == StatusCode::OK);
    let loans = request(
        &app,
        "GET",
        "/api/household/loans",
        &contributor_token,
        None,
    )
    .await?;
    anyhow::ensure!(
        response_json(loans)
            .await?
            .as_array()
            .is_some_and(Vec::is_empty)
    );
    let source_property = create_property(&app, &owner_token, "Source property").await?;
    let destination_property = create_property(&app, &owner_token, "Destination property").await?;
    let source_property_id = Uuid::parse_str(&source_property)?;
    let service_id: Uuid;
    {
        let mut transaction = tenant::begin(&pool, owner.household.id, false).await?;
        // Households no longer receive global service seeds; create a
        // dedicated service for this scope check.
        service_id = sqlx::query_scalar(
            "INSERT INTO utility_services (household_id, service_key, label, service_kind, unit)
             VALUES ($1, $2, 'Rent', 'cost', '') RETURNING id",
        )
        .bind(owner.household.id)
        .bind(format!("scope-rent-{}", Uuid::new_v4().simple()))
        .fetch_one(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO utility_bills
                (household_id, property_id, service_id, provider, description,
                 amount, currency, charge_date, owner_scope, data_source, source_key)
             VALUES ($1,$2,$3,'Owner','Private utility',250,'PLN','2026-06-01',
                     'self','app_manual',$4)",
        )
        .bind(owner.household.id)
        .bind(source_property_id)
        .bind(service_id)
        .bind(format!("scope-test-{}", Uuid::new_v4()))
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
    }
    let utility_board = request(
        &app,
        "GET",
        &format!("/api/household/utilities/board?property_id={source_property}"),
        &contributor_token,
        None,
    )
    .await?;
    anyhow::ensure!(utility_board.status() == StatusCode::OK);
    let utility_board = response_json(utility_board).await?;
    anyhow::ensure!(
        utility_board["months"]
            .as_array()
            .is_some_and(|months| months.iter().all(|month| month["total"] == 0.0))
    );
    let reassigned = request(
        &app,
        "POST",
        "/api/household/utilities/reassign",
        &contributor_token,
        Some(json!({
            "from_property_id": source_property,
            "to_property_id": destination_property
        })),
    )
    .await?;
    anyhow::ensure!(reassigned.status() == StatusCode::UNPROCESSABLE_ENTITY);
    let mut transaction = tenant::begin(&pool, owner.household.id, true).await?;
    let still_source: bool = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM utility_bills
            WHERE household_id = $1 AND property_id = $2 AND service_id = $3
         )",
    )
    .bind(owner.household.id)
    .bind(source_property_id)
    .bind(service_id)
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    anyhow::ensure!(still_source);
    Ok(())
}
