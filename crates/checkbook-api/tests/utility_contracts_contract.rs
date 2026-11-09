use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use checkbook_api::{ApiState, dto, openapi_document, router};
use serde_json::json;
use tower::ServiceExt;
use uuid::Uuid;

#[test]
fn contract_update_rejects_property_ownership_and_create_only_fields() {
    let payload = json!({
        "label": "Water", "tracking_mode": "meter", "unit": "m3",
        "start_date": "2026-01-01", "end_date": null
    });
    assert!(serde_json::from_value::<dto::UtilityContractUpdate>(payload.clone()).is_ok());
    for (key, value) in [
        ("property_id", json!(Uuid::new_v4())),
        ("initial_price", json!(1.5)),
    ] {
        let mut invalid = payload.clone();
        invalid[key] = value;
        assert!(serde_json::from_value::<dto::UtilityContractUpdate>(invalid).is_err());
    }
}

#[test]
fn contracts_openapi_exposes_typed_operations_and_entry_provenance() -> anyhow::Result<()> {
    let document = openapi_document()?;
    let base = "/api/household/utilities/contracts";
    for (path, method, operation_id) in [
        (base.to_owned(), "get", "listUtilityContracts"),
        (base.to_owned(), "post", "createUtilityContract"),
        (format!("{base}/{{id}}"), "put", "updateUtilityContract"),
        (format!("{base}/reorder"), "post", "reorderUtilityContracts"),
        (
            format!("{base}/{{id}}/prices"),
            "get",
            "listUtilityContractPrices",
        ),
        (
            format!("{base}/{{id}}/prices"),
            "post",
            "createUtilityContractPrice",
        ),
        (
            format!("{base}/{{id}}/prices/{{price_id}}"),
            "put",
            "updateUtilityContractPrice",
        ),
    ] {
        let operation = &document["paths"][&path][method];
        assert_eq!(operation["operationId"], operation_id);
        assert!(operation["responses"]["200"]["content"]["application/json"]["schema"].is_object());
        assert!(operation["responses"]["401"].is_object());
        assert!(operation["responses"]["403"].is_object());
    }
    let schemas = &document["components"]["schemas"];
    assert!(schemas["UtilityContractUpdate"]["properties"]["property_id"].is_null());
    assert_eq!(
        schemas["UtilityContractUpdate"]["additionalProperties"],
        false
    );
    assert_eq!(
        schemas["UtilityEntryFormField"]["properties"]["amount_source"]["type"],
        "string"
    );
    let input: dto::UtilityEntryValue = serde_json::from_value(json!({
        "field_key": "water", "amount_source": "manual", "amount": 0
    }))?;
    assert_eq!(input.amount_source.as_deref(), Some("manual"));
    let legacy: dto::UtilityEntryValue = serde_json::from_value(json!({"field_key":"water"}))?;
    assert!(legacy.amount_source.is_none());
    Ok(())
}

#[tokio::test]
async fn contract_routes_require_authentication_without_touching_storage() -> anyhow::Result<()> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgresql://unused:unused@localhost/unused")?;
    let app = router(
        ApiState {
            pool,
            dev_auth_enabled: false,
            session_hours: 24,
            cloudflare: None,
            google: None,
            backup_admin_root: None,
        },
        Vec::new(),
    );
    let id = Uuid::new_v4();
    let base = "/api/household/utilities/contracts";
    let contract = json!({
        "label":"Water", "tracking_mode":"actual", "unit":"",
        "start_date":"2026-01-01", "end_date":null
    });
    let mut create = contract.clone();
    create["property_id"] = json!(id);
    let price = json!({"effective_on":"2026-01-01", "price":1.25});
    for (method, path, payload) in [
        ("GET", format!("{base}?property_id={id}"), json!(null)),
        ("POST", base.to_owned(), create),
        ("PUT", format!("{base}/{id}"), contract),
        (
            "POST",
            format!("{base}/reorder"),
            json!({"property_id": id, "ordered_ids":[Uuid::new_v4()]}),
        ),
        ("GET", format!("{base}/{id}/prices"), json!(null)),
        ("POST", format!("{base}/{id}/prices"), price.clone()),
        ("PUT", format!("{base}/{id}/prices/{id}"), price),
        (
            "POST",
            "/api/household/utilities/reassign".to_owned(),
            json!({
                "from_property_id":id, "to_property_id":Uuid::new_v4()
            }),
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(&path)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(payload.to_string()))?,
            )
            .await?;
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{method} {path}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn authenticated_legacy_reassign_rejects_immutable_ownership() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; utility ownership API test skipped");
        return Ok(());
    };
    let pool = checkbook_postgres::connect(&url, 5).await?;
    let context = checkbook_postgres::auth::create_development_session(
        &pool,
        &format!("contract-api-{}@example.com", Uuid::new_v4()),
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
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/household/utilities/reassign")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "from_property_id":Uuid::new_v4(), "to_property_id":Uuid::new_v4()
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024).await?;
    let body: serde_json::Value = serde_json::from_slice(&body)?;
    assert!(
        body["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("immutable"))
    );
    Ok(())
}

async fn send(
    app: &axum::Router,
    token: &str,
    method: &str,
    path: String,
    body: serde_json::Value,
) -> anyhow::Result<axum::response::Response> {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))?,
        )
        .await
        .map_err(anyhow::Error::from)
}

#[tokio::test]
async fn reorder_rewrites_list_and_board_column_order_and_rejects_partial_lists()
-> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; utility reorder API test skipped");
        return Ok(());
    };
    let pool = checkbook_postgres::connect(&url, 5).await?;
    let context = checkbook_postgres::auth::create_development_session(
        &pool,
        &format!("contract-reorder-{}@example.com", Uuid::new_v4()),
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
    let send_request = |method: &'static str, path: String, body: serde_json::Value| {
        send(&app, &token, method, path, body)
    };
    let property = send_request(
        "POST",
        "/api/household/assets".to_owned(),
        json!({
            "name":"Reorder house", "total_cost":1, "valuation_date":"2026-01-01",
            "status":"active", "started_on":"2026-01-01", "ended_on":null,
            "notes":"", "kind":"asset", "details":{}
        }),
    )
    .await?;
    assert_eq!(property.status(), StatusCode::OK);
    let property: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(property.into_body(), 1024 * 1024).await?)?;
    let property_id = property["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("property id missing"))?
        .to_owned();

    let mut contracts = Vec::new();
    for label in ["Water", "Power"] {
        let created = send_request(
            "POST",
            "/api/household/utilities/contracts".to_owned(),
            json!({
                "property_id": property_id, "label": label, "tracking_mode":"actual",
                "unit":"", "start_date":"2026-01-01", "end_date":null, "initial_price":null
            }),
        )
        .await?;
        assert_eq!(created.status(), StatusCode::OK);
        let created: serde_json::Value =
            serde_json::from_slice(&axum::body::to_bytes(created.into_body(), 1024 * 1024).await?)?;
        contracts.push(created);
    }

    let duplicate = send_request(
        "POST",
        "/api/household/utilities/contracts/reorder".to_owned(),
        json!({"property_id": property_id, "ordered_ids":[contracts[0]["id"], contracts[1]["id"], contracts[0]["id"]]}),
    )
    .await?;
    assert_eq!(duplicate.status(), StatusCode::UNPROCESSABLE_ENTITY);

    // A partial list must be rejected without changing the stored order.
    let partial = send_request(
        "POST",
        "/api/household/utilities/contracts/reorder".to_owned(),
        json!({"property_id": property_id, "ordered_ids":[contracts[0]["id"]]}),
    )
    .await?;
    assert_eq!(partial.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let foreign = send_request(
        "POST",
        "/api/household/utilities/contracts/reorder".to_owned(),
        json!({"property_id": property_id, "ordered_ids":[contracts[0]["id"], Uuid::new_v4()]}),
    )
    .await?;
    assert_eq!(foreign.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let reordered = send_request(
        "POST",
        "/api/household/utilities/contracts/reorder".to_owned(),
        json!({"property_id": property_id, "ordered_ids":[contracts[1]["id"], contracts[0]["id"]]}),
    )
    .await?;
    assert_eq!(reordered.status(), StatusCode::OK);
    let reordered: Vec<serde_json::Value> =
        serde_json::from_slice(&axum::body::to_bytes(reordered.into_body(), 1024 * 1024).await?)?;
    assert_eq!(reordered[0]["label"], "Power");
    assert_eq!(reordered[0]["sort_order"], 0);
    assert_eq!(reordered[1]["label"], "Water");
    assert_eq!(reordered[1]["sort_order"], 1);

    // The board's tracked fields — the details-table columns — follow suit.
    let board = send_request(
        "GET",
        format!("/api/household/utilities/board?property_id={property_id}"),
        json!(null),
    )
    .await?;
    assert_eq!(board.status(), StatusCode::OK);
    let board: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(board.into_body(), 1024 * 1024).await?)?;
    let keys: Vec<&str> = board["subject"]["tracked_fields"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|field| field["key"].as_str())
        .collect();
    assert_eq!(
        keys,
        vec![
            contracts[1]["key"].as_str().unwrap_or_default(),
            contracts[0]["key"].as_str().unwrap_or_default()
        ]
    );
    Ok(())
}

#[tokio::test]
async fn contract_colors_persist_preserve_clear_and_isolate_households() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; utility reorder API test skipped");
        return Ok(());
    };
    let pool = checkbook_postgres::connect(&url, 5).await?;
    let context = checkbook_postgres::auth::create_development_session(
        &pool,
        &format!("contract-reorder-{}@example.com", Uuid::new_v4()),
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
    let send_request = |method: &'static str, path: String, body: serde_json::Value| {
        send(&app, &token, method, path, body)
    };
    let property = send_request(
        "POST",
        "/api/household/assets".to_owned(),
        json!({
            "name":"Reorder house", "total_cost":1, "valuation_date":"2026-01-01",
            "status":"active", "started_on":"2026-01-01", "ended_on":null,
            "notes":"", "kind":"asset", "details":{}
        }),
    )
    .await?;
    assert_eq!(property.status(), StatusCode::OK);
    let property: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(property.into_body(), 1024 * 1024).await?)?;
    let property_id = property["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("property id missing"))?
        .to_owned();

    let base = "/api/household/utilities/contracts";
    let mut payload = json!({"property_id":property_id,"label":"Water","tracking_mode":"actual","unit":"","start_date":"2026-01-01","end_date":null,"color":"#aB12Ef"});
    let created = send_request("POST", base.to_owned(), payload.clone()).await?;
    assert_eq!(created.status(), StatusCode::OK);
    let created: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(created.into_body(), 1024 * 1024).await?)?;
    assert_eq!(created["color"], "#aB12Ef");
    let path = format!(
        "{base}/{}",
        created["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing contract id"))?
    );
    payload
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("payload object"))?
        .remove("property_id");
    for (color, expected) in [
        (None, json!("#aB12Ef")),
        (Some(json!("#018aFc")), json!("#018aFc")),
        (Some(json!(null)), json!(null)),
    ] {
        payload
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("payload object"))?
            .remove("color");
        if let Some(color) = color {
            payload["color"] = color;
        }
        let updated = send_request("PUT", path.clone(), payload.clone()).await?;
        assert_eq!(updated.status(), StatusCode::OK);
        let updated: serde_json::Value =
            serde_json::from_slice(&axum::body::to_bytes(updated.into_body(), 1024 * 1024).await?)?;
        assert_eq!(updated["color"], expected);
        let listed = send_request(
            "GET",
            format!("{base}?property_id={property_id}"),
            json!(null),
        )
        .await?;
        assert_eq!(listed.status(), StatusCode::OK);
        let listed: serde_json::Value =
            serde_json::from_slice(&axum::body::to_bytes(listed.into_body(), 1024 * 1024).await?)?;
        assert_eq!(listed[0]["color"], expected);
    }
    payload["color"] = json!("#fff");
    assert_eq!(
        send_request("PUT", path.clone(), payload.clone())
            .await?
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let other_pool = checkbook_postgres::connect(&url, 5).await?;
    let other = checkbook_postgres::auth::create_development_session(
        &other_pool,
        &format!("color-other-{}@example.com", Uuid::new_v4()),
        "Other",
        "owner",
        24,
    )
    .await?;
    let other_token = other
        .token
        .ok_or_else(|| anyhow::anyhow!("missing other token"))?;
    payload["color"] = json!("#123456");
    assert_eq!(
        send(&app, &other_token, "PUT", path, payload)
            .await?
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        send(
            &app,
            &other_token,
            "GET",
            format!("{base}?property_id={property_id}"),
            json!(null)
        )
        .await?
        .status(),
        StatusCode::NOT_FOUND
    );
    Ok(())
}
