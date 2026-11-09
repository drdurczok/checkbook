use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use checkbook_api::{ApiState, router};
use checkbook_postgres::{connect, migrate, tenant};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

async fn response_json(response: axum::response::Response) -> anyhow::Result<Value> {
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024).await?;
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

#[tokio::test]
async fn dashboard_and_analytics_return_complete_normalized_shapes() -> anyhow::Result<()> {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let Some((app, pool)) = test_router().await? else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL contract test skipped");
        return Ok(());
    };
    let email = format!("dashboard-{}@example.com", uuid::Uuid::new_v4());
    let login = request(
        &app,
        "POST",
        "/api/auth/dev-login",
        None,
        Some(json!({
            "email": email,
            "full_name": "Dashboard Owner",
            "relationship_kind": "owner"
        })),
    )
    .await?;
    assert_eq!(login.status(), StatusCode::OK);
    let login = response_json(login).await?;
    let token = login["token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("token missing"))?;
    let household_id = uuid::Uuid::parse_str(
        login["household"]["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("household id missing"))?,
    )?;

    {
        let mut tx = tenant::begin(&pool, household_id, false).await?;
        for (name, kind, account_type, balance) in [
            ("Savings", "asset", "savings", 10_000_i64),
            ("Card", "liability", "debt", 2_000_i64),
        ] {
            let account_id: uuid::Uuid = sqlx::query_scalar(
                "INSERT INTO financial_accounts
                    (household_id, name, account_kind, account_type, currency,
                     owner_scope, source_key)
                 VALUES ($1,$2,$3,$4,'PLN','joint',$5)
                 RETURNING id",
            )
            .bind(household_id)
            .bind(name)
            .bind(kind)
            .bind(account_type)
            .bind(format!("dashboard-test:{name}:{}", uuid::Uuid::new_v4()))
            .fetch_one(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO account_balance_snapshots
                    (household_id, account_id, balance, effective_date,
                     data_source, source_key)
                 VALUES ($1,$2,$3,'2026-06-01','app_manual',$4)",
            )
            .bind(household_id)
            .bind(account_id)
            .bind(balance)
            .bind(format!(
                "dashboard-snapshot:{name}:{}",
                uuid::Uuid::new_v4()
            ))
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
    }

    for (path, body) in [
        (
            "/api/household/income",
            json!({
                "description": "Salary",
                "amount": 4000,
                "entry_date": "2026-06-10",
                "owner_scope": "joint",
                "category_name": "Salary",
                "notes": ""
            }),
        ),
        (
            "/api/household/expenses",
            json!({
                "description": "Food",
                "amount": 1000,
                "entry_date": "2026-06-11",
                "owner_scope": "joint",
                "category_name": "Groceries",
                "notes": ""
            }),
        ),
    ] {
        let response = request(&app, "POST", path, Some(token), Some(body)).await?;
        assert_eq!(response.status(), StatusCode::OK);
    }
    // A day out from "now" so this stays "upcoming" (load_upcoming filters
    // entry_date >= today) regardless of when the test actually runs.
    let upcoming_expense_date = (Utc::now() + Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();
    // Existing planned ledger entries remain visible after the old Planning API retires.
    let mut tx = tenant::begin(&pool, household_id, false).await?;
    sqlx::query(
        "INSERT INTO ledger_entries
            (household_id, direction, status, amount, entry_date, description,
             owner_scope, data_source)
         VALUES ($1, 'expense', 'planned', 500, $2::text::date, 'Future expense',
                 'joint', 'app_manual')",
    )
    .bind(household_id)
    .bind(upcoming_expense_date)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let overview = request(&app, "GET", "/api/dashboard/overview", Some(token), None).await?;
    assert_eq!(overview.status(), StatusCode::OK);
    let overview = response_json(overview).await?;
    assert_eq!(overview["metrics"][0]["label"], "Net worth");
    assert_eq!(overview["metrics"][0]["value"], 8000.0);
    assert_eq!(overview["metrics"][1]["value"], 3000.0);
    assert!(overview["net_worth_components"].is_array());
    assert!(overview["cash_flow_components"].is_array());
    assert_eq!(overview["income_breakdown"][0]["label"], "Salary");
    assert_eq!(overview["expense_breakdown"][0]["label"], "Groceries");
    assert_eq!(overview["upcoming_planned_expenses"][0]["amount"], 500.0);
    assert!(overview["recent_activity"].is_array());
    assert_eq!(overview["last_successful_import"], Value::Null);

    let month_path = "/api/household/net-worth/months/2026-01";
    let payload = json!({"completed": true, "components": [
        {"group_key": "savings", "label": " Cash ", "value": 123.45},
        {"group_key": "debt", "label": "Loan", "value": 20}
    ]});
    let saved = request(&app, "PUT", month_path, Some(token), Some(payload.clone())).await?;
    assert_eq!(saved.status(), StatusCode::OK);
    let saved = response_json(saved).await?;
    assert_eq!(saved["completed"], true);
    assert_eq!(saved["total"], 103.45);
    assert_eq!(saved["savings"]["components"]["Cash"], 123.45);
    let mut changed = payload.clone();
    changed["components"][0]["value"] = json!(124);
    let frozen = request(&app, "PUT", month_path, Some(token), Some(changed.clone())).await?;
    assert_eq!(frozen.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(response_json(frozen).await?["detail"].is_string());
    changed["completed"] = json!(false);
    let reopened = request(&app, "PUT", month_path, Some(token), Some(changed)).await?;
    assert_eq!(reopened.status(), StatusCode::OK);
    assert_eq!(response_json(reopened).await?["completed"], false);
    for invalid_path in [
        "/api/household/net-worth/months/2026-1",
        "/api/household/net-worth/months/invalid",
    ] {
        let invalid = request(
            &app,
            "PUT",
            invalid_path,
            Some(token),
            Some(payload.clone()),
        )
        .await?;
        assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
    let mut invalid_payload = payload.clone();
    invalid_payload["components"][1]["value"] = json!(-1);
    let invalid = request(&app, "PUT", month_path, Some(token), Some(invalid_payload)).await?;
    assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let analytics = request(&app, "GET", "/api/dashboard/analytics", Some(token), None).await?;
    assert_eq!(analytics.status(), StatusCode::OK);
    let analytics = response_json(analytics).await?;
    for key in [
        "netWorth",
        "cashFlow",
        "expenseBreakdown",
        "utilities",
        "savingsAllocation",
        "projection",
    ] {
        assert!(analytics["charts"][key].is_array(), "missing chart {key}");
    }
    assert_eq!(
        analytics["owner_scope_options"],
        json!(["all", "self", "spouse", "joint"])
    );
    Ok(())
}

#[tokio::test]
async fn completed_manual_month_keeps_live_scoped_sources_without_snapshot_duplicates()
-> anyhow::Result<()> {
    let Some((app, pool)) = test_router().await? else {
        eprintln!("TEST_DATABASE_URL is not set; automatic net worth regression skipped");
        return Ok(());
    };
    let login = response_json(
        request(
            &app,
            "POST",
            "/api/auth/dev-login",
            None,
            Some(json!({
                "email": format!("automatic-nw-{}@example.com", uuid::Uuid::new_v4()),
                "full_name": "Automatic Owner", "relationship_kind": "owner"
            })),
        )
        .await?,
    )
    .await?;
    let token = login["token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("token missing"))?;
    let household = uuid::Uuid::parse_str(
        login["household"]["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("household missing"))?,
    )?;
    let property_id;
    let loan_id;
    {
        let mut tx = tenant::begin(&pool, household, false).await?;
        let account: uuid::Uuid = sqlx::query_scalar("INSERT INTO financial_accounts (household_id,name,account_kind,account_type,owner_scope,source_key) VALUES ($1,'Home','asset','housing','joint','wealth:housing') RETURNING id")
            .bind(household).fetch_one(&mut *tx).await?;
        property_id = sqlx::query_scalar::<_, uuid::Uuid>("INSERT INTO properties (household_id,name,valuation,valuation_date,started_on,status,data_source,account_id,depreciation_enabled,depreciation_rate,source_key) VALUES ($1,'Home',1000,'2026-01-15','2026-01-01','active','bulk_load',$2,true,-0.1,'import:home') RETURNING id")
            .bind(household).bind(account).fetch_one(&mut *tx).await?;
        let loan_account: uuid::Uuid = sqlx::query_scalar("INSERT INTO financial_accounts (household_id,name,account_kind,account_type,owner_scope,source_key) VALUES ($1,'Mortgage','liability','loan','joint','import:mortgage-account') RETURNING id")
            .bind(household).fetch_one(&mut *tx).await?;
        loan_id = sqlx::query_scalar::<_, uuid::Uuid>("INSERT INTO loans (household_id,account_id,name,liability_type,owner_scope,current_balance,original_balance,schedule_opening_balance,monthly_payment,interest_rate,start_date,source_key) VALUES ($1,$2,'Mortgage','mortgage','joint',400,500,500,100,0,'2026-01-01','import:mortgage') RETURNING id")
            .bind(household).bind(loan_account).fetch_one(&mut *tx).await?;
        sqlx::query("INSERT INTO loan_payments (household_id,loan_id,payment_date,total_payment,principal_amount,remaining_balance,completed,source_key) VALUES ($1,$2,'2026-02-10',100,100,400,true,'import:payment')")
            .bind(household).bind(loan_id).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO loan_payments (household_id,loan_id,payment_date,total_payment,principal_amount,remaining_balance,completed,source_key) VALUES ($1,$2,'2026-03-10',25,25,NULL,true,'import:principal-only')")
            .bind(household).bind(loan_id).execute(&mut *tx).await?;
        let debt_account: uuid::Uuid = sqlx::query_scalar("INSERT INTO financial_accounts (household_id,name,account_kind,account_type,owner_scope,source_key) VALUES ($1,'Debt aggregate','liability','debt','joint','wealth:debt') RETURNING id")
            .bind(household).fetch_one(&mut *tx).await?;
        for id in [account, loan_account, debt_account] {
            sqlx::query("INSERT INTO account_balance_snapshots (household_id,account_id,balance,effective_date,data_source,source_key) VALUES ($1,$2,99999,'2026-02-01','bulk_load',$3)")
                .bind(household).bind(id).bind(format!("import:stale:{id}")).execute(&mut *tx).await?;
        }
        tx.commit().await?;
    }
    let uncurated = response_json(
        request(
            &app,
            "GET",
            "/api/dashboard/overview?start_date=2026-03-01&end_date=2026-03-31",
            Some(token),
            None,
        )
        .await?,
    )
    .await?;
    let march = &uncurated["net_worth_components"][0];
    assert_eq!(march["non_liquid_assets"]["components"], json!({}));
    assert_eq!(march["debt"]["components"], json!({}));
    assert_eq!(march["total"], json!(435.0));
    let payload = json!({"completed":true,"components":[{"group_key":"savings","label":"Manual","value":123}]});
    let path = "/api/household/net-worth/months/2026-02";
    let saved = request(&app, "PUT", path, Some(token), Some(payload.clone())).await?;
    assert_eq!(saved.status(), StatusCode::OK);
    let saved = response_json(saved).await?;
    assert_eq!(
        saved["non_liquid_assets"]["automatic_components"]["Home"],
        json!(900.0)
    );
    assert_eq!(
        saved["debt"]["automatic_components"]["Mortgage"],
        json!(400.0)
    );
    assert_eq!(saved["total"], json!(623.0));
    let query = "/api/dashboard/overview?start_date=2026-02-15&end_date=2026-02-28";
    let overview = response_json(request(&app, "GET", query, Some(token), None).await?).await?;
    let rows = overview["net_worth_components"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("rows missing: {overview}"))?;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["debt"]["components"], json!({}));
    assert_eq!(rows[0]["non_liquid_assets"]["components"], json!({}));
    {
        let mut tx = tenant::begin(&pool, household, false).await?;
        sqlx::query("UPDATE properties SET valuation = 2000 WHERE household_id = $1 AND id = $2")
            .bind(household)
            .bind(property_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE loan_payments SET remaining_balance = 0, principal_amount = 500, total_payment = 500 WHERE household_id = $1 AND loan_id = $2")
            .bind(household).bind(loan_id).execute(&mut *tx).await?;
        sqlx::query("UPDATE loans SET current_balance = 0 WHERE household_id = $1 AND id = $2")
            .bind(household)
            .bind(loan_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    let overview = response_json(request(&app, "GET", query, Some(token), None).await?).await?;
    let row = &overview["net_worth_components"][0];
    assert_eq!(row["completed"], true);
    assert_eq!(row["savings"]["components"], json!({"Manual":123.0}));
    assert_eq!(
        row["non_liquid_assets"]["automatic_components"]["Home"],
        json!(1800.0)
    );
    assert_eq!(row["debt"]["automatic_components"], json!({}));
    assert_eq!(row["total"], json!(1923.0));
    let repeated = request(&app, "PUT", path, Some(token), Some(payload.clone())).await?;
    assert_eq!(repeated.status(), StatusCode::OK);
    let mut changed = payload;
    changed["components"][0]["value"] = json!(124);
    assert_eq!(
        request(&app, "PUT", path, Some(token), Some(changed))
            .await?
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut foreign = tenant::begin(&pool, uuid::Uuid::new_v4(), true).await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM properties WHERE id = $1")
        .bind(property_id)
        .fetch_one(&mut *foreign)
        .await?;
    assert_eq!(count, 0);
    foreign.commit().await?;
    let scoped = checkbook_postgres::dashboard::load_overview_data(
        &pool,
        household,
        &["self".into()],
        Default::default(),
        chrono::NaiveDate::parse_from_str("2026-03-01", "%Y-%m-%d")?,
    )
    .await?;
    assert!(scoped.automatic_account_points.is_empty());
    assert!(scoped.net_worth_records.is_empty());
    Ok(())
}

#[tokio::test]
async fn curated_month_past_today_pulls_automatic_debt_and_fixed_assets() -> anyhow::Result<()> {
    let Some((app, pool)) = test_router().await? else {
        eprintln!("TEST_DATABASE_URL is not set; future net worth month regression skipped");
        return Ok(());
    };
    let login = response_json(
        request(
            &app,
            "POST",
            "/api/auth/dev-login",
            None,
            Some(json!({
                "email": format!("future-nw-{}@example.com", uuid::Uuid::new_v4()),
                "full_name": "Future Owner", "relationship_kind": "owner"
            })),
        )
        .await?,
    )
    .await?;
    let token = login["token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("token missing"))?;
    let household = uuid::Uuid::parse_str(
        login["household"]["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("household missing"))?,
    )?;
    {
        let mut tx = tenant::begin(&pool, household, false).await?;
        let account: uuid::Uuid = sqlx::query_scalar("INSERT INTO financial_accounts (household_id,name,account_kind,account_type,owner_scope,source_key) VALUES ($1,'Home','asset','housing','joint','wealth:housing') RETURNING id")
            .bind(household).fetch_one(&mut *tx).await?;
        sqlx::query("INSERT INTO properties (household_id,name,valuation,valuation_date,started_on,status,data_source,account_id,depreciation_enabled,depreciation_rate,source_key) VALUES ($1,'Home',1000,'2026-01-15','2026-01-01','active','bulk_load',$2,false,0,'import:home')")
            .bind(household).bind(account).execute(&mut *tx).await?;
        let loan_account: uuid::Uuid = sqlx::query_scalar("INSERT INTO financial_accounts (household_id,name,account_kind,account_type,owner_scope,source_key) VALUES ($1,'Mortgage','liability','loan','joint','import:mortgage-account') RETURNING id")
            .bind(household).fetch_one(&mut *tx).await?;
        let loan: uuid::Uuid = sqlx::query_scalar("INSERT INTO loans (household_id,account_id,name,liability_type,owner_scope,current_balance,original_balance,schedule_opening_balance,monthly_payment,interest_rate,start_date,source_key) VALUES ($1,$2,'Mortgage','mortgage','joint',400,500,500,100,0,'2026-01-01','import:mortgage') RETURNING id")
            .bind(household).bind(loan_account).fetch_one(&mut *tx).await?;
        sqlx::query("INSERT INTO loan_payments (household_id,loan_id,payment_date,total_payment,principal_amount,remaining_balance,completed,source_key) VALUES ($1,$2,'2026-02-10',100,100,400,true,'import:payment')")
            .bind(household).bind(loan).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    // A month well past today: saving it must still return the automatic
    // property and loan values, and the overview must list the curated row.
    let period = chrono::Utc::now()
        .date_naive()
        .checked_add_months(chrono::Months::new(8))
        .ok_or_else(|| anyhow::anyhow!("future month out of range"))?
        .format("%Y-%m")
        .to_string();
    let saved = response_json(
        request(
            &app,
            "PUT",
            &format!("/api/household/net-worth/months/{period}"),
            Some(token),
            Some(json!({"completed":false,"components":[
                {"group_key":"savings","label":"Manual","value":123}
            ]})),
        )
        .await?,
    )
    .await?;
    assert_eq!(
        saved["non_liquid_assets"]["automatic_components"]["Home"],
        json!(1000.0)
    );
    assert_eq!(
        saved["debt"]["automatic_components"]["Mortgage"],
        json!(400.0)
    );
    assert_eq!(saved["total"], json!(723.0));
    let overview =
        response_json(request(&app, "GET", "/api/dashboard/overview", Some(token), None).await?)
            .await?;
    let row = overview["net_worth_components"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("rows missing: {overview}"))?
        .iter()
        .find(|row| row["period"] == json!(period))
        .ok_or_else(|| anyhow::anyhow!("curated future month {period} missing from overview"))?;
    assert_eq!(row["completed"], json!(false));
    assert_eq!(
        row["non_liquid_assets"]["automatic_components"]["Home"],
        json!(1000.0)
    );
    assert_eq!(
        row["debt"]["automatic_components"]["Mortgage"],
        json!(400.0)
    );
    assert_eq!(row["total"], json!(723.0));
    Ok(())
}
