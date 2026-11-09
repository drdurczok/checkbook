use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use checkbook_api::{ApiState, openapi_document, router};
use checkbook_postgres::{auth::authenticate, connect, tenant};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    payload: Option<Value>,
) -> anyhow::Result<axum::response::Response> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let body = if let Some(payload) = payload {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        Body::from(payload.to_string())
    } else {
        Body::empty()
    };
    Ok(app.clone().oneshot(builder.body(body)?).await?)
}

async fn response_json(response: axum::response::Response) -> anyhow::Result<Value> {
    Ok(serde_json::from_slice(
        &to_bytes(response.into_body(), 4 * 1024 * 1024).await?,
    )?)
}

async fn login(app: &Router) -> anyhow::Result<String> {
    let response = request(
        app,
        "POST",
        "/api/auth/dev-login",
        None,
        Some(json!({
            "email": format!("loan-edit-{}@example.com", Uuid::new_v4()),
            "full_name": "Loan Editor", "relationship_kind": "owner"
        })),
    )
    .await?;
    assert_eq!(response.status(), StatusCode::OK);
    response_json(response).await?["token"]
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow::anyhow!("token missing"))
}

async fn create_id(app: &Router, token: &str, path: &str, payload: Value) -> anyhow::Result<Uuid> {
    let response = request(app, "POST", path, Some(token), Some(payload)).await?;
    let status = response.status();
    let body = response_json(response).await?;
    assert_eq!(status, StatusCode::OK, "{path}: {body}");
    Ok(Uuid::parse_str(
        body["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("id missing"))?,
    )?)
}

fn update_payload(property_id: Option<Uuid>) -> Value {
    json!({
        "name": "  Edited mortgage  ", "current_balance": 12345.67,
        "monthly_payment": 234.56, "interest_rate": 0.035,
        "original_balance": null, "start_date": "2025-01-01", "end_date": null,
        "notes": "Updated notes", "linked_property_id": property_id
    })
}

#[test]
fn loan_edit_openapi_has_typed_contract() -> anyhow::Result<()> {
    let document = openapi_document()?;
    let operation = &document["paths"]["/api/household/loans/{loan_id}"]["put"];
    assert_eq!(operation["operationId"], "updateLoan");
    assert_eq!(
        operation["requestBody"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/LoanUpdatePayload"
    );
    assert_eq!(
        operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/LoanSummary"
    );
    assert!(operation["responses"]["404"].is_object());
    let payload = &document["components"]["schemas"]["LoanUpdatePayload"];
    assert!(
        !payload["required"]
            .as_array()
            .is_some_and(|required| { required.iter().any(|name| name == "payment_schedule") })
    );
    let schedule = &payload["properties"]["payment_schedule"];
    assert_eq!(
        schedule["items"]["$ref"],
        "#/components/schemas/LoanSchedulePaymentPayload"
    );
    let row = &document["components"]["schemas"]["LoanSchedulePaymentPayload"];
    assert_eq!(row["required"], json!(["date"]));
    assert_eq!(row["properties"]["date"]["format"], "date");
    assert_eq!(row["additionalProperties"], false);
    assert_eq!(
        row["properties"]["projected"]["type"],
        json!(["boolean", "null"])
    );
    assert_eq!(
        row["properties"]["completed"]["type"],
        json!(["boolean", "null"])
    );
    assert_eq!(row["properties"]["id"]["format"], "uuid");
    Ok(())
}

#[test]
fn schedule_payload_is_typed_and_optional() -> anyhow::Result<()> {
    use checkbook_api::dto::LoanUpdatePayload;
    use checkbook_domain::LoanSchedulePayment;
    use rust_decimal::Decimal;

    let omitted: LoanUpdatePayload = serde_json::from_value(update_payload(None))?;
    assert!(omitted.payment_schedule.is_none());
    let mut without_scalars = update_payload(None);
    let fields = without_scalars
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("payload missing"))?;
    fields.remove("current_balance");
    fields.remove("monthly_payment");
    let omitted: LoanUpdatePayload = serde_json::from_value(without_scalars.clone())?;
    assert!(omitted.current_balance.is_none());
    assert!(omitted.monthly_payment.is_none());
    without_scalars["current_balance"] = Value::Null;
    without_scalars["monthly_payment"] = Value::Null;
    let null: LoanUpdatePayload = serde_json::from_value(without_scalars)?;
    assert!(null.current_balance.is_none());
    assert!(null.monthly_payment.is_none());
    let mut payload = update_payload(None);
    payload["payment_schedule"] = Value::Null;
    let null: LoanUpdatePayload = serde_json::from_value(payload.clone())?;
    assert!(null.payment_schedule.is_none());
    payload["payment_schedule"] = json!([]);
    let cleared: LoanUpdatePayload = serde_json::from_value(payload.clone())?;
    assert!(cleared.payment_schedule.is_some_and(|rows| rows.is_empty()));
    payload["payment_schedule"] = json!([{
        "date": "2028-02-29", "payment": "123.4567890123456789012345678",
        "interest": 0, "principal": null, "projected": false
    }]);
    let parsed: LoanUpdatePayload = serde_json::from_value(payload.clone())?;
    let row: LoanSchedulePayment = parsed
        .payment_schedule
        .and_then(|mut rows| rows.pop())
        .ok_or_else(|| anyhow::anyhow!("schedule missing"))?
        .into();
    row.validate()?;
    assert_eq!(
        row.payment,
        Some("123.4567890123456789012345678".parse::<Decimal>()?)
    );
    let stored = serde_json::to_value(row)?;
    assert_eq!(stored["payment"], "123.4567890123456789012345678");
    assert!(stored.get("principal").is_none());
    for schedule in [
        json!({}),
        json!([null]),
        json!([{}]),
        json!([{"date":"2027-02-29"}]),
        json!([{"date":"not a date"}]),
        json!([{"date":"2027-01-01", "payment":"NaN"}]),
        json!([{"date":"2027-01-01", "payment":true}]),
        json!([{"date":"2027-01-01", "projected":"true"}]),
        json!([{"date":"2027-01-01", "unknown":0}]),
    ] {
        payload["payment_schedule"] = schedule;
        assert!(serde_json::from_value::<LoanUpdatePayload>(payload.clone()).is_err());
    }
    Ok(())
}

#[tokio::test]
async fn loan_edits_preserve_imports_and_enforce_household_scope_and_permissions()
-> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL loan update contract skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 8).await?;
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
    let token = login(&app).await?;
    let other_token = login(&app).await?;
    let context = authenticate(&pool, &token).await?;
    let household_id = context.household.id;
    let property_payload = json!({"name": "Home", "kind": "asset", "total_cost": 150000,
        "valuation_date": "2026-01-01", "status": "active", "details": {}});
    let property = create_id(
        &app,
        &token,
        "/api/household/assets",
        property_payload.clone(),
    )
    .await?;
    let mut second_property_payload = property_payload.clone();
    second_property_payload["name"] = json!("Second home");
    let second_property = create_id(
        &app,
        &token,
        "/api/household/assets",
        second_property_payload,
    )
    .await?;
    let foreign_property = create_id(
        &app,
        &other_token,
        "/api/household/assets",
        property_payload,
    )
    .await?;
    let loan = create_id(
        &app,
        &token,
        "/api/household/loans",
        json!({
            "name": "Imported mortgage", "current_balance": 20000, "original_balance": 30000,
            "monthly_payment": 300, "interest_rate": 0.04, "liability_type": "mortgage",
            "owner_scope": "self", "linked_property_id": property
        }),
    )
    .await?;
    let path = format!("/api/household/loans/{loan}");
    let terms = json!({"bank": "Imported Bank", "payment_schedule": [{"date": "2027-01-01", "payment": "300.12"}],
        "custom": {"keep": true}});
    let mut tx = tenant::begin(&pool, household_id, false).await?;
    // Match bulk import: loan details have a backing account but no independent debt snapshots.
    sqlx::query("DELETE FROM account_balance_snapshots s USING loans l WHERE l.household_id=$1 AND l.id=$2 AND s.household_id=l.household_id AND s.account_id=l.account_id")
        .bind(household_id).bind(loan).execute(&mut *tx).await?;
    sqlx::query("UPDATE loans SET terms_payload=$3, data_source='bulk_load', source_key='bulk_load:loan:original-import', source_fingerprint='original-import' WHERE household_id=$1 AND id=$2")
        .bind(household_id).bind(loan).bind(&terms).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO loan_payments (household_id,loan_id,payment_date,total_payment,principal_amount,interest_amount,remaining_balance,source_key) VALUES ($1,$2,'2027-01-01',300.12,220.01,80.11,19779.99,'imported:scheduled-payment')")
        .bind(household_id).bind(loan).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut schedule_edit = update_payload(None);
    schedule_edit["payment_schedule"] = json!([{"date":"2028-01-01", "payment":1}]);

    assert_eq!(
        request(&app, "PUT", &path, None, Some(schedule_edit.clone()))
            .await?
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "PUT",
            &path,
            Some(&other_token),
            Some(schedule_edit.clone())
        )
        .await?
        .status(),
        StatusCode::NOT_FOUND
    );
    for invalid_property in [foreign_property, Uuid::new_v4()] {
        let response = request(
            &app,
            "PUT",
            &path,
            Some(&token),
            Some(update_payload(Some(invalid_property))),
        )
        .await?;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(response_json(response).await?["detail"].is_string());
    }
    let mut invalids = Vec::new();
    for (key, value) in [
        ("name", json!(" ")),
        ("current_balance", json!(-1)),
        ("monthly_payment", json!(-1)),
        ("interest_rate", json!(1.01)),
        ("interest_rate", json!(-0.01)),
        ("original_balance", json!(-1)),
        ("end_date", json!("2024-12-31")),
    ] {
        let mut payload = update_payload(None);
        payload[key] = value;
        invalids.push(payload);
    }
    for field in [
        "payment",
        "interest",
        "principal",
        "extra_principal",
        "outstanding_loan_balance",
        "interest_balance",
    ] {
        let mut payload = update_payload(None);
        let mut row = json!({"date": "2027-01-01"});
        row[field] = json!("-0.001");
        payload["payment_schedule"] = json!([row]);
        invalids.push(payload);
    }
    for schedule in [
        json!([{"date":"2027-02-29"}]),
        json!([{"date":"2027-01-01", "payment":"invalid"}]),
        json!([{"date":"2027-01-01", "projected":"yes"}]),
        json!([{"date":"2027-01-01", "unexpected":1}]),
    ] {
        let mut payload = update_payload(None);
        payload["payment_schedule"] = schedule;
        invalids.push(payload);
    }
    for payload in invalids {
        assert_eq!(
            request(&app, "PUT", &path, Some(&token), Some(payload))
                .await?
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    for immutable_field in ["owner_scope", "liability_type", "details"] {
        let mut invalid_payload = update_payload(None);
        invalid_payload[immutable_field] = json!("cannot change");
        let response = request(&app, "PUT", &path, Some(&token), Some(invalid_payload)).await?;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            response_json(response).await?,
            json!({"detail": "Loan details are invalid."})
        );
    }

    let property_only = request(
        &app,
        "PUT",
        &path,
        Some(&token),
        Some(json!({
            "name": "Imported mortgage", "current_balance": 20000,
            "monthly_payment": 300, "interest_rate": 0.04, "original_balance": null,
            "start_date": null, "end_date": null, "notes": "",
            "linked_property_id": second_property
        })),
    )
    .await?;
    assert_eq!(property_only.status(), StatusCode::OK);
    let mut tx = tenant::begin(&pool, household_id, true).await?;
    let imported_snapshots: i64 = sqlx::query_scalar("SELECT count(*) FROM account_balance_snapshots s JOIN loans l ON l.household_id=s.household_id AND l.account_id=s.account_id WHERE l.household_id=$1 AND l.id=$2")
        .bind(household_id).bind(loan).fetch_one(&mut *tx).await?;
    assert_eq!(imported_snapshots, 0);
    tx.commit().await?;

    for linked_property in [Some(second_property), None] {
        let response = request(
            &app,
            "PUT",
            &path,
            Some(&token),
            Some(update_payload(linked_property)),
        )
        .await?;
        assert_eq!(response.status(), StatusCode::OK);
        let edited = response_json(response).await?;
        assert_eq!(edited["id"], loan.to_string());
        assert_eq!(edited["name"], "Edited mortgage");
        assert_eq!(edited["current_balance"], 19779.99);
        assert_eq!(edited["monthly_payment"], 300.12);
        assert_eq!(edited["original_balance"], 30000.0);
        assert_eq!(edited["details"]["bank"], terms["bank"]);
        assert_eq!(edited["details"]["custom"], terms["custom"]);
        let actual = &edited["details"]["payment_schedule"][0];
        assert!(Uuid::parse_str(actual["id"].as_str().unwrap_or_default()).is_ok());
        assert_eq!(actual["completed"], true);
        assert_eq!(actual["projected"], false);
        assert_eq!(actual["payment"], "300.12");
        assert_eq!(actual["outstanding_loan_balance"], "19779.99");
        assert_eq!(edited["linked_property_id"], json!(linked_property));
        let listed =
            response_json(request(&app, "GET", "/api/household/loans", Some(&token), None).await?)
                .await?;
        assert_eq!(listed[0], edited);
        let mut tx = tenant::begin(&pool, household_id, true).await?;
        let linked: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM loans WHERE household_id=$1 AND linked_property_id=$2",
        )
        .bind(household_id)
        .bind(second_property)
        .fetch_all(&mut *tx)
        .await?;
        assert_eq!(
            linked,
            if linked_property.is_some() {
                vec![loan]
            } else {
                Vec::new()
            }
        );
        let old_link_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM loans WHERE household_id=$1 AND linked_property_id=$2",
        )
        .bind(household_id)
        .bind(property)
        .fetch_one(&mut *tx)
        .await?;
        assert_eq!(old_link_count, 0);
        tx.commit().await?;
    }
    let schedule = json!([
        {"date":"2027-01-01", "payment":"300.1200000000000000000000001", "interest":"80.11", "principal":"220.01", "extra_principal":"0", "outstanding_loan_balance":"19779.99", "interest_balance":"0", "projected":false},
        {"date":"2027-02-01", "payment":"400", "projected":true}
    ]);
    let mut payload = update_payload(None);
    payload["payment_schedule"] = schedule.clone();
    let replaced = request(&app, "PUT", &path, Some(&token), Some(payload)).await?;
    assert_eq!(replaced.status(), StatusCode::OK);
    let replaced = response_json(replaced).await?;
    assert_eq!(replaced["current_balance"], 19779.99);
    let schedule = replaced["details"]["payment_schedule"].clone();
    let rows = schedule
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("canonical payment schedule missing"))?;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["payment"], "300.1200000000000000000000001");
    assert_eq!(rows[0]["completed"], true);
    assert_eq!(rows[0]["projected"], false);
    assert_eq!(rows[1]["payment"], "400");
    assert_eq!(rows[1]["interest"], "57.69");
    assert_eq!(rows[1]["principal"], "342.31");
    assert_eq!(rows[1]["outstanding_loan_balance"], "19437.68");
    assert_eq!(rows[1]["interest_balance"], "0");
    assert_eq!(rows[1]["completed"], false);
    assert_eq!(rows[1]["projected"], true);
    assert_ne!(rows[0]["id"], rows[1]["id"]);
    for row in rows {
        Uuid::parse_str(
            row["id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("payment identity missing"))?,
        )?;
    }
    assert_eq!(replaced["details"]["bank"], terms["bank"]);
    assert_eq!(replaced["details"]["custom"], terms["custom"]);
    let listed =
        response_json(request(&app, "GET", "/api/household/loans", Some(&token), None).await?)
            .await?;
    assert_eq!(listed[0], replaced);
    for explicit_null in [false, true] {
        let mut payload = update_payload(None);
        if explicit_null {
            payload["payment_schedule"] = Value::Null;
        }
        let preserved = request(&app, "PUT", &path, Some(&token), Some(payload)).await?;
        assert_eq!(preserved.status(), StatusCode::OK);
        assert_eq!(
            response_json(preserved).await?["details"]["payment_schedule"],
            schedule
        );
    }
    let mut payload = update_payload(None);
    payload["payment_schedule"] = json!([]);
    let cleared = request(&app, "PUT", &path, Some(&token), Some(payload)).await?;
    assert_eq!(cleared.status(), StatusCode::OK);
    let cleared = response_json(cleared).await?;
    let mut expected_terms = terms.clone();
    expected_terms["payment_schedule"] = json!([]);
    assert_eq!(cleared["details"], expected_terms);
    let mut tx = tenant::begin(&pool, household_id, true).await?;
    let stored_terms = sqlx::query_scalar!(
        r#"SELECT terms_payload AS "terms_payload!: Value" FROM loans WHERE household_id=$1 AND id=$2"#,
        household_id,
        loan
    )
    .fetch_one(&mut *tx)
    .await?;
    expected_terms
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("loan terms are not an object"))?
        .remove("payment_schedule");
    assert_eq!(stored_terms, expected_terms);
    let stored: (String,String,String,String,String) = sqlx::query_as("SELECT owner_scope,liability_type,data_source,source_fingerprint,source_key FROM loans WHERE household_id=$1 AND id=$2")
        .bind(household_id).bind(loan).fetch_one(&mut *tx).await?;
    assert_eq!(
        stored,
        (
            "self".to_owned(),
            "mortgage".to_owned(),
            "bulk_load".to_owned(),
            "original-import".to_owned(),
            "bulk_load:loan:original-import".to_owned()
        )
    );
    let payments: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM loan_payments WHERE household_id=$1 AND loan_id=$2",
        household_id,
        loan
    )
    .fetch_one(&mut *tx)
    .await?
    .ok_or_else(|| anyhow::anyhow!("payment count missing"))?;
    assert_eq!(payments, 0);
    let account_matches: i64 = sqlx::query_scalar("SELECT count(*) FROM financial_accounts a JOIN loans l ON l.household_id=a.household_id AND l.account_id=a.id WHERE l.household_id=$1 AND l.id=$2 AND a.name=l.name AND a.notes=l.notes AND a.opened_on=l.start_date AND a.closed_on IS NOT DISTINCT FROM l.end_date AND a.owner_scope='self' AND a.account_type='mortgage'")
        .bind(household_id).bind(loan).fetch_one(&mut *tx).await?;
    assert_eq!(account_matches, 1);
    let planning_matches: i64 = sqlx::query_scalar("SELECT count(*) FROM planning_rules WHERE household_id=$1 AND linked_loan_id=$2 AND enabled")
        .bind(household_id).bind(loan).fetch_one(&mut *tx).await?;
    assert_eq!(planning_matches, 0);
    let imported_snapshots: i64 = sqlx::query_scalar("SELECT count(*) FROM account_balance_snapshots s JOIN loans l ON l.household_id=s.household_id AND l.account_id=s.account_id WHERE l.household_id=$1 AND l.id=$2")
        .bind(household_id).bind(loan).fetch_one(&mut *tx).await?;
    assert_eq!(imported_snapshots, 0);
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE household_id=$1 AND resource_id=$2 AND event_type='loan.updated' AND actor_user_id=$3")
        .bind(household_id).bind(loan).bind(context.user.id).fetch_one(&mut *tx).await?;
    assert_eq!(audits, 7);
    tx.commit().await?;

    let manual_loan = create_id(
        &app,
        &token,
        "/api/household/loans",
        json!({
            "name": "Manual loan", "current_balance": 20000, "original_balance": 30000,
            "monthly_payment": 300, "interest_rate": 0.04, "liability_type": "loan",
            "owner_scope": "self"
        }),
    )
    .await?;
    let mut manual_payload = update_payload(None);
    manual_payload["name"] = json!("Edited manual loan");
    let manual_edit = request(
        &app,
        "PUT",
        &format!("/api/household/loans/{manual_loan}"),
        Some(&token),
        Some(manual_payload),
    )
    .await?;
    assert_eq!(manual_edit.status(), StatusCode::OK);
    let mut tx = tenant::begin(&pool, household_id, true).await?;
    let manual_snapshots: i64 = sqlx::query_scalar("SELECT count(*) FROM account_balance_snapshots s JOIN loans l ON l.household_id=s.household_id AND l.account_id=s.account_id WHERE l.household_id=$1 AND l.id=$2")
        .bind(household_id).bind(manual_loan).fetch_one(&mut *tx).await?;
    assert_eq!(manual_snapshots, 2);
    let latest_balance: rust_decimal::Decimal = sqlx::query_scalar("SELECT s.balance FROM account_balance_snapshots s JOIN loans l ON l.household_id=s.household_id AND l.account_id=s.account_id WHERE l.household_id=$1 AND l.id=$2 ORDER BY s.effective_date DESC, s.created_at DESC LIMIT 1")
        .bind(household_id).bind(manual_loan).fetch_one(&mut *tx).await?;
    assert_eq!(latest_balance, rust_decimal::Decimal::new(20000, 0));
    tx.commit().await?;

    let contributor = crate_contributor_session(&pool, household_id).await?;
    assert_eq!(
        request(
            &app,
            "PUT",
            &path,
            Some(&contributor),
            Some(schedule_edit.clone())
        )
        .await?
        .status(),
        StatusCode::NOT_FOUND
    );
    let mut tx = tenant::begin(&pool, household_id, false).await?;
    sqlx::query("UPDATE role_permissions SET can_write=false WHERE household_id=$1 AND role='owner' AND module='records'")
        .bind(household_id).execute(&mut *tx).await?;
    tx.commit().await?;
    let denied = request(&app, "PUT", &path, Some(&token), Some(schedule_edit)).await?;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(denied).await?,
        json!({"detail":"Permission denied."})
    );
    Ok(())
}

async fn update_schedule(
    app: &Router,
    token: &str,
    path: &str,
    payload: Value,
) -> anyhow::Result<Value> {
    let response = request(app, "PUT", path, Some(token), Some(payload)).await?;
    let status = response.status();
    let body = response_json(response).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    Ok(body)
}

fn schedule_amount(row: &Value, field: &str) -> anyhow::Result<rust_decimal::Decimal> {
    Ok(row[field]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("schedule {field} missing"))?
        .parse()?)
}

#[tokio::test]
async fn extra_principal_edit_regenerates_declining_imported_forecasts_at_current_rate()
-> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL imported forecast contract skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 8).await?;
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
    let token = login(&app).await?;
    let household_id = authenticate(&pool, &token).await?.household.id;
    let loan = create_id(
        &app,
        &token,
        "/api/household/loans",
        json!({
            "name": "Imported declining mortgage", "current_balance": 1000,
            "original_balance": 1200, "monthly_payment": 20, "interest_rate": 0.0693,
            "liability_type": "mortgage", "owner_scope": "self"
        }),
    )
    .await?;
    let completed_id = Uuid::new_v4();
    let pending_ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    let mut tx = tenant::begin(&pool, household_id, false).await?;
    // Preserve legacy imported assumptions until the edit triggers regeneration.
    sqlx::query("INSERT INTO loan_payments (id, household_id, loan_id, payment_date, total_payment, principal_amount, interest_amount, extra_payment, remaining_balance, interest_balance, completed, schedule_order, source_key) VALUES ($1,$2,$3,'2099-01-01',30.0000,20.0000,10.0000,0.0000,1000.0000,9.0000,true,0,$4)")
        .bind(completed_id).bind(household_id).bind(loan)
        .bind(format!("imported:{completed_id}"))
        .execute(&mut *tx).await?;
    for (index, id) in pending_ids.iter().enumerate() {
        let (date, payment, principal, interest, balance) = [
            ("2099-02-01", "20", "15", "5", "985"),
            ("2099-03-01", "10", "8", "2", "977"),
            ("2099-04-01", "1", "0.5", "0.5", "976.5"),
        ][index];
        sqlx::query("INSERT INTO loan_payments (id, household_id, loan_id, payment_date, total_payment, principal_amount, interest_amount, remaining_balance, completed, schedule_order, source_key) VALUES ($1,$2,$3,$4::text::date,$5::text::numeric,$6::text::numeric,$7::text::numeric,$8::text::numeric,false,$9,$10)")
            .bind(id).bind(household_id).bind(loan).bind(date).bind(payment)
            .bind(principal).bind(interest).bind(balance).bind(i32::try_from(index + 1)?)
            .bind(format!("imported:{id}"))
            .execute(&mut *tx).await?;
    }
    tx.commit().await?;

    let completed = json!({
        "id": completed_id, "date": "2099-01-01", "payment": "30.0000",
        "principal": "20.0000", "interest": "10.0000", "extra_principal": "0.0000",
        "outstanding_loan_balance": "1000.0000", "interest_balance": "9.0000",
        "completed": true, "projected": false
    });
    let mut payload = update_payload(None);
    payload["interest_rate"] = json!(0.0693);
    payload["original_balance"] = json!(1200);
    payload["payment_schedule"] = json!([
        completed,
        {"id": pending_ids[0], "date": "2099-02-01", "payment": "20",
         "principal": "15", "interest": "5", "extra_principal": "100",
         "outstanding_loan_balance": "885", "completed": false, "projected": true},
        {"id": pending_ids[1], "date": "2099-03-01", "payment": "10",
         "principal": "8", "interest": "2", "outstanding_loan_balance": "977",
         "completed": false, "projected": true},
        {"id": pending_ids[2], "date": "2099-04-01", "payment": "1",
         "principal": "0.5", "interest": "0.5", "outstanding_loan_balance": "976.5",
         "completed": false, "projected": true}
    ]);
    let path = format!("/api/household/loans/{loan}");
    let updated = update_schedule(&app, &token, &path, payload.clone()).await?;
    let schedule = &updated["details"]["payment_schedule"];
    assert_eq!(schedule[0], completed);
    assert_eq!(updated["current_balance"].as_f64(), Some(1000.0));
    assert_eq!(updated["monthly_payment"].as_f64(), Some(20.0));
    for (index, (interest, principal, balance)) in [
        ("5.78", "14.22", "885.78"),
        ("5.12", "14.88", "870.90"),
        ("5.03", "14.97", "855.93"),
    ]
    .into_iter()
    .enumerate()
    {
        let row = &schedule[index + 1];
        assert_eq!(row["id"], json!(pending_ids[index]));
        assert_eq!(row["completed"], false);
        assert_eq!(schedule_amount(row, "payment")?, "20".parse()?);
        assert_eq!(schedule_amount(row, "interest")?, interest.parse()?);
        assert_eq!(schedule_amount(row, "principal")?, principal.parse()?);
        assert_eq!(
            schedule_amount(row, "outstanding_loan_balance")?,
            balance.parse()?
        );
    }
    assert_eq!(
        schedule_amount(&schedule[1], "extra_principal")?,
        "100".parse()?
    );
    assert_eq!(
        schedule_amount(&schedule[1], "interest_balance")?,
        "10.15".parse()?
    );

    payload["payment_schedule"] = schedule.clone();
    let repeated = update_schedule(&app, &token, &path, payload.clone()).await?;
    assert_eq!(repeated["details"]["payment_schedule"], *schedule);
    assert_eq!(repeated["current_balance"], updated["current_balance"]);

    // Regeneration must not hide invalid inputs or use extra principal for interest.
    for (index, payment) in [(1, "1"), (2, "-1")] {
        let mut invalid = payload.clone();
        invalid["payment_schedule"][index]["payment"] = json!(payment);
        let response = request(&app, "PUT", &path, Some(&token), Some(invalid)).await?;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
    let unchanged = update_schedule(&app, &token, &path, payload).await?;
    assert_eq!(unchanged["details"]["payment_schedule"], *schedule);
    Ok(())
}

#[tokio::test]
async fn completion_toggles_recalculate_forecasts_preserve_precision_and_payment_identity()
-> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL loan completion contract skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 8).await?;
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
    let token = login(&app).await?;
    let create_payload = json!({
        "name": "Precision loan", "current_balance": 10000, "original_balance": 12000,
        "monthly_payment": 300, "interest_rate": 0.12, "liability_type": "loan",
        "owner_scope": "self"
    });
    let loan = create_id(&app, &token, "/api/household/loans", create_payload.clone()).await?;
    let path = format!("/api/household/loans/{loan}");
    let mut payload = update_payload(None);
    payload["monthly_payment"] = json!(300);
    payload["interest_rate"] = json!(0.12);
    payload["payment_schedule"] = json!([
        {
            "date": "2099-01-01", "completed": true,
            "payment": "300.1200000000000000000000001",
            "interest": "80.1100000000000000000000001",
            "principal": "220.0100000000000000000000001",
            "extra_principal": "0.0000000000000000000000001",
            "outstanding_loan_balance": "10000.1234567890123456789",
            "interest_balance": "123.4567890123456789012345678"
        },
        {"date": "2099-02-01", "completed": false},
        {"date": "2099-03-01", "completed": false, "payment": "300"}
    ]);
    let initial = update_schedule(&app, &token, &path, payload.clone()).await?;
    let schedule = &initial["details"]["payment_schedule"];
    let actual = schedule[0].clone();
    assert_eq!(actual["payment"], "300.1200000000000000000000001");
    assert_eq!(actual["principal"], "220.0100000000000000000000001");
    assert_eq!(actual["extra_principal"], "0.0000000000000000000000001");
    assert_eq!(actual["interest_balance"], "123.4567890123456789012345678");
    assert_eq!(
        actual["outstanding_loan_balance"],
        "10000.1234567890123456789"
    );
    assert_eq!(actual["completed"], true);
    assert_eq!(actual["projected"], false);
    let identities: Vec<_> = schedule
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("schedule missing"))?
        .iter()
        .map(|row| row["id"].clone())
        .collect();
    assert_eq!(schedule[1]["completed"], false);
    assert_eq!(
        schedule_amount(&schedule[1], "interest")?,
        "100.00".parse()?
    );

    payload
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("payload missing"))?
        .remove("payment_schedule");
    payload["monthly_payment"] = json!(400);
    payload["interest_rate"] = json!(0.06);
    let edited = update_schedule(&app, &token, &path, payload.clone()).await?;
    let schedule = &edited["details"]["payment_schedule"];
    assert_eq!(schedule[0], actual);
    assert_eq!(edited["current_balance"], initial["current_balance"]);
    assert_eq!(schedule_amount(&schedule[1], "payment")?, "300".parse()?);
    assert_eq!(schedule_amount(&schedule[1], "interest")?, "50.00".parse()?);
    assert_eq!(
        schedule_amount(&schedule[1], "principal")?,
        "250.00".parse()?
    );
    assert_eq!(
        schedule_amount(&schedule[1], "outstanding_loan_balance")?,
        "9750.12".parse()?
    );
    // Pending rows use the next base installment at the updated rate.
    assert_eq!(schedule_amount(&schedule[2], "payment")?, "300".parse()?);
    assert_eq!(schedule_amount(&schedule[2], "interest")?, "48.75".parse()?);
    assert_eq!(
        schedule_amount(&schedule[2], "interest_balance")?,
        "0".parse()?
    );

    let mut completed_schedule = schedule.clone();
    completed_schedule[1]["completed"] = json!(true);
    // The explicit completion flag overrides the legacy projected flag.
    assert_eq!(completed_schedule[1]["projected"], true);
    payload["payment_schedule"] = completed_schedule;
    let completed = update_schedule(&app, &token, &path, payload.clone()).await?;
    assert_eq!(completed["current_balance"], 9750.12);
    let newly_completed = completed["details"]["payment_schedule"][1].clone();
    assert_eq!(newly_completed["completed"], true);
    assert_eq!(newly_completed["projected"], false);

    payload["monthly_payment"] = json!(500);
    payload["interest_rate"] = json!(0.12);
    payload
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("payload missing"))?
        .remove("payment_schedule");
    let changed_rate = update_schedule(&app, &token, &path, payload.clone()).await?;
    let schedule = &changed_rate["details"]["payment_schedule"];
    assert_eq!(schedule[0], actual);
    assert_eq!(schedule[1], newly_completed);
    assert_eq!(
        changed_rate["current_balance"],
        completed["current_balance"]
    );
    assert_eq!(schedule_amount(&schedule[2], "payment")?, "300".parse()?);
    assert_eq!(schedule_amount(&schedule[2], "interest")?, "97.50".parse()?);
    assert_eq!(
        schedule_amount(&schedule[2], "outstanding_loan_balance")?,
        "9547.62".parse()?
    );

    let mut incomplete_schedule = schedule.clone();
    incomplete_schedule[1]["completed"] = json!(false);
    payload["payment_schedule"] = incomplete_schedule;
    let undone = update_schedule(&app, &token, &path, payload.clone()).await?;
    assert_eq!(undone["current_balance"], initial["current_balance"]);
    let schedule = &undone["details"]["payment_schedule"];
    assert_eq!(schedule[0], actual);
    assert_eq!(schedule[1]["completed"], false);
    assert_eq!(schedule[1]["projected"], true);
    assert_eq!(
        schedule_amount(&schedule[1], "interest")?,
        "100.00".parse()?
    );
    assert_eq!(schedule_amount(&schedule[2], "payment")?, "300".parse()?);
    for (row, identity) in schedule
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("schedule missing"))?
        .iter()
        .zip(&identities)
    {
        assert_eq!(&row["id"], identity);
    }

    let other_loan = create_id(&app, &token, "/api/household/loans", create_payload).await?;
    let other_path = format!("/api/household/loans/{other_loan}");
    let mut other_payload = update_payload(None);
    other_payload["name"] = json!("Other precision loan");
    other_payload["payment_schedule"] = json!([
        {"date": "2099-01-01", "completed": true, "outstanding_loan_balance": "9000"}
    ]);
    let other = update_schedule(&app, &token, &other_path, other_payload).await?;
    let mut invalid_schedule = schedule.clone();
    invalid_schedule[0]["id"] = other["details"]["payment_schedule"][0]["id"].clone();
    payload["payment_schedule"] = invalid_schedule;
    payload["name"] = json!("Must roll back");
    let household_id = authenticate(&pool, &token).await?.household.id;
    let mut tx = tenant::begin(&pool, household_id, true).await?;
    let audits_before = sqlx::query_scalar!(
        "SELECT count(*) FROM audit_events WHERE household_id=$1 AND resource_id=$2",
        household_id,
        loan
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let rejected = request(&app, "PUT", &path, Some(&token), Some(payload)).await?;
    assert_eq!(rejected.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(response_json(rejected).await?["detail"].is_string());
    let mut tx = tenant::begin(&pool, household_id, true).await?;
    let audits_after = sqlx::query_scalar!(
        "SELECT count(*) FROM audit_events WHERE household_id=$1 AND resource_id=$2",
        household_id,
        loan
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    assert_eq!(audits_after, audits_before);
    let listed =
        response_json(request(&app, "GET", "/api/household/loans", Some(&token), None).await?)
            .await?;
    let listed = listed
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("loan list missing"))?;
    assert!(
        listed.contains(&undone),
        "invalid payment identity changed target loan"
    );
    assert!(
        listed.contains(&other),
        "invalid payment identity changed source loan"
    );

    let mut sparse_schedule = schedule
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("schedule missing"))?
        .clone();
    sparse_schedule.push(json!({
        "date": "2099-01-15", "completed": true,
        "principal": "0.1234567890123456789"
    }));
    let mut sparse_payload = update_payload(None);
    sparse_payload["monthly_payment"] = json!(500);
    sparse_payload["interest_rate"] = json!(0.12);
    sparse_payload["payment_schedule"] = json!(sparse_schedule);
    let added = update_schedule(&app, &token, &path, sparse_payload.clone()).await?;
    assert_eq!(added["current_balance"], 10000.0);
    let sparse_actual = added["details"]["payment_schedule"][1].clone();
    assert_eq!(sparse_actual["principal"], "0.1234567890123456789");
    assert_eq!(schedule_amount(&sparse_actual, "payment")?, "300".parse()?);
    assert_eq!(schedule_amount(&sparse_actual, "interest")?, "100".parse()?);
    assert_eq!(
        schedule_amount(&sparse_actual, "outstanding_loan_balance")?,
        "10000".parse()?
    );
    assert_eq!(sparse_actual["completed"], true);
    assert_eq!(added["details"]["payment_schedule"][0], actual);
    sparse_payload
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("payload missing"))?
        .remove("payment_schedule");
    sparse_payload["monthly_payment"] = json!(600);
    sparse_payload["interest_rate"] = json!(0.03);
    let changed = update_schedule(&app, &token, &path, sparse_payload).await?;
    assert_eq!(changed["current_balance"], 10000.0);
    assert_eq!(changed["details"]["payment_schedule"][1], sparse_actual);
    assert_eq!(changed["details"]["payment_schedule"][0], actual);
    Ok(())
}

#[tokio::test]
async fn first_completed_payment_undo_and_removal_restore_current_balance_baseline()
-> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL loan baseline contract skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 8).await?;
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
    let loan = create_id(
        &app,
        &token,
        "/api/household/loans",
        json!({
            "name": "Midterm manual loan", "current_balance": 50000,
            "original_balance": 100000, "monthly_payment": 1000,
            "interest_rate": 0, "liability_type": "loan", "owner_scope": "self"
        }),
    )
    .await?;
    let path = format!("/api/household/loans/{loan}");
    let mut payload = update_payload(None);
    payload["current_balance"] = json!(50000);
    payload["monthly_payment"] = json!(1000);
    payload["interest_rate"] = json!(0);
    payload["payment_schedule"] = json!([
        {"date": "2099-01-01", "completed": true, "payment": "1000"}
    ]);
    let completed = update_schedule(&app, &token, &path, payload.clone()).await?;
    assert_eq!(completed["original_balance"], 100000.0);
    assert_eq!(completed["current_balance"], 49000.0);
    let actual = &completed["details"]["payment_schedule"][0];
    assert_eq!(schedule_amount(actual, "principal")?, "1000".parse()?);
    assert_eq!(schedule_amount(actual, "interest")?, "0".parse()?);
    assert_eq!(
        schedule_amount(actual, "outstanding_loan_balance")?,
        "49000".parse()?
    );
    let identity = actual["id"].clone();

    payload["current_balance"] = completed["current_balance"].clone();
    payload["payment_schedule"] = completed["details"]["payment_schedule"].clone();
    payload["payment_schedule"][0]["completed"] = json!(false);
    let undone = update_schedule(&app, &token, &path, payload.clone()).await?;
    assert_eq!(undone["current_balance"], 50000.0);
    assert_eq!(undone["details"]["payment_schedule"][0]["completed"], false);
    assert_eq!(undone["details"]["payment_schedule"][0]["id"], identity);
    assert_eq!(
        schedule_amount(
            &undone["details"]["payment_schedule"][0],
            "outstanding_loan_balance"
        )?,
        "49000".parse()?
    );

    payload["current_balance"] = undone["current_balance"].clone();
    payload["payment_schedule"] = undone["details"]["payment_schedule"].clone();
    payload["payment_schedule"][0]["completed"] = json!(true);
    let completed_again = update_schedule(&app, &token, &path, payload.clone()).await?;
    assert_eq!(completed_again["current_balance"], 49000.0);
    assert_eq!(
        completed_again["details"]["payment_schedule"][0]["id"],
        identity
    );
    payload["current_balance"] = completed_again["current_balance"].clone();
    payload["payment_schedule"] = json!([]);
    let removed = update_schedule(&app, &token, &path, payload).await?;
    assert_eq!(removed["original_balance"], 100000.0);
    assert_eq!(removed["current_balance"], 50000.0);
    assert_eq!(removed["details"]["payment_schedule"], json!([]));
    let listed =
        response_json(request(&app, "GET", "/api/household/loans", Some(&token), None).await?)
            .await?;
    assert_eq!(listed[0], removed);
    Ok(())
}

#[tokio::test]
async fn same_date_completed_checkpoints_keep_the_submitted_order() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL loan ordering contract skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 8).await?;
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
    let loan = create_id(
        &app,
        &token,
        "/api/household/loans",
        json!({
            "name": "Same-date checkpoint loan", "current_balance": 1000,
            "original_balance": 1000, "monthly_payment": 100,
            "interest_rate": 0, "liability_type": "loan", "owner_scope": "self"
        }),
    )
    .await?;
    let path = format!("/api/household/loans/{loan}");
    let mut payload = update_payload(None);
    payload["current_balance"] = json!(1000);
    payload["monthly_payment"] = json!(100);
    payload["interest_rate"] = json!(0);
    payload["payment_schedule"] = json!([
        {"date": "2099-01-01", "completed": true, "outstanding_loan_balance": "800"}
    ]);
    let anchored = update_schedule(&app, &token, &path, payload.clone()).await?;
    assert_eq!(anchored["current_balance"], 800.0);
    let earlier = anchored["details"]["payment_schedule"][0].clone();
    let earlier_id = earlier["id"].clone();

    // A newer same-date checkpoint is explicitly placed before the unchanged
    // record; the last checkpoint in submitted order stays authoritative.
    payload["current_balance"] = json!(800);
    payload["payment_schedule"] = json!([
        json!({
            "date": "2099-01-01", "completed": true,
            "payment": "100", "outstanding_loan_balance": "900"
        }),
        earlier
    ]);
    let reordered = update_schedule(&app, &token, &path, payload.clone()).await?;
    assert_eq!(reordered["current_balance"], 800.0);
    let schedule = &reordered["details"]["payment_schedule"];
    assert_eq!(schedule.as_array().map(Vec::len), Some(2));
    let newer_id = schedule[0]["id"].clone();
    assert_ne!(newer_id, earlier_id);
    assert_eq!(schedule[1]["id"], earlier_id);
    assert_eq!(
        schedule_amount(&schedule[0], "outstanding_loan_balance")?,
        "900".parse()?
    );
    assert_eq!(
        schedule_amount(&schedule[1], "outstanding_loan_balance")?,
        "800".parse()?
    );

    // A header-only recalculation reloads the stored order and must not let the
    // UUID tie-break silently flip which checkpoint wins.
    payload["current_balance"] = json!(800);
    payload
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("payload missing"))?
        .remove("payment_schedule");
    let recalculated = update_schedule(&app, &token, &path, payload).await?;
    assert_eq!(recalculated["current_balance"], 800.0);
    let schedule = &recalculated["details"]["payment_schedule"];
    assert_eq!(schedule[0]["id"], newer_id);
    assert_eq!(schedule[1]["id"], earlier_id);
    Ok(())
}

async fn crate_contributor_session(
    pool: &sqlx::PgPool,
    household_id: Uuid,
) -> anyhow::Result<String> {
    use checkbook_postgres::auth::{generate_opaque_token, hash_opaque_token};
    let user: Uuid =
        sqlx::query_scalar("INSERT INTO users (email,full_name) VALUES ($1,'Spouse') RETURNING id")
            .bind(format!("loan-spouse-{}@example.com", Uuid::new_v4()))
            .fetch_one(pool)
            .await?;
    sqlx::query(
        "INSERT INTO external_identities (user_id,provider,subject) VALUES ($1,'development',$2)",
    )
    .bind(user)
    .bind(format!("loan-spouse-{user}"))
    .execute(pool)
    .await?;
    let token = generate_opaque_token()?;
    let mut tx = tenant::begin(pool, household_id, false).await?;
    sqlx::query("INSERT INTO household_memberships (household_id,user_id,role,relationship_kind) VALUES ($1,$2,'contributor','spouse')")
        .bind(household_id).bind(user).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO sessions (user_id,household_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')")
        .bind(user).bind(household_id).bind(hash_opaque_token(&token)).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(token)
}

#[tokio::test]
async fn initial_schedule_requires_dates_and_never_resurrects_deleted_rows() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; initial loan schedule contract skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 8).await?;
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
    for create_with_dates in [false, true] {
        let name = if create_with_dates {
            "Initial annuity with dates"
        } else {
            "Initial annuity deferred dates"
        };
        let mut create = json!({
            "name": name, "current_balance": 80, "original_balance": 100,
            "monthly_payment": 99, "interest_rate": 0, "start_date": "2027-01-31"
        });
        if create_with_dates {
            create["end_date"] = json!("2027-04-30");
        }
        let id = create_id(&app, &token, "/api/household/loans", create).await?;
        let path = format!("/api/household/loans/{id}");
        if create_with_dates {
            let listed = response_json(
                request(&app, "GET", "/api/household/loans", Some(&token), None).await?,
            )
            .await?;
            let created = listed
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["id"] == id.to_string()))
                .ok_or_else(|| anyhow::anyhow!("created loan missing"))?;
            assert_eq!(
                created["details"]["payment_schedule"]
                    .as_array()
                    .map(Vec::len),
                Some(3)
            );
            assert_eq!(created["current_balance"], 100.0);
            assert_eq!(created["monthly_payment"], 33.33);
        }
        let mut edit = json!({
            "name": name, "original_balance": 100, "interest_rate": 0,
            "start_date": "2027-01-31", "end_date": null, "notes": "",
            "linked_property_id": null
        });
        if !create_with_dates {
            let pending = update_schedule(&app, &token, &path, edit.clone()).await?;
            assert_eq!(pending["details"]["payment_schedule"], json!([]));
            assert_eq!(pending["current_balance"], 80.0);
        }
        edit["end_date"] = json!("2027-04-30");
        let generated = update_schedule(&app, &token, &path, edit.clone()).await?;
        let rows = &generated["details"]["payment_schedule"];
        assert_eq!(rows.as_array().map(Vec::len), Some(3));
        assert_eq!(generated["current_balance"], 100.0);
        assert_eq!(generated["monthly_payment"], 33.33);
        // Updating regenerates even the rounding-adjusted final installment at
        // the fixed next base payment, leaving the unpaid cent in the balance.
        assert_eq!(schedule_amount(&rows[2], "payment")?, "33.33".parse()?);
        assert_eq!(
            schedule_amount(&rows[2], "outstanding_loan_balance")?,
            "0.01".parse()?
        );
        // Existing rows are recalculated, never replaced with a new annuity.
        edit["original_balance"] = json!(999);
        let retained = update_schedule(&app, &token, &path, edit.clone()).await?;
        assert_eq!(retained["current_balance"], 100.0);
        assert_eq!(retained["details"]["payment_schedule"], *rows);
        edit["payment_schedule"] = json!([]);
        let deleted = update_schedule(&app, &token, &path, edit.clone()).await?;
        assert_eq!(deleted["monthly_payment"], 0.0);
        edit.as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("payload missing"))?
            .remove("payment_schedule");
        let still_deleted = update_schedule(&app, &token, &path, edit).await?;
        assert_eq!(still_deleted["details"]["payment_schedule"], json!([]));
        assert_eq!(still_deleted["current_balance"], 100.0);
    }
    Ok(())
}
