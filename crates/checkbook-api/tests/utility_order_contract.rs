use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use checkbook_api::{ApiState, router};
use checkbook_postgres::{auth::create_development_session, connect};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

#[test]
fn ordering_openapi_describes_required_keys_and_array_response() -> anyhow::Result<()> {
    let document = checkbook_api::openapi_document()?;
    let operation = &document["paths"]["/api/household/utility-field-order"]["post"];
    assert_eq!(operation["operationId"], "reorderUtilityFields");
    assert_eq!(
        operation["responses"]["200"]["content"]["application/json"]["schema"]["type"],
        "array"
    );
    assert_eq!(
        document["components"]["schemas"]["UtilityOrderPayload"]["required"],
        json!(["keys"])
    );
    Ok(())
}

#[tokio::test]
async fn legacy_order_route_rejects_writes_and_requires_settings_permission() -> anyhow::Result<()>
{
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; utility order API test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let owner = create_development_session(
        &pool,
        &format!("order-api-{}@example.com", Uuid::new_v4()),
        "Owner",
        "owner",
        24,
    )
    .await?;
    let contributor = create_development_session(
        &pool,
        &format!("order-contributor-{}@example.com", Uuid::new_v4()),
        "Contributor",
        "member",
        24,
    )
    .await?;
    let mut transaction =
        checkbook_postgres::tenant::begin(&pool, contributor.household.id, false).await?;
    sqlx::query!(
        "UPDATE household_memberships
         SET role = 'contributor', updated_at = now()
         WHERE household_id = $1 AND id = $2",
        contributor.household.id,
        contributor.membership.id
    )
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    let token = owner
        .token
        .ok_or_else(|| anyhow::anyhow!("owner token missing"))?;
    let contributor_token = contributor
        .token
        .ok_or_else(|| anyhow::anyhow!("contributor token missing"))?;
    let mut keys = checkbook_postgres::utilities::field_catalog(&pool, owner.household.id)
        .await?
        .into_iter()
        .map(|field| field.key)
        .collect::<Vec<_>>();
    keys.reverse();
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
    let request = |token: Option<&str>, payload: Value| -> anyhow::Result<Request<Body>> {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/api/household/utility-field-order")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(token) = token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        Ok(builder.body(Body::from(payload.to_string()))?)
    };
    for (token, payload, status) in [
        (None, json!({"keys":keys}), StatusCode::UNAUTHORIZED),
        (
            Some(contributor_token.as_str()),
            json!({"keys":keys}),
            StatusCode::FORBIDDEN,
        ),
        (
            Some(token.as_str()),
            json!({"keys":[]}),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            Some(token.as_str()),
            json!({}),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
    ] {
        let response = app.clone().oneshot(request(token, payload)?).await?;
        assert_eq!(response.status(), status);
    }
    let response = app
        .oneshot(request(Some(&token), json!({"keys":keys}))?)
        .await?;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
    let body: Value = serde_json::from_slice(&bytes)?;
    assert!(
        body["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("property-owned utility contracts"))
    );
    Ok(())
}
