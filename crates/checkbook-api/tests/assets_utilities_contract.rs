use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use checkbook_api::{ApiState, router};
use checkbook_postgres::{connect, migrate};
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
            "email": format!("assets-{}@example.com", uuid::Uuid::new_v4()),
            "full_name": "Assets Owner",
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

async fn create_property(app: &Router, token: &str, name: &str) -> anyhow::Result<String> {
    let response = request(
        app,
        "POST",
        "/api/household/assets",
        Some(token),
        Some(json!({
            "name": name,
            "total_cost": 500000,
            "valuation_date": "2026-06-01",
            "status": "active",
            "started_on": "2025-01-01",
            "ended_on": null,
            "notes": "",
            "kind": "asset",
            "details": {}
        })),
    )
    .await?;
    anyhow::ensure!(response.status() == StatusCode::OK);
    let payload = response_json(response).await?;
    payload["id"]
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow::anyhow!("property id missing"))
}

#[tokio::test]
async fn account_assets_round_trip_holdings_and_registration() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    migrate(&pool).await?;
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
    let token = login(&app).await?;

    // Registration omitted defaults to 'regular'; holdings keep their order.
    let created = request(
        &app,
        "POST",
        "/api/household/assets",
        Some(&token),
        Some(json!({
            "name": "Brokerage",
            "total_cost": 5000,
            "valuation_date": "2026-06-01",
            "status": "active",
            "kind": "asset",
            "category": "account",
            "account_type": "stocks",
            "holdings": [
                {
                    "name": "VTI",
                    "quantity": 3,
                    "unit_price": 250,
                    "value": 750,
                    "purchased_on": "2026-01-10",
                    "sold_on": null,
                    "sell_value": null,
                    "notes": "lot 1"
                },
                {
                    "name": "Cash",
                    "quantity": null,
                    "unit_price": null,
                    "value": 4250,
                    "purchased_on": null,
                    "sold_on": null,
                    "sell_value": null,
                    "notes": ""
                }
            ],
            "details": {}
        })),
    )
    .await?;
    assert_eq!(created.status(), StatusCode::OK);
    let account_id = response_json(created).await?["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("account id missing"))?
        .to_owned();

    let assets = request(&app, "GET", "/api/household/assets", Some(&token), None).await?;
    assert_eq!(assets.status(), StatusCode::OK);
    let assets = response_json(assets).await?;
    let summary = assets
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == account_id))
        .ok_or_else(|| anyhow::anyhow!("account summary missing"))?;
    assert_eq!(summary["category"], "account");
    assert_eq!(summary["account_type"], "stocks");
    assert_eq!(summary["account_registration"], "regular");
    let holdings = summary["holdings"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("holdings missing"))?;
    assert_eq!(holdings.len(), 2);
    assert_eq!(holdings[0]["name"], "VTI");
    assert_eq!(holdings[0]["value"], 750.0);
    assert_eq!(holdings[0]["purchased_on"], "2026-01-10");
    assert!(holdings[0]["id"].as_str().is_some_and(|id| !id.is_empty()));
    assert_eq!(holdings[1]["name"], "Cash");
    assert!(holdings[0]["ticker"].is_null());
    let price_path = format!("/api/household/assets/{account_id}/holding-prices");
    assert_eq!(
        request(&app, "GET", &price_path, None, None)
            .await?
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        response_json(request(&app, "GET", &price_path, Some(&token), None).await?).await?,
        json!({"prices": []})
    );
    let other_token = login(&app).await?;
    assert_eq!(
        request(&app, "GET", &price_path, Some(&other_token), None)
            .await?
            .status(),
        StatusCode::NOT_FOUND
    );
    let property_id = create_property(&app, &token, "Not an account").await?;
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/household/assets/{property_id}/holding-prices"),
            Some(&token),
            None
        )
        .await?
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &app,
            "GET",
            &format!(
                "/api/household/assets/{}/holding-prices",
                uuid::Uuid::new_v4()
            ),
            Some(&token),
            None
        )
        .await?
        .status(),
        StatusCode::NOT_FOUND
    );

    // Update replaces the full holdings list and persists registration.
    let updated = request(
        &app,
        "PUT",
        &format!("/api/household/assets/{account_id}"),
        Some(&token),
        Some(json!({
            "name": "Brokerage",
            "total_cost": 6000,
            "valuation_date": "2026-06-02",
            "status": "active",
            "category": "account",
            "account_type": "stocks",
            "account_registration": "retirement",
            "holdings": [
                {
                    "name": "VXUS",
                    "ticker": " vxus ",
                    "quantity": 2,
                    "unit_price": 50,
                    "value": 100,
                    "purchased_on": "2026-02-01",
                    "sold_on": "2026-03-01",
                    "sell_value": 110,
                    "notes": "closed lot"
                }
            ],
            "details": {}
        })),
    )
    .await?;
    assert_eq!(updated.status(), StatusCode::OK);
    let updated = response_json(updated).await?;
    assert_eq!(updated["account_registration"], "retirement");
    assert_eq!(updated["holdings"].as_array().map(Vec::len), Some(1));
    assert_eq!(updated["holdings"][0]["name"], "VXUS");
    assert_eq!(updated["holdings"][0]["sell_value"], 110.0);
    assert_eq!(updated["holdings"][0]["sold_on"], "2026-03-01");
    assert_eq!(updated["holdings"][0]["ticker"], "VXUS");
    assert_eq!(
        response_json(request(&app, "GET", &price_path, Some(&token), None).await?).await?,
        json!({"prices": []})
    );

    let deleted = request(
        &app,
        "DELETE",
        &format!("/api/household/assets/{account_id}"),
        Some(&token),
        None,
    )
    .await?;
    assert_eq!(deleted.status(), StatusCode::OK);
    Ok(())
}

#[tokio::test]
async fn account_asset_validation_rejects_invalid_payloads() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    migrate(&pool).await?;
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
    let token = login(&app).await?;

    let base_account = json!({
        "name": "Bank",
        "total_cost": 100,
        "valuation_date": "2026-06-01",
        "status": "active",
        "kind": "asset",
        "category": "account",
        "account_type": "savings",
        "details": {}
    });
    let mut missing_type = base_account.clone();
    remove_json_field(&mut missing_type, "account_type");
    let registration_on_property = json!({
        "name": "Cabin",
        "total_cost": 100,
        "valuation_date": "2026-06-01",
        "status": "active",
        "kind": "asset",
        "category": "property",
        "account_registration": "retirement",
        "details": {}
    });
    let mut type_on_property = registration_on_property.clone();
    remove_json_field(&mut type_on_property, "account_registration");
    type_on_property["account_type"] = json!("savings");
    let mut holdings_on_property = type_on_property.clone();
    remove_json_field(&mut holdings_on_property, "account_type");
    holdings_on_property["holdings"] = json!([
        {"name": "Lot", "value": 10}
    ]);
    let mut inverted_dates = base_account.clone();
    inverted_dates["holdings"] = json!([
        {
            "name": "Lot",
            "value": 10,
            "purchased_on": "2026-03-01",
            "sold_on": "2026-02-01"
        }
    ]);
    let mut negative_value = base_account.clone();
    negative_value["holdings"] = json!([{"name": "Lot", "value": -5}]);

    let mut account_project = base_account.clone();
    account_project["kind"] = json!("project");
    let mut zero_quantity = base_account.clone();
    zero_quantity["holdings"] = json!([{"name": "Lot", "quantity": 0, "value": 10}]);
    let mut negative_unit_price = base_account.clone();
    negative_unit_price["holdings"] = json!([{"name": "Lot", "unit_price": -1, "value": 10}]);
    let mut negative_sell_value = base_account.clone();
    negative_sell_value["holdings"] = json!([{"name": "Lot", "sell_value": -1, "value": 10}]);
    let mut blank_name = base_account.clone();
    blank_name["holdings"] = json!([{"name": "  ", "value": 0}]);

    for payload in [
        account_project,
        zero_quantity,
        negative_unit_price,
        negative_sell_value,
        blank_name,
        missing_type,
        registration_on_property,
        type_on_property,
        holdings_on_property,
        inverted_dates,
        negative_value,
    ] {
        let response = request(
            &app,
            "POST",
            "/api/household/assets",
            Some(&token),
            Some(payload),
        )
        .await?;
        assert_eq!(
            response.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "payload should be rejected"
        );
    }
    Ok(())
}

fn remove_json_field(payload: &mut serde_json::Value, field: &str) {
    if let Some(object) = payload.as_object_mut() {
        object.remove(field);
    }
}

#[tokio::test]
async fn assets_loans_and_utility_flows_match_the_frontend_contract() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    migrate(&pool).await?;
    let auth_test_pool = pool.clone();
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
    let token = login(&app).await?;
    let first_property = create_property(&app, &token, "Home").await?;
    let second_property = create_property(&app, &token, "Rental").await?;

    let project = request(
        &app,
        "POST",
        "/api/household/assets",
        Some(&token),
        Some(json!({
            "name": "Kitchen",
            "total_cost": 20000,
            "valuation_date": "2026-06-01",
            "status": "planned",
            "started_on": null,
            "ended_on": null,
            "notes": "",
            "kind": "project",
            "details": {
                "linked_asset_id": first_property,
                "rooms": [{
                    "name": "Kitchen",
                    "sections": [{
                        "name": "Cabinets",
                        "items": [{
                            "name": "Units",
                            "unit_price": 1000,
                            "quantity": 2,
                            "total_cost": 2000,
                            "completed": false
                        }]
                    }]
                }]
            }
        })),
    )
    .await?;
    assert_eq!(project.status(), StatusCode::OK);
    let project_id = response_json(project).await?["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("project id missing"))?
        .to_owned();

    let assets = request(&app, "GET", "/api/household/assets", Some(&token), None).await?;
    assert_eq!(assets.status(), StatusCode::OK);
    let assets = response_json(assets).await?;
    assert_eq!(assets.as_array().map(Vec::len), Some(3));
    let project_summary = assets
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == project_id))
        .ok_or_else(|| anyhow::anyhow!("project summary missing"))?;
    assert_eq!(project_summary["item_count"], 1);

    let updated = request(
        &app,
        "PUT",
        &format!("/api/household/assets/{project_id}"),
        Some(&token),
        Some(json!({
            "name": "Finished kitchen",
            "total_cost": 21000,
            "valuation_date": "2026-06-02",
            "status": "completed",
            "started_on": "2026-01-01",
            "ended_on": "2026-06-01",
            "notes": "Done",
            "details": {"linked_asset_id": first_property, "rooms": []}
        })),
    )
    .await?;
    assert_eq!(updated.status(), StatusCode::OK);
    assert_eq!(response_json(updated).await?["name"], "Finished kitchen");

    let loan = request(
        &app,
        "POST",
        "/api/household/loans",
        Some(&token),
        Some(json!({
            "name": "Mortgage",
            "current_balance": 300000,
            "monthly_payment": 2500,
            "original_balance": 350000,
            "interest_rate": 0.06,
            "liability_type": "mortgage",
            "owner_scope": "joint",
            "start_date": "2024-01-01",
            "end_date": null,
            "notes": ""
        })),
    )
    .await?;
    assert_eq!(loan.status(), StatusCode::OK);
    let loan_id = response_json(loan).await?["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("loan id missing"))?
        .to_owned();
    let loans = request(&app, "GET", "/api/household/loans", Some(&token), None).await?;
    assert_eq!(loans.status(), StatusCode::OK);
    assert_eq!(response_json(loans).await?[0]["id"], loan_id);

    let catalog = request(
        &app,
        "GET",
        "/api/household/utility-field-catalog",
        Some(&token),
        None,
    )
    .await?;
    assert_eq!(catalog.status(), StatusCode::OK);
    assert!(response_json(catalog).await?.is_array());

    // Legacy catalog configuration is read-only; mutations reject with 422
    // after authentication, and audit history for a never-created key is 404.
    for (method, path, body, expected) in [
        (
            "POST",
            "/api/household/utility-field-catalog",
            Some(
                json!({"key":"priced_water","label":"Water","kind":"metered","unit":"m3","entry_mode":"meter","unit_rate":2.125}),
            ),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            "PUT",
            "/api/household/utility-field-catalog/priced_water",
            Some(json!({"label":"Water updated","unit":"m3","entry_mode":"usage","unit_rate":3.5})),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            "GET",
            "/api/household/utility-field-catalog/priced_water/audit",
            None,
            StatusCode::NOT_FOUND,
        ),
    ] {
        let unauthenticated = request(&app, method, path, None, body.clone()).await?;
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
        let response = request(&app, method, path, Some(&token), body).await?;
        assert_eq!(response.status(), expected);
    }

    // Property utilities now flow through an explicitly created contract.
    let contract = request(
        &app,
        "POST",
        "/api/household/utilities/contracts",
        Some(&token),
        Some(json!({
            "property_id": first_property,
            "label": "Electricity",
            "tracking_mode": "meter",
            "unit": "kWh",
            "start_date": "2026-01-01",
            "end_date": null,
            "initial_price": 0.5
        })),
    )
    .await?;
    assert_eq!(contract.status(), StatusCode::OK);
    let contract = response_json(contract).await?;
    let contract_key = contract["key"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("contract key missing"))?
        .to_owned();

    for (month, reading) in [("2026-05", 1000), ("2026-06", 1025)] {
        let upsert = request(
            &app,
            "POST",
            &format!("/api/household/utilities/upsert?property_id={first_property}"),
            Some(&token),
            Some(json!({
                "month": month,
                "entries": [{
                    "field_key": contract_key,
                    "meter_reading": reading
                }]
            })),
        )
        .await?;
        assert_eq!(upsert.status(), StatusCode::OK);
    }
    let form = request(
        &app,
        "GET",
        &format!("/api/household/utilities/form?property_id={first_property}&month=2026-06"),
        Some(&token),
        None,
    )
    .await?;
    assert_eq!(form.status(), StatusCode::OK);
    let form = response_json(form).await?;
    let electricity = form["fields"]
        .as_array()
        .and_then(|fields| fields.iter().find(|field| field["key"] == contract_key))
        .ok_or_else(|| anyhow::anyhow!("electricity field missing"))?;
    assert_eq!(electricity["meter_reading"], 1025.0);
    assert_eq!(electricity["previous_meter_reading"], 1000.0);

    let board = request(
        &app,
        "GET",
        &format!("/api/household/utilities/board?property_id={first_property}&months=3"),
        Some(&token),
        None,
    )
    .await?;
    assert_eq!(board.status(), StatusCode::OK);
    assert_eq!(response_json(board).await?["subject"]["id"], first_property);

    // Contract ownership is permanently bound to its property.
    let reassigned = request(
        &app,
        "POST",
        "/api/household/utilities/reassign",
        Some(&token),
        Some(json!({
            "from_property_id": first_property,
            "to_property_id": second_property
        })),
    )
    .await?;
    assert_eq!(reassigned.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let water = request(
        &app,
        "POST",
        "/api/household/utilities/contracts",
        Some(&token),
        Some(json!({
            "property_id": second_property,
            "label": "Water",
            "tracking_mode": "usage",
            "unit": "m3",
            "start_date": "2026-01-01",
            "end_date": null,
            "initial_price": 2.0
        })),
    )
    .await?;
    assert_eq!(water.status(), StatusCode::OK);
    let water_key = response_json(water).await?["key"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("water contract key missing"))?
        .to_owned();

    let manual = request(
        &app,
        "POST",
        "/api/household/utilities",
        Some(&token),
        Some(json!({
            "provider": "Water company",
            "description": "Water",
            "amount": 80,
            "charge_date": "2026-06-05",
            "owner_scope": "joint",
            "category_name": "Utilities",
            "property_id": second_property,
            "group_id": null,
            "service_key": water_key,
            "usage_amount": 5,
            "usage_unit": "m3",
            "meter_reading": null,
            "notes": ""
        })),
    )
    .await?;
    assert_eq!(manual.status(), StatusCode::OK);
    assert_eq!(response_json(manual).await?["record_type"], "utility");

    for asset_id in [&project_id, &first_property, &second_property] {
        let deleted = request(
            &app,
            "DELETE",
            &format!("/api/household/assets/{asset_id}"),
            Some(&token),
            None,
        )
        .await?;
        assert_eq!(deleted.status(), StatusCode::OK);
    }
    let context = checkbook_postgres::auth::authenticate(&auth_test_pool, &token).await?;
    let mut tx =
        checkbook_postgres::tenant::begin(&auth_test_pool, context.household.id, false).await?;
    sqlx::query!(
        "UPDATE household_memberships SET role='contributor' WHERE household_id=$1 AND user_id=$2",
        context.household.id,
        context.user.id
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    for (method, path, body) in [
        (
            "POST",
            "/api/household/utility-field-catalog",
            json!({"key":"denied","label":"Denied","kind":"metered","unit":"m3","entry_mode":"meter","unit_rate":1}),
        ),
        (
            "PUT",
            "/api/household/utility-field-catalog/priced_water",
            json!({"label":"Denied","unit":"m3","entry_mode":"meter","unit_rate":1}),
        ),
    ] {
        let denied = request(&app, method, path, Some(&token), Some(body)).await?;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    }
    Ok(())
}
