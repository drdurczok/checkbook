use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use checkbook_api::{ApiState, router};
use checkbook_postgres::{auth::create_development_session, connect, tenant};
use serde_json::Value;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn future_loan_schedules_only_extend_their_own_average_window() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; expense average API test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    let context = create_development_session(
        &pool,
        &format!("expense-average-{}@example.com", Uuid::new_v4()),
        "Expense Owner",
        "owner",
        24,
    )
    .await?;
    let token = context
        .token
        .ok_or_else(|| anyhow::anyhow!("session token missing"))?;
    let household = context.household.id;
    let mut tx = tenant::begin(&pool, household, false).await?;
    let groceries: Uuid = sqlx::query_scalar(
        "INSERT INTO categories (household_id, kind, name, normalized_name)
         VALUES ($1, 'expense', 'Groceries', 'groceries') RETURNING id",
    )
    .bind(household)
    .fetch_one(&mut *tx)
    .await?;
    let activity: Uuid = sqlx::query_scalar(
        "INSERT INTO categories (household_id, kind, name, normalized_name)
         VALUES ($1, 'expense', 'Other activity', 'other activity') RETURNING id",
    )
    .bind(household)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO ledger_entries (household_id, direction, status, amount, entry_date,
            description, owner_scope, category_id, data_source, source_key)
         VALUES ($1, 'expense', 'actual', 1200, '2020-01-15', 'Groceries', 'self', $2, 'app_manual', 'test:actual:1'),
                ($1, 'expense', 'actual', 12, '2020-12-15', 'Other', 'self', $3, 'app_manual', 'test:actual:2')",
    )
    .bind(household)
    .bind(groceries)
    .bind(activity)
    .execute(&mut *tx)
    .await?;
    let account: Uuid = sqlx::query_scalar(
        "INSERT INTO financial_accounts (household_id, name, account_kind, account_type, owner_scope)
         VALUES ($1, 'Loan account', 'liability', 'loan', 'self') RETURNING id",
    )
    .bind(household)
    .fetch_one(&mut *tx)
    .await?;
    let loan: Uuid = sqlx::query_scalar(
        "INSERT INTO loans (household_id, account_id, name, liability_type, owner_scope,
            original_balance, current_balance, monthly_payment)
         VALUES ($1, $2, 'Future mortgage', 'mortgage', 'self', 200, 200, 100) RETURNING id",
    )
    .bind(household)
    .bind(account)
    .fetch_one(&mut *tx)
    .await?;
    let loan_category: Uuid = sqlx::query_scalar(
        "SELECT id FROM categories WHERE household_id = $1 AND linked_loan_id = $2",
    )
    .bind(household)
    .bind(loan)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO loan_payments (household_id, loan_id, payment_date, total_payment,
            principal_amount, interest_amount, source_key)
         VALUES ($1, $2, '2030-01-15', 100, 100, 0, 'test:payment:1'),
                ($1, $2, '2030-02-15', 100, 100, 0, 'test:payment:2')",
    )
    .bind(household)
    .bind(loan)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
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
    for (path, expected_groceries, expected_loan) in [
        ("/api/household/expenses/board", 100.0, 100.0),
        (
            "/api/household/expenses/board?start_date=2020-01-01&end_date=2020-01-31",
            1200.0,
            0.0,
        ),
        (
            "/api/household/expenses/board?start_date=2030-01-01&end_date=2030-02-28",
            0.0,
            100.0,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4 * 1024 * 1024).await?)?;
        let categories = body["categories"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("categories missing"))?;
        for (id, expected) in [
            (groceries, expected_groceries),
            (loan_category, expected_loan),
        ] {
            let category = categories
                .iter()
                .find(|row| row["id"] == id.to_string())
                .ok_or_else(|| anyhow::anyhow!("category missing"))?;
            assert_eq!(
                category["monthly_average"].as_f64(),
                Some(expected),
                "{path}: {category}"
            );
        }
    }
    Ok(())
}
