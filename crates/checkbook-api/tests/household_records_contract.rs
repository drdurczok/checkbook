use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use checkbook_api::{ApiState, router};
use checkbook_postgres::{auth::authenticate, connect, migrate, tenant};
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
            "email": format!("records-{}@example.com", uuid::Uuid::new_v4()),
            "full_name": "Records Owner",
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
async fn household_settings_groups_invitations_and_records_match_the_frontend_contract()
-> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
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
    let token = login(&app).await?;

    let categories = request(&app, "GET", "/api/household/categories", Some(&token), None).await?;
    assert_eq!(categories.status(), StatusCode::OK);
    assert!(
        response_json(categories)
            .await?
            .as_array()
            .is_some_and(|rows| !rows.is_empty())
    );

    let group_payload = json!({
        "kind": "contract",
        "name": "Internet contract",
        "group_type": "telecom",
        "started_on": "2026-01-01",
        "ended_on": null,
        "notes": "Fiber",
        "metadata_payload": {"account": "ABC"},
        "tracked_fields": [{
            "key": "internet",
            "label": "Internet",
            "kind": "cost",
            "unit": ""
        }],
        "sort_order": 2
    });
    // Standalone contract groups can no longer be created; utilities are
    // property-owned contracts now.
    let group = request(
        &app,
        "POST",
        "/api/household/groups",
        Some(&token),
        Some(group_payload),
    )
    .await?;
    assert_eq!(group.status(), StatusCode::UNPROCESSABLE_ENTITY);

    // Legacy groups remain readable and editable. Seed one directly so the
    // retained group flows stay covered.
    let context = authenticate(&pool, &token).await?;
    let household_id = context.household.id;
    let mut tx = checkbook_postgres::tenant::begin(&pool, household_id, false).await?;
    let group_id = sqlx::query_scalar!(
        r#"INSERT INTO entry_groups (household_id, kind, name, group_type, started_on, notes, metadata_payload, tracked_fields, sort_order)
           VALUES ($1, 'contract', 'Internet contract', 'telecom', '2026-01-01', 'Fiber', '{"account":"ABC"}',
                   '[{"key":"internet","label":"Internet","kind":"cost","unit":""}]'::jsonb, 2)
           RETURNING id"#,
        household_id
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    let updated = request(
        &app,
        "PUT",
        &format!("/api/household/groups/{group_id}"),
        Some(&token),
        Some(json!({
            "kind": "contract",
            "name": "Updated internet",
            "group_type": "telecom",
            "started_on": "2026-01-01",
            "ended_on": null,
            "notes": "Updated",
            "metadata_payload": {},
            "tracked_fields": [],
            "sort_order": 3
        })),
    )
    .await?;
    assert_eq!(updated.status(), StatusCode::OK);
    assert_eq!(response_json(updated).await?["name"], "Updated internet");
    let groups = request(
        &app,
        "GET",
        "/api/household/groups?kind=contract&include_historic=true",
        Some(&token),
        None,
    )
    .await?;
    assert_eq!(groups.status(), StatusCode::OK);
    let groups = response_json(groups).await?;
    assert_eq!(groups[0]["id"], group_id.to_string());

    let invitation = request(
        &app,
        "POST",
        "/api/household/invitations",
        Some(&token),
        Some(json!({
            "email": "spouse@example.com",
            "role": "contributor",
            "relationship_kind": "spouse"
        })),
    )
    .await?;
    assert_eq!(invitation.status(), StatusCode::OK);
    let invitation = response_json(invitation).await?;
    assert!(
        invitation["token"]
            .as_str()
            .is_some_and(|token| token.len() >= 64)
    );
    let duplicate_spouse_slot = request(
        &app,
        "POST",
        "/api/household/invitations",
        Some(&token),
        Some(json!({
            "email": "other-spouse@example.com",
            "role": "contributor",
            "relationship_kind": "spouse"
        })),
    )
    .await?;
    assert_eq!(duplicate_spouse_slot.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(duplicate_spouse_slot).await?["detail"],
        "The spouse household slot is already occupied or invited."
    );
    let duplicate_owner_slot = request(
        &app,
        "POST",
        "/api/household/invitations",
        Some(&token),
        Some(json!({
            "email": "other-owner@example.com",
            "role": "owner",
            "relationship_kind": "owner"
        })),
    )
    .await?;
    assert_eq!(duplicate_owner_slot.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(duplicate_owner_slot).await?["detail"],
        "The owner household slot is already occupied or invited."
    );
    let invitations = request(
        &app,
        "GET",
        "/api/household/invitations",
        Some(&token),
        None,
    )
    .await?;
    assert_eq!(invitations.status(), StatusCode::OK);
    assert_eq!(response_json(invitations).await?[0]["token"], "");

    let settings = request(&app, "GET", "/api/settings", Some(&token), None).await?;
    assert_eq!(settings.status(), StatusCode::OK);
    let settings = response_json(settings).await?;
    assert_eq!(settings["projection_horizon_months"], 18);
    let updated_settings = request(
        &app,
        "PUT",
        "/api/settings",
        Some(&token),
        Some(json!({
            "privacy_mode": "transparent",
            "allow_cross_member_visibility": true,
            "projection_baseline_window_months": 9,
            "projection_horizon_months": 24,
            "savings_allocation_strategy": "proportional",
            "role_permissions": {
                "records": {
                    "contributor": {"delete": true}
                }
            }
        })),
    )
    .await?;
    assert_eq!(updated_settings.status(), StatusCode::OK);
    let updated_settings = response_json(updated_settings).await?;
    assert_eq!(updated_settings["projection_horizon_months"], 24);
    assert_eq!(updated_settings["allow_cross_member_visibility"], true);
    assert_eq!(
        updated_settings["role_permissions"]["records"]["contributor"]["delete"],
        true
    );
    let context = authenticate(&pool, &token).await?;
    let mut transaction = tenant::begin(&pool, context.household.id, true).await?;
    let permission_audited: bool = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM audit_events
            WHERE household_id = $1
              AND event_type = 'role_permissions_updated'
              AND actor_user_id = $2
         )",
    )
    .bind(context.household.id)
    .bind(context.user.id)
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    assert!(permission_audited);

    let source_payload = json!({
        "name": "Employment",
        "source_type": "employment",
        "owner_scope": "self",
        "started_on": "2026-01-01",
        "ended_on": null,
        "notes": "Primary",
        "lines": [{
            "label": "Base",
            "amount": 10000,
            "frequency": "monthly",
            "owner_scope": "self",
            "category": "Salary",
            "started_on": "2026-01-01",
            "ended_on": null,
            "notes": "",
            "fields": [{"label": "Grade", "value": "Senior"}]
        }],
        "fields": [{"label": "Employer", "value": "Example"}],
        "milestones": [{"label": "Started", "date": "2026-01-01"}],
        "sort_order": 1
    });
    let source = request(
        &app,
        "POST",
        "/api/household/income-sources",
        Some(&token),
        Some(source_payload),
    )
    .await?;
    assert_eq!(source.status(), StatusCode::OK);
    let source = response_json(source).await?;
    let source_id = source["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("source id missing"))?;
    assert_eq!(source["annual_total"], 120000.0);
    assert_eq!(source["line_count"], 1);

    let source_updated = request(
        &app,
        "PUT",
        &format!("/api/household/income-sources/{source_id}"),
        Some(&token),
        Some(json!({
            "name": "Updated employment",
            "source_type": "employment",
            "owner_scope": "self",
            "started_on": "2026-01-01",
            "ended_on": null,
            "notes": "",
            "lines": [],
            "fields": [],
            "milestones": [],
            "sort_order": 2
        })),
    )
    .await?;
    assert_eq!(source_updated.status(), StatusCode::OK);
    assert_eq!(
        response_json(source_updated).await?["name"],
        "Updated employment"
    );

    let entry = request(
        &app,
        "POST",
        &format!("/api/household/income-sources/{source_id}/entries"),
        Some(&token),
        Some(json!({
            "description": "June salary",
            "amount": 8000.25,
            "entry_date": "2026-06-01",
            "owner_scope": "self",
            "notes": "Paid",
            "extra_payload": {"gross": "10000.00"}
        })),
    )
    .await?;
    assert_eq!(entry.status(), StatusCode::OK);
    let entry = response_json(entry).await?;
    let entry_id = entry["entries"][0]["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("entry id missing"))?;
    assert_eq!(entry["actual_total"], 8000.25);
    let entry_updated = request(
        &app,
        "PUT",
        &format!("/api/household/income-sources/{source_id}/entries/{entry_id}"),
        Some(&token),
        Some(json!({
            "description": "Corrected salary",
            "amount": 8100.50,
            "entry_date": "2026-06-01",
            "owner_scope": "self",
            "notes": "",
            "extra_payload": {}
        })),
    )
    .await?;
    assert_eq!(entry_updated.status(), StatusCode::OK);
    assert_eq!(
        response_json(entry_updated).await?["entries"][0]["amount"],
        8100.5
    );

    for (path, payload, record_type) in [
        (
            "/api/household/expenses",
            json!({
                "description": "Food",
                "amount": 123.45,
                "entry_date": "2026-06-02",
                "owner_scope": "joint",
                "category_name": "Groceries",
                "subcategory_name": "Food",
                "notes": ""
            }),
            "expense",
        ),
        (
            "/api/household/income",
            json!({
                "description": "Bonus",
                "amount": 500,
                "entry_date": "2026-06-03",
                "owner_scope": "self",
                "category_name": "Bonus",
                "subcategory_name": null,
                "income_source_id": source_id,
                "notes": ""
            }),
            "income",
        ),
    ] {
        let created = request(&app, "POST", path, Some(&token), Some(payload)).await?;
        assert_eq!(created.status(), StatusCode::OK);
        assert_eq!(response_json(created).await?["record_type"], record_type);
    }
    let sources = request(
        &app,
        "GET",
        "/api/household/income-sources",
        Some(&token),
        None,
    )
    .await?;
    assert_eq!(sources.status(), StatusCode::OK);
    assert_eq!(response_json(sources).await?[0]["actual_total"], 8600.5);

    let deleted_source = request(
        &app,
        "DELETE",
        &format!("/api/household/income-sources/{source_id}"),
        Some(&token),
        None,
    )
    .await?;
    assert_eq!(deleted_source.status(), StatusCode::OK);
    let deleted_group = request(
        &app,
        "DELETE",
        &format!("/api/household/groups/{group_id}"),
        Some(&token),
        None,
    )
    .await?;
    assert_eq!(deleted_group.status(), StatusCode::OK);
    Ok(())
}
