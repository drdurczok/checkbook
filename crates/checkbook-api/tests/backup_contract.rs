use std::path::PathBuf;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use checkbook_api::{ApiState, router};
use checkbook_postgres::{connect, migrate};
use serde_json::{Value, json};
use tower::ServiceExt;

async fn response_bytes(response: axum::response::Response) -> anyhow::Result<Vec<u8>> {
    Ok(to_bytes(response.into_body(), 128 * 1024 * 1024)
        .await?
        .to_vec())
}

async fn response_json(response: axum::response::Response) -> anyhow::Result<Value> {
    Ok(serde_json::from_slice(&response_bytes(response).await?)?)
}

async fn test_router() -> anyhow::Result<Option<(Router, PathBuf)>> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        return Ok(None);
    };
    let pool = connect(&database_url, 5).await?;
    migrate(&pool).await?;
    let root = std::env::temp_dir()
        .join("checkbook-backup-contract")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&root)?;
    let app = router(
        ApiState {
            pool,
            dev_auth_enabled: true,
            session_hours: 24,
            cloudflare: None,
            google: None,
            backup_admin_root: Some(root.clone()),
        },
        Vec::new(),
    );
    Ok(Some((app, root)))
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    content_type: Option<&str>,
    body: Vec<u8>,
) -> anyhow::Result<axum::response::Response> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if let Some(content_type) = content_type {
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }
    Ok(app.clone().oneshot(builder.body(Body::from(body))?).await?)
}

async fn json_request(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> anyhow::Result<axum::response::Response> {
    request(
        app,
        method,
        path,
        token,
        body.as_ref().map(|_| "application/json"),
        body.map_or_else(Vec::new, |value| value.to_string().into_bytes()),
    )
    .await
}

async fn login(app: &Router) -> anyhow::Result<String> {
    let response = json_request(
        app,
        "POST",
        "/api/auth/dev-login",
        None,
        Some(json!({
            "email": format!("backup-api-{}@example.com", uuid::Uuid::new_v4()),
            "full_name": "Backup API Owner",
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
async fn backup_routes_round_trip_without_touching_auth_or_escaping_admin_root()
-> anyhow::Result<()> {
    let Some((app, root)) = test_router().await? else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let token = login(&app).await?;

    let initial = json_request(&app, "GET", "/api/backups/config", Some(&token), None).await?;
    assert_eq!(initial.status(), StatusCode::OK);
    assert_eq!(
        response_json(initial).await?,
        json!({"path": "", "retention": 0})
    );
    let outside = json_request(
        &app,
        "PUT",
        "/api/backups/config",
        Some(&token),
        Some(json!({"path": "/tmp", "retention": 1})),
    )
    .await?;
    assert_eq!(outside.status(), StatusCode::BAD_REQUEST);

    let saved = json_request(
        &app,
        "PUT",
        "/api/backups/config",
        Some(&token),
        Some(json!({"path": "stored", "retention": 2})),
    )
    .await?;
    assert_eq!(saved.status(), StatusCode::OK);
    assert_eq!(
        response_json(saved).await?,
        json!({"path": "stored", "retention": 2})
    );
    let tested = json_request(
        &app,
        "POST",
        "/api/backups/test",
        Some(&token),
        Some(json!({"path": "stored", "retention": 2})),
    )
    .await?;
    assert_eq!(tested.status(), StatusCode::OK);
    assert_eq!(response_json(tested).await?["ok"], true);

    let buyer = json_request(
        &app,
        "POST",
        "/api/household/buyers",
        Some(&token),
        Some(json!({"name": "Backup buyer", "nip": "123", "address": "Łódź"})),
    )
    .await?;
    assert_eq!(buyer.status(), StatusCode::OK);
    let exported = json_request(&app, "GET", "/api/backups/export.csv", Some(&token), None).await?;
    assert_eq!(exported.status(), StatusCode::OK);
    assert_eq!(exported.headers()[header::CONTENT_TYPE], "application/zip");
    assert!(
        exported.headers()[header::CONTENT_DISPOSITION]
            .to_str()?
            .contains("checkbook-export-")
    );
    assert!(response_bytes(exported).await?.starts_with(b"PK"));

    let created = json_request(&app, "POST", "/api/backups", Some(&token), None).await?;
    assert_eq!(created.status(), StatusCode::OK);
    let created = response_json(created).await?;
    let name = created["name"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("backup name missing"))?;
    assert!(name.ends_with(".zip"));
    assert!(created["size"].as_u64().is_some_and(|size| size > 0));

    let listed = json_request(&app, "GET", "/api/backups", Some(&token), None).await?;
    assert_eq!(listed.status(), StatusCode::OK);
    assert_eq!(response_json(listed).await?[0]["name"], name);
    let downloaded = json_request(
        &app,
        "GET",
        &format!("/api/backups/{name}/download"),
        Some(&token),
        None,
    )
    .await?;
    assert_eq!(downloaded.status(), StatusCode::OK);
    assert_eq!(
        downloaded.headers()[header::CONTENT_TYPE],
        "application/zip"
    );
    let archive = response_bytes(downloaded).await?;
    assert!(archive.starts_with(b"PK"));

    let mutation = json_request(
        &app,
        "POST",
        "/api/household/expenses",
        Some(&token),
        Some(json!({
            "description": "Delete on restore",
            "amount": 10,
            "entry_date": "2026-06-22",
            "owner_scope": "joint",
            "category_name": "Other",
            "notes": ""
        })),
    )
    .await?;
    assert_eq!(mutation.status(), StatusCode::OK);
    let restored = json_request(
        &app,
        "POST",
        &format!("/api/backups/{name}/restore"),
        Some(&token),
        None,
    )
    .await?;
    assert_eq!(restored.status(), StatusCode::OK);
    let restored = response_json(restored).await?;
    assert_eq!(restored["ok"], true);
    assert_eq!(restored["restored"]["buyers"], 1);

    let session = json_request(&app, "GET", "/api/auth/session", Some(&token), None).await?;
    assert_eq!(session.status(), StatusCode::OK);

    let boundary = "checkbook-boundary";
    let mut multipart = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"backup.zip\"\r\nContent-Type: application/zip\r\n\r\n"
    )
    .into_bytes();
    multipart.extend_from_slice(&archive);
    multipart.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let imported = request(
        &app,
        "POST",
        "/api/backups/import",
        Some(&token),
        Some(&format!("multipart/form-data; boundary={boundary}")),
        multipart,
    )
    .await?;
    assert_eq!(imported.status(), StatusCode::OK);
    assert_eq!(response_json(imported).await?["ok"], true);

    let traversal = json_request(
        &app,
        "GET",
        "/api/backups/%2E%2E%2Fsecret/download",
        Some(&token),
        None,
    )
    .await?;
    assert!(
        matches!(
            traversal.status(),
            StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND
        ),
        "unexpected traversal status {}",
        traversal.status()
    );
    let deleted = json_request(
        &app,
        "DELETE",
        &format!("/api/backups/{name}"),
        Some(&token),
        None,
    )
    .await?;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(
        response_json(deleted).await?,
        json!({"ok": true, "restored": {}})
    );
    std::fs::remove_dir_all(root)?;
    Ok(())
}
