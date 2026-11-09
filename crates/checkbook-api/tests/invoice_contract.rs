use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use checkbook_api::{ApiState, router};
use checkbook_postgres::{
    auth::authenticate,
    backup::{snapshot_household, validate_snapshot},
    connect, migrate, tenant,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

async fn response_json(response: axum::response::Response) -> anyhow::Result<Value> {
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
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

async fn login(app: &Router) -> anyhow::Result<String> {
    let email = format!("invoice-{}@example.com", uuid::Uuid::new_v4());
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/auth/dev-login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "email": email,
                        "full_name": "Invoice Owner",
                        "relationship_kind": "owner"
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    anyhow::ensure!(response.status() == StatusCode::OK);
    let payload = response_json(response).await?;
    payload["token"]
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow::anyhow!("login token missing"))
}

async fn json_request(
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
    let request_body = if let Some(body) = body {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        Body::from(body.to_string())
    } else {
        Body::empty()
    };
    Ok(app.clone().oneshot(builder.body(request_body)?).await?)
}

#[tokio::test]
async fn invoice_lifecycle_preserves_contract_and_immutable_revisions() -> anyhow::Result<()> {
    let Some((app, pool)) = test_router().await? else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let token = login(&app).await?;

    let buyer = json_request(
        &app,
        "POST",
        "/api/household/buyers",
        &token,
        Some(json!({
            "name": "Zażółć Sp. z o.o.",
            "nip": "1234567890",
            "address": "Łódź"
        })),
    )
    .await?;
    assert_eq!(buyer.status(), StatusCode::OK);
    let buyer = response_json(buyer).await?;
    assert_eq!(buyer["name"], "Zażółć Sp. z o.o.");
    assert!(buyer["created_at"].is_string());

    let template = json_request(
        &app,
        "POST",
        "/api/household/invoice-templates",
        &token,
        Some(json!({
            "name": "Consulting",
            "title": "Faktura",
            "seller_name": "Checkbook",
            "seller_details": "Warszawa",
            "buyer_name": "",
            "buyer_details": "",
            "currency": "PLN",
            "payment_terms": "14 days",
            "notes": "",
            "line_items": [{
                "description": "Consulting",
                "quantity": 1,
                "unit_price": 100,
                "vat_rate": "23",
                "unit": "h",
                "currency": ""
            }]
        })),
    )
    .await?;
    assert_eq!(template.status(), StatusCode::OK);
    let template = response_json(template).await?;
    assert_eq!(template["line_items"][0]["currency"], "");

    let write_payload = json!({
        "template_id": template["id"],
        "save_template": false,
        "template_name": null,
        "invoice_number": "INV-9001",
        "title": "Faktura",
        "income_source_id": null,
        "seller_name": "Checkbook",
        "seller_details": "Warszawa",
        "buyer_name": "Zażółć Sp. z o.o.",
        "buyer_details": "",
        "buyer_nip": "1234567890",
        "buyer_address": "Łódź",
        "issue_date": "2026-06-21",
        "sale_date": "2026-06-20",
        "due_date": "2026-07-05",
        "currency": "PLN",
        "status": "draft",
        "conversion_enabled": true,
        "conversion_currency": "EUR",
        "conversion_rate": 4.25,
        "tax_amount": 0,
        "payment_terms": "14 days",
        "notes": "Płatność przelewem",
        "line_items": [{
            "description": "Usługa",
            "quantity": 2,
            "unit_price": 100,
            "vat_rate": "23",
            "unit": "h",
            "currency": "EUR"
        }]
    });
    let created = json_request(
        &app,
        "POST",
        "/api/household/invoices/generate",
        &token,
        Some(write_payload.clone()),
    )
    .await?;
    if created.status() != StatusCode::OK {
        anyhow::bail!(
            "invoice generation returned {}: {}",
            created.status(),
            response_json(created).await?
        );
    }
    let created = response_json(created).await?;
    assert_eq!(created["invoice_number"], "INV-9001");
    assert_eq!(created["subtotal"], 850.0);
    assert_eq!(created["tax_amount"], 195.5);
    assert_eq!(created["total_amount"], 1045.5);
    assert_eq!(created["line_items"][0]["currency"], "EUR");
    let invoice_id = created["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invoice id missing"))?;

    let duplicate = json_request(
        &app,
        "POST",
        "/api/household/invoices/generate",
        &token,
        Some(write_payload.clone()),
    )
    .await?;
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(duplicate).await?,
        json!({ "detail": "Invoice number already exists." })
    );

    let mut update_payload = write_payload;
    update_payload["invoice_number"] = json!("INV-9002");
    update_payload["status"] = json!("issued");
    update_payload["line_items"][0]["quantity"] = json!(3);
    let updated = json_request(
        &app,
        "PUT",
        &format!("/api/household/invoices/{invoice_id}"),
        &token,
        Some(update_payload),
    )
    .await?;
    assert_eq!(updated.status(), StatusCode::OK);
    let updated = response_json(updated).await?;
    assert_eq!(updated["invoice_number"], "INV-9002");
    assert_eq!(updated["status"], "issued");
    assert_eq!(updated["total_amount"], 1568.25);

    let context = authenticate(&pool, &token).await?;
    let mut transaction = tenant::begin(&pool, context.household.id, true).await?;
    let revisions: i64 =
        sqlx::query_scalar("SELECT count(*) FROM invoice_revisions WHERE invoice_id = $1")
            .bind(uuid::Uuid::parse_str(invoice_id)?)
            .fetch_one(&mut *transaction)
            .await?;
    transaction.commit().await?;
    assert_eq!(revisions, 2);
    let mut invalid_archive = snapshot_household(&pool, context.household.id).await?;
    let revision_rows = invalid_archive
        .tables
        .get_mut("invoice_revisions")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow::anyhow!("invoice revisions missing from archive"))?;
    revision_rows[0]["subtotal"] = Value::String("999999.99".to_owned());
    assert!(validate_snapshot(&invalid_archive, context.household.id).is_err());

    let listed = json_request(&app, "GET", "/api/household/invoices", &token, None).await?;
    assert_eq!(listed.status(), StatusCode::OK);
    let listed = response_json(listed).await?;
    assert_eq!(listed[0]["invoice_number"], "INV-9002");

    let pdf = json_request(
        &app,
        "GET",
        &format!("/api/household/invoices/{invoice_id}/pdf"),
        &token,
        None,
    )
    .await?;
    assert_eq!(pdf.status(), StatusCode::OK);
    assert_eq!(pdf.headers()[header::CONTENT_TYPE], "application/pdf");
    assert!(
        pdf.headers()[header::CONTENT_DISPOSITION]
            .to_str()?
            .contains("INV-9002.pdf")
    );
    let pdf = to_bytes(pdf.into_body(), 16 * 1024 * 1024).await?;
    assert!(pdf.starts_with(b"%PDF-"));
    assert!(pdf.len() > 10_000);
    assert!(pdf.windows(5).any(|window| window == b"/Font"));

    let deleted = json_request(
        &app,
        "DELETE",
        &format!("/api/household/invoices/{invoice_id}"),
        &token,
        None,
    )
    .await?;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(response_json(deleted).await?, json!({ "ok": true }));
    let mut transaction = tenant::begin(&pool, context.household.id, true).await?;
    let audited: bool = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM audit_events
            WHERE household_id = $1 AND event_type = 'invoice_deleted'
              AND resource_id = $2
         )",
    )
    .bind(context.household.id)
    .bind(uuid::Uuid::parse_str(invoice_id)?)
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    assert!(audited);
    Ok(())
}
