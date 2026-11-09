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
fn lifecycle_openapi_requires_both_flags_and_declares_no_content() -> anyhow::Result<()> {
    let document = checkbook_api::openapi_document()?;
    let schemas = &document["components"]["schemas"];
    let required = schemas["UtilityLifecyclePayload"]["required"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("required lifecycle properties missing"))?;
    for flag in ["retired", "hidden"] {
        assert!(required.contains(&json!(flag)));
        assert_eq!(
            schemas["UtilityLifecyclePayload"]["properties"][flag]["type"],
            "boolean"
        );
    }
    for flag in ["retired", "hidden", "has_data"] {
        assert_eq!(
            schemas["TrackedField"]["properties"][flag]["type"],
            "boolean"
        );
    }
    assert!(document["paths"]["/api/household/utility-field-catalog/{key}"]["delete"]["responses"]["204"].is_object());
    Ok(())
}

#[tokio::test]
async fn legacy_configuration_routes_reject_writes() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; utility lifecycle API test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let context = create_development_session(
        &pool,
        &format!("lifecycle-api-{}@example.com", Uuid::new_v4()),
        "Owner",
        "owner",
        24,
    )
    .await?;
    let token = context
        .token
        .ok_or_else(|| anyhow::anyhow!("token missing"))?;
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
    let request = |method: &str, path: &str, payload: Value| -> anyhow::Result<Request<Body>> {
        Ok(Request::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(payload.to_string()))?)
    };
    let catalog = "/api/household/utility-field-catalog";
    let key_path = format!("{catalog}/lifecycle_test");
    for (method, path, payload) in [
        (
            "POST",
            catalog.to_owned(),
            json!({"label":"Water","kind":"cost","unit":"","entry_mode":"actual","unit_rate":null}),
        ),
        (
            "PUT",
            key_path.clone(),
            json!({"label":"Water","kind":"cost","unit":"","entry_mode":"actual","unit_rate":null}),
        ),
        (
            "PATCH",
            format!("{key_path}/lifecycle"),
            json!({"retired":false,"hidden":false}),
        ),
        (
            "PATCH",
            format!("{key_path}/lifecycle"),
            json!({"retired":true,"hidden":false}),
        ),
        ("DELETE", key_path, Value::Null),
        (
            "POST",
            "/api/household/utilities/track-field".to_owned(),
            json!({"property_id":Uuid::new_v4(),"field_key":"water"}),
        ),
        (
            "POST",
            "/api/household/utilities/untrack-field".to_owned(),
            json!({"property_id":Uuid::new_v4(),"field_key":"water"}),
        ),
        (
            "POST",
            "/api/household/groups".to_owned(),
            json!({"kind":"contract","name":"Legacy","group_type":"utility"}),
        ),
    ] {
        let unauthenticated = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(&path)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(payload.to_string()))?,
            )
            .await?;
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
        let response = app
            .clone()
            .oneshot(request(method, &path, payload)?)
            .await?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{method} {path}: {}",
            String::from_utf8_lossy(&bytes)
        );
        let body: Value = serde_json::from_slice(&bytes)?;
        assert!(
            body["detail"]
                .as_str()
                .is_some_and(|detail| detail.contains("property-owned utility contracts"))
        );
    }
    Ok(())
}
