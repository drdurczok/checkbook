use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use checkbook_api::{ApiState, router};
use checkbook_postgres::{auth::create_development_session, connect};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

#[test]
fn planner_openapi_has_typed_transport_contract() -> anyhow::Result<()> {
    let document = checkbook_api::openapi_document()?;
    assert_eq!(
        document["paths"]["/api/payday-planner"]["get"]["operationId"],
        "getPaydayPlanner"
    );
    assert!(document["paths"]["/api/payday-planner/apply"]["post"]["requestBody"].is_object());
    assert!(document["components"]["schemas"]["Response"]["properties"]["income"].is_object());
    let payload = &document["components"]["schemas"]["Payload"];
    assert!(payload["properties"]["recurring"].is_object());
    assert!(payload["properties"]["position"].is_object());
    assert!(document["components"]["schemas"]["Item"]["properties"]["position"].is_object());
    assert!(
        !payload["required"]
            .as_array()
            .is_some_and(|fields| fields.iter().any(|field| field == "position"))
    );
    assert!(payload["properties"]["expense_group_id"].is_object());
    assert!(
        !payload["required"]
            .as_array()
            .is_some_and(|fields| fields.iter().any(|field| field == "recurring"))
    );
    Ok(())
}

#[tokio::test]
async fn planner_authenticated_lifecycle_and_household_isolation() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; payday API contract skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let owner = create_development_session(
        &pool,
        &format!("payday-api-{}@example.com", Uuid::new_v4()),
        "Owner",
        "owner",
        24,
    )
    .await?;
    let other = create_development_session(
        &pool,
        &format!("payday-api-{}@example.com", Uuid::new_v4()),
        "Other",
        "owner",
        24,
    )
    .await?;
    let owner_token = owner
        .token
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("owner token missing"))?;
    let other_token = other
        .token
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("other token missing"))?;
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
    let unauthorized = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/payday-planner")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    let mut tx = checkbook_postgres::tenant::begin(&pool, owner.household.id, false).await?;
    let group: Uuid = sqlx::query_scalar("INSERT INTO expense_groups (household_id,name,normalized_name) VALUES ($1,'Food','food') RETURNING id").bind(owner.household.id).fetch_one(&mut *tx).await?;
    let category: Uuid = sqlx::query_scalar("INSERT INTO categories (household_id,kind,name,normalized_name,expense_group_id) VALUES ($1,'expense','Groceries','groceries',$2) RETURNING id").bind(owner.household.id).bind(group).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO ledger_entries (household_id,direction,status,amount,entry_date,description,owner_scope,data_source,category_id) VALUES ($1,'expense','actual',173.80,'2026-06-01','Groceries','joint','app_manual',$2)").bind(owner.household.id).bind(category).execute(&mut *tx).await?;
    tx.commit().await?;
    let grouped = json!({"month":"2026-06","title":"Food","section":"monthly","kind":"expense","expense_group_id":group,"amount":"200"});
    for (token, status) in [
        (other_token, StatusCode::UNPROCESSABLE_ENTITY),
        (owner_token, StatusCode::OK),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/payday-planner/allocations")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(grouped.to_string()))?,
            )
            .await?;
        assert_eq!(response.status(), status);
        if status == StatusCode::OK {
            let response: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await?)?;
            assert_eq!(response["allocations"][0]["expense_group_name"], "Food");
            assert_eq!(response["allocations"][0]["actual_amount"], "173.80");
            assert_eq!(response["unplanned_actual_total"], "0");
            let id = response["allocations"][0]["id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("missing grouped ID"))?;
            let deleted = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("DELETE")
                        .uri(format!("/api/payday-planner/allocations/{id}"))
                        .header("authorization", format!("Bearer {owner_token}"))
                        .body(Body::empty())?,
                )
                .await?;
            assert_eq!(deleted.status(), StatusCode::OK);
        }
    }
    let payload = json!({"month":"2026-06","title":"Emergency fund","section":"flexible","kind":"savings","amount":"100.25","notes":"Payday","completed":true,"position":7});
    let mut invalid_payload = payload.clone();
    invalid_payload["position"] = json!(-1);
    let invalid = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/payday-planner/allocations")
                .header("authorization", format!("Bearer {owner_token}"))
                .header("content-type", "application/json")
                .body(Body::from(invalid_payload.to_string()))?,
        )
        .await?;
    assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/payday-planner/allocations")
                .header("authorization", format!("Bearer {owner_token}"))
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await?)?;
    assert_eq!(body["total_allocated"], "100.25");
    assert_eq!(body["completed_total"], "100.25");
    assert_eq!(body["allocations"][0]["position"], 7);
    assert!(body["allocations"][0]["actual_amount"].is_null());
    let id = body["allocations"][0]["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("allocation missing"))?;
    let denied = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/payday-planner/allocations/{id}"))
                .header("authorization", format!("Bearer {other_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(denied.status(), StatusCode::NOT_FOUND);
    let mut recurring_payload = payload.clone();
    recurring_payload
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("allocation payload is not an object"))?
        .remove("position");
    recurring_payload["recurring"] = json!(true);
    recurring_payload["amount"] = json!("222.22");
    let enabled = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/api/payday-planner/allocations/{id}"))
                .header("authorization", format!("Bearer {owner_token}"))
                .header("content-type", "application/json")
                .body(Body::from(recurring_payload.to_string()))?,
        )
        .await?;
    assert_eq!(enabled.status(), StatusCode::OK);
    let enabled: Value =
        serde_json::from_slice(&to_bytes(enabled.into_body(), 1024 * 1024).await?)?;
    let template_id = enabled["allocations"][0]["template_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("recurring template link missing"))?;
    assert_eq!(enabled["allocations"][0]["position"], 7);
    assert_eq!(enabled["templates"][0]["id"], template_id);
    assert_eq!(enabled["templates"][0]["section"], "flexible");
    assert_eq!(enabled["templates"][0]["amount"], "222.22");
    recurring_payload["recurring"] = json!(false);
    let disabled = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/api/payday-planner/allocations/{id}"))
                .header("authorization", format!("Bearer {owner_token}"))
                .header("content-type", "application/json")
                .body(Body::from(recurring_payload.to_string()))?,
        )
        .await?;
    assert_eq!(disabled.status(), StatusCode::OK);
    let disabled: Value =
        serde_json::from_slice(&to_bytes(disabled.into_body(), 1024 * 1024).await?)?;
    assert_eq!(disabled["allocations"][0]["position"], 7);
    assert!(disabled["allocations"][0]["template_id"].is_null());
    assert_eq!(disabled["allocations"][0]["amount"], "222.22");
    assert_eq!(disabled["templates"], json!([]));
    let deleted = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/payday-planner/allocations/{id}"))
                .header("authorization", format!("Bearer {owner_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(deleted.status(), StatusCode::OK);
    Ok(())
}
