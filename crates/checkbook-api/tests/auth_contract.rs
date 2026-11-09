use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use checkbook_api::{ApiState, router};
use checkbook_postgres::{
    auth::{AuthStoreError, create_identity_session, hash_opaque_token},
    connect, migrate, tenant,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

async fn response_json(response: axum::response::Response) -> anyhow::Result<Value> {
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

async fn test_router() -> anyhow::Result<Option<Router>> {
    Ok(test_router_with_pool().await?.map(|(app, _pool)| app))
}

async fn test_router_with_pool() -> anyhow::Result<Option<(Router, PgPool)>> {
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

async fn json_request(
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

async fn login(app: &Router, prefix: &str) -> anyhow::Result<Value> {
    let response = json_request(
        app,
        "POST",
        "/api/auth/dev-login",
        None,
        Some(json!({
            "email": format!("{prefix}-{}@example.com", uuid::Uuid::new_v4()),
            "full_name": "Auth Lifecycle",
            "relationship_kind": "owner"
        })),
    )
    .await?;
    anyhow::ensure!(response.status() == StatusCode::OK);
    response_json(response).await
}

#[tokio::test]
async fn development_session_and_household_me_match_the_frontend_contract() -> anyhow::Result<()> {
    let Some(app) = test_router().await? else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let email = format!("contract-{}@example.com", uuid::Uuid::new_v4());
    let login = app
        .clone()
        .oneshot(
            Request::post("/api/auth/dev-login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "email": email,
                        "full_name": "Contract Owner",
                        "relationship_kind": "owner"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(login.status(), StatusCode::OK);
    let login = response_json(login).await?;
    let token = login["token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("login token missing"))?;
    assert_eq!(login["membership"]["role"], "owner");
    assert_eq!(login["membership"]["relationship_kind"], "owner");
    assert_eq!(login["household"]["base_currency"], "PLN");

    let context = app
        .clone()
        .oneshot(
            Request::get("/api/household/me")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(context.status(), StatusCode::OK);
    let context = response_json(context).await?;
    assert_eq!(context["user"]["email"], email);
    assert_eq!(context["user"]["google_sub"], format!("dev:{email}"));
    assert_eq!(context["membership"]["is_active"], true);
    assert_eq!(context["settings"]["backup_config"], json!({}));
    assert!(context["household"]["created_at"].is_string());
    assert!(context["settings"]["role_permissions"]["records"].is_object());

    let repeated = json_request(
        &app,
        "POST",
        "/api/auth/dev-login",
        None,
        Some(json!({
            "email": email,
            "full_name": "Contract Owner Updated",
            "relationship_kind": "owner"
        })),
    )
    .await?;
    assert_eq!(repeated.status(), StatusCode::OK);
    let repeated = response_json(repeated).await?;
    assert_eq!(repeated["household"]["id"], context["household"]["id"]);
    Ok(())
}

#[tokio::test]
async fn malformed_bearer_token_uses_fastapi_compatible_error_shape() -> anyhow::Result<()> {
    let Some(app) = test_router().await? else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let response = app
        .clone()
        .oneshot(
            Request::get("/api/auth/session")
                .header(header::AUTHORIZATION, "Bearer not-a-session")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response_json(response).await?,
        json!({ "detail": "Authentication required." })
    );

    let body_before_auth = app
        .oneshot(
            Request::post("/api/household/expenses")
                .header(header::AUTHORIZATION, "Bearer not-a-session")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{invalid-json"))?,
        )
        .await?;
    assert_eq!(body_before_auth.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response_json(body_before_auth).await?,
        json!({ "detail": "Authentication required." })
    );
    Ok(())
}

#[tokio::test]
async fn google_login_is_available_only_when_server_configuration_is_present() -> anyhow::Result<()>
{
    let Some(app) = test_router().await? else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let response = app
        .oneshot(
            Request::post("/api/auth/google")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"credential": "configured-google-token"}).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response_json(response).await?,
        json!({"detail": "GOOGLE_CLIENT_ID is not configured."})
    );
    Ok(())
}

#[tokio::test]
async fn authentication_bootstrap_is_rate_limited_per_source_and_route() -> anyhow::Result<()> {
    let Some(app) = test_router().await? else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let source = format!(
        "198.51.100.{}",
        u8::try_from(uuid::Uuid::new_v4().as_u128() % 200 + 1)?
    );
    for attempt in 0..30 {
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/auth/google")
                    .header("cf-connecting-ip", &source)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"credential": format!("credential-{attempt:02}")}).to_string(),
                    ))?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
    let limited = app
        .oneshot(
            Request::post("/api/auth/google")
                .header("cf-connecting-ip", source)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"credential": "credential-rate-limit"}).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response_json(limited).await?,
        json!({"detail": "Too many authentication attempts."})
    );
    Ok(())
}

#[tokio::test]
async fn session_tokens_are_hashed_expirable_revocable_and_household_bound() -> anyhow::Result<()> {
    let Some((app, pool)) = test_router_with_pool().await? else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let first = login(&app, "session-first").await?;
    let first_token = first["token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("first token missing"))?;
    let first_household = uuid::Uuid::parse_str(
        first["household"]["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("first household missing"))?,
    )?;
    let stored_hash: Vec<u8> =
        sqlx::query_scalar("SELECT token_hash FROM sessions WHERE token_hash = $1")
            .bind(hash_opaque_token(first_token))
            .fetch_one(&pool)
            .await?;
    assert_eq!(stored_hash.len(), 32);
    assert_ne!(stored_hash, first_token.as_bytes());
    assert!(first_token.len() >= 64);

    sqlx::query(
        "UPDATE sessions
         SET expires_at = now() - interval '1 minute'
         WHERE token_hash = $1",
    )
    .bind(hash_opaque_token(first_token))
    .execute(&pool)
    .await?;
    let expired = json_request(&app, "GET", "/api/auth/session", Some(first_token), None).await?;
    assert_eq!(expired.status(), StatusCode::UNAUTHORIZED);

    let second = login(&app, "session-second").await?;
    let second_token = second["token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("second token missing"))?;
    let logout = json_request(&app, "POST", "/api/auth/logout", Some(second_token), None).await?;
    assert_eq!(logout.status(), StatusCode::OK);
    let revoked = json_request(&app, "GET", "/api/auth/session", Some(second_token), None).await?;
    assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);

    let third = login(&app, "session-third").await?;
    let third_token = third["token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("third token missing"))?;
    sqlx::query("UPDATE sessions SET household_id = $2 WHERE token_hash = $1")
        .bind(hash_opaque_token(third_token))
        .bind(first_household)
        .execute(&pool)
        .await?;
    let cross_household =
        json_request(&app, "GET", "/api/auth/session", Some(third_token), None).await?;
    assert_eq!(cross_household.status(), StatusCode::UNAUTHORIZED);
    Ok(())
}

#[tokio::test]
async fn external_identity_subjects_cannot_be_reassigned_by_changing_email() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    migrate(&pool).await?;
    let identity = uuid::Uuid::new_v4();
    let subject = format!("stable-subject-{identity}");
    let first_email = format!("identity-first-{identity}@example.com");
    let changed_email = format!("identity-changed-{identity}@example.com");
    let first = create_identity_session(
        &pool,
        "google",
        &subject,
        &first_email,
        "Identity Owner",
        "",
        "owner",
        24,
    )
    .await?;
    let changed = create_identity_session(
        &pool,
        "google",
        &subject,
        &changed_email,
        "Identity Owner Updated",
        "",
        "owner",
        24,
    )
    .await?;
    assert_eq!(changed.user.id, first.user.id);
    assert_eq!(changed.household.id, first.household.id);
    assert_eq!(changed.user.email, changed_email);

    let other = create_identity_session(
        &pool,
        "google",
        &format!("other-subject-{identity}"),
        &format!("identity-other-{identity}@example.com"),
        "Other Identity",
        "",
        "owner",
        24,
    )
    .await?;
    let collision = create_identity_session(
        &pool,
        "google",
        &subject,
        &other.user.email,
        "Identity Collision",
        "",
        "owner",
        24,
    )
    .await;
    assert!(matches!(collision, Err(AuthStoreError::InvalidIdentity)));
    let mapped_user_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT user_id FROM external_identities
         WHERE provider = 'google' AND subject = $1",
    )
    .bind(subject)
    .fetch_one(&pool)
    .await?;
    assert_eq!(mapped_user_id, first.user.id);
    Ok(())
}

#[tokio::test]
async fn invited_identity_joins_the_existing_household_once() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    migrate(&pool).await?;
    let identity = uuid::Uuid::new_v4();
    let owner = create_identity_session(
        &pool,
        "google",
        &format!("invite-owner-subject-{identity}"),
        &format!("invite-owner-{identity}@example.com"),
        "Invite Owner",
        "",
        "owner",
        24,
    )
    .await?;
    let invitee_email = format!("invite-spouse-{identity}@example.com");
    let mut transaction = tenant::begin(&pool, owner.household.id, false).await?;
    sqlx::query(
        "INSERT INTO household_invitations
            (household_id, invited_by_user_id, email, role, relationship_kind,
             token_hash, expires_at)
         VALUES ($1,$2,$3,'contributor','spouse',$4,now() + interval '14 days')",
    )
    .bind(owner.household.id)
    .bind(owner.user.id)
    .bind(&invitee_email)
    .bind(hash_opaque_token(&format!("invite-token-{identity}")))
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;

    let invitee_subject = format!("invite-spouse-subject-{identity}");
    let invitee = create_identity_session(
        &pool,
        "google",
        &invitee_subject,
        &invitee_email,
        "Invite Spouse",
        "",
        "owner",
        24,
    )
    .await?;
    assert_eq!(invitee.household.id, owner.household.id);
    assert_eq!(invitee.membership.role, "contributor");
    assert_eq!(invitee.membership.relationship_kind, "spouse");

    let repeated = create_identity_session(
        &pool,
        "google",
        &invitee_subject,
        &invitee_email,
        "Invite Spouse",
        "",
        "owner",
        24,
    )
    .await?;
    assert_eq!(repeated.household.id, owner.household.id);
    assert_eq!(repeated.membership.id, invitee.membership.id);

    let mut transaction = tenant::begin(&pool, owner.household.id, true).await?;
    let accepted: bool = sqlx::query_scalar(
        "SELECT accepted_at IS NOT NULL
         FROM household_invitations
         WHERE household_id = $1 AND email = $2",
    )
    .bind(owner.household.id)
    .bind(invitee_email)
    .fetch_one(&mut *transaction)
    .await?;
    let memberships: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM household_memberships
         WHERE household_id = $1 AND user_id = $2",
    )
    .bind(owner.household.id)
    .bind(invitee.user.id)
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    assert!(accepted);
    assert_eq!(memberships, 1);
    Ok(())
}
