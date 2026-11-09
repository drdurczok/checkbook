use checkbook_postgres::{
    auth::create_development_session,
    connect,
    dashboard::{DashboardFilter, load_overview_data},
    tenant,
};
use chrono::NaiveDate;
use rust_decimal_macros::dec;
use uuid::Uuid;

fn date(month: u32) -> anyhow::Result<NaiveDate> {
    NaiveDate::from_ymd_opt(2026, month, 1).ok_or_else(|| anyhow::anyhow!("invalid test date"))
}

#[tokio::test]
async fn overview_loan_history_ignores_non_amortizing_projections() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; dashboard loan history test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let context = create_development_session(
        &pool,
        &format!("dashboard-loan-history-{}@example.com", Uuid::new_v4()),
        "Loan History Owner",
        "owner",
        24,
    )
    .await?;
    let household = context.household.id;
    let mut tx = tenant::begin(&pool, household, false).await?;
    let account: Uuid = sqlx::query_scalar(
        "INSERT INTO financial_accounts (household_id, name, account_kind, account_type, owner_scope)
         VALUES ($1, 'History loan', 'liability', 'loan', 'joint') RETURNING id",
    )
    .bind(household)
    .fetch_one(&mut *tx)
    .await?;
    let loan: Uuid = sqlx::query_scalar(
        "INSERT INTO loans (household_id, account_id, name, liability_type, owner_scope,
             original_balance, current_balance, interest_rate, monthly_payment, start_date)
         VALUES ($1, $2, 'History loan', 'loan', 'joint', 1000, 800, 0.12, 1, $3) RETURNING id",
    )
    .bind(household)
    .bind(account)
    .bind(date(1)?)
    .fetch_one(&mut *tx)
    .await?;
    // A completed checkpoint takes precedence over its principal amount. The
    // later incomplete payment cannot cover interest, but is not history.
    for (month, completed, payment, principal, extra, remaining) in [
        (2, true, dec!(150), dec!(140), dec!(0), Some(dec!(850))),
        (3, true, dec!(50), dec!(40), dec!(10), None),
        (4, false, dec!(1), dec!(0), dec!(0), None),
    ] {
        sqlx::query(
            "INSERT INTO loan_payments (household_id, loan_id, payment_date, total_payment,
                 principal_amount, interest_amount, extra_payment, remaining_balance, completed, source_key)
             VALUES ($1, $2, $3, $4, $5, 10, $6, $7, $8, $9)",
        )
        .bind(household)
        .bind(loan)
        .bind(date(month)?)
        .bind(payment)
        .bind(principal)
        .bind(extra)
        .bind(remaining)
        .bind(completed)
        .bind(format!("history:{loan}:{month}"))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    let data = load_overview_data(
        &pool,
        household,
        &["joint".to_owned()],
        DashboardFilter::default(),
        date(4)?,
    )
    .await?;
    let balances: Vec<_> = data
        .automatic_account_points
        .iter()
        .filter(|point| point.name == "History loan")
        .map(|point| (point.period, point.balance))
        .collect();
    assert_eq!(
        balances,
        vec![
            (date(1)?, dec!(1000)),
            (date(2)?, dec!(850)),
            (date(3)?, dec!(800)),
            (date(4)?, dec!(800)),
        ]
    );
    Ok(())
}
