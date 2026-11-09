use std::{fs, path::PathBuf};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use checkbook_api::admin_data_loads::{AdminApiState, router};
use checkbook_postgres::{
    archive::build_archive, auth::create_development_session, backup::snapshot_household, connect,
    migrate, tenant,
};
use serde_json::Value;
use tower::ServiceExt;

const ADMIN_TOKEN: &str = "test-admin-token-with-at-least-32-characters";

async fn response_json(response: axum::response::Response) -> anyhow::Result<Value> {
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn multipart(archive: &[u8]) -> (String, Vec<u8>) {
    let boundary = format!("checkbook-{}", uuid::Uuid::new_v4());
    let mut body = format!(
        "--{boundary}\r\n\
         Content-Disposition: form-data; name=\"file\"; filename=\"load.zip\"\r\n\
         Content-Type: application/zip\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(archive);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (boundary, body)
}

async fn stage(
    app: &Router,
    archive: &[u8],
    idempotency_key: &str,
) -> anyhow::Result<axum::response::Response> {
    let (boundary, body) = multipart(archive);
    Ok(app
        .clone()
        .oneshot(
            Request::post("/api/admin/v1/data-loads")
                .header(header::AUTHORIZATION, format!("Bearer {ADMIN_TOKEN}"))
                .header("idempotency-key", idempotency_key)
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))?,
        )
        .await?)
}

#[tokio::test]
async fn private_data_loads_stage_idempotently_commit_atomically_and_discard() -> anyhow::Result<()>
{
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL data-load test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    migrate(&pool).await?;
    let identity = uuid::Uuid::new_v4();
    let context = create_development_session(
        &pool,
        &format!("data-load-{identity}@example.com"),
        "Data Load Owner",
        "owner",
        24,
    )
    .await?;
    {
        let mut transaction = tenant::begin(&pool, context.household.id, false).await?;
        sqlx::query("INSERT INTO buyers (household_id, name) VALUES ($1,'Archive buyer')")
            .bind(context.household.id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
    }
    let snapshot = snapshot_household(&pool, context.household.id).await?;
    let archive = build_archive(&snapshot)?;
    let root = PathBuf::from(format!("/tmp/checkbook-data-load-{identity}"));
    fs::create_dir_all(&root)?;
    let app = router(AdminApiState::new(pool.clone(), ADMIN_TOKEN, root.clone()));

    let unauthorized = app
        .clone()
        .oneshot(Request::get("/api/admin/v1/archive-schema").body(Body::empty())?)
        .await?;
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response_json(unauthorized).await?["detail"],
        "Admin authentication required."
    );

    let schema = app
        .clone()
        .oneshot(
            Request::get("/api/admin/v1/archive-schema")
                .header(header::AUTHORIZATION, format!("Bearer {ADMIN_TOKEN}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(schema.status(), StatusCode::OK);
    let schema = response_json(schema).await?;
    assert_eq!(schema["format"], "checkbook-backup");
    assert_eq!(schema["multipart_field"], "file");
    assert_eq!(schema["idempotency_header"], "Idempotency-Key");
    let buyers = schema["tables"]
        .as_array()
        .and_then(|tables| tables.iter().find(|table| table["name"] == "buyers"))
        .ok_or_else(|| anyhow::anyhow!("buyers archive schema missing"))?;
    assert_eq!(buyers["json_path"], "tables/buyers.json");
    assert!(buyers["columns"].as_array().is_some_and(|columns| {
        columns
            .iter()
            .any(|column| column["name"] == "household_id")
    }));

    let staged = stage(&app, &archive, "first-load").await?;
    assert_eq!(staged.status(), StatusCode::OK);
    let staged = response_json(staged).await?;
    assert_eq!(staged["status"], "validated");
    let load_id = staged["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("load id missing"))?;
    let duplicate = stage(&app, &archive, "first-load").await?;
    assert_eq!(duplicate.status(), StatusCode::OK);
    assert_eq!(response_json(duplicate).await?["id"], load_id);

    {
        let mut transaction = tenant::begin(&pool, context.household.id, false).await?;
        sqlx::query("INSERT INTO buyers (household_id, name) VALUES ($1,'Temporary buyer')")
            .bind(context.household.id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
    }
    let committed = app
        .clone()
        .oneshot(
            Request::post(format!("/api/admin/v1/data-loads/{load_id}/commit"))
                .header(header::AUTHORIZATION, format!("Bearer {ADMIN_TOKEN}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(committed.status(), StatusCode::OK);
    assert_eq!(
        response_json(committed).await?["load"]["status"],
        "committed"
    );
    let mut transaction = tenant::begin(&pool, context.household.id, true).await?;
    let buyers: Vec<String> = sqlx::query_scalar("SELECT name FROM buyers ORDER BY name")
        .fetch_all(&mut *transaction)
        .await?;
    transaction.commit().await?;
    assert_eq!(buyers, vec!["Archive buyer"]);

    let second = stage(&app, &archive, "discard-load").await?;
    assert_eq!(second.status(), StatusCode::OK);
    let second = response_json(second).await?;
    let second_id = second["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("second load id missing"))?;
    let discarded = app
        .clone()
        .oneshot(
            Request::delete(format!("/api/admin/v1/data-loads/{second_id}"))
                .header(header::AUTHORIZATION, format!("Bearer {ADMIN_TOKEN}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(discarded.status(), StatusCode::OK);
    assert_eq!(response_json(discarded).await?["status"], "deleted");

    let mut unknown_column_snapshot = snapshot.clone();
    let buyer = unknown_column_snapshot
        .tables
        .get_mut("buyers")
        .and_then(Value::as_array_mut)
        .and_then(|rows| rows.first_mut())
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow::anyhow!("buyer row missing from archive snapshot"))?;
    buyer.insert(
        "arbitrary_column".to_owned(),
        Value::String("rejected".to_owned()),
    );
    let unknown_column_archive = build_archive(&unknown_column_snapshot)?;
    let unknown_column = stage(&app, &unknown_column_archive, "unknown-column-load").await?;
    assert_eq!(unknown_column.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let mut invalid_snapshot = snapshot.clone();
    let categories = invalid_snapshot
        .tables
        .get_mut("categories")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow::anyhow!("categories missing from archive snapshot"))?;
    let mut duplicate = categories
        .first()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("seed category missing"))?;
    duplicate["id"] = Value::String(uuid::Uuid::new_v4().to_string());
    categories.push(duplicate);
    let invalid_archive = build_archive(&invalid_snapshot)?;
    let invalid = stage(&app, &invalid_archive, "invalid-unique-load").await?;
    assert_eq!(invalid.status(), StatusCode::OK);
    let invalid_id = response_json(invalid).await?["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invalid load id missing"))?
        .to_owned();
    let rejected = app
        .clone()
        .oneshot(
            Request::post(format!("/api/admin/v1/data-loads/{invalid_id}/commit"))
                .header(header::AUTHORIZATION, format!("Bearer {ADMIN_TOKEN}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(rejected.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let mut transaction = tenant::begin(&pool, context.household.id, true).await?;
    let buyers: Vec<String> = sqlx::query_scalar("SELECT name FROM buyers ORDER BY name")
        .fetch_all(&mut *transaction)
        .await?;
    transaction.commit().await?;
    assert_eq!(buyers, vec!["Archive buyer"]);
    let failed_status = app
        .clone()
        .oneshot(
            Request::get(format!("/api/admin/v1/data-loads/{invalid_id}"))
                .header(header::AUTHORIZATION, format!("Bearer {ADMIN_TOKEN}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(failed_status.status(), StatusCode::OK);
    assert_eq!(response_json(failed_status).await?["status"], "validated");

    fs::remove_dir_all(root)?;
    Ok(())
}
