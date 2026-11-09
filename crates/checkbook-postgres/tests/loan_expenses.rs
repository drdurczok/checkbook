use checkbook_postgres::{
    auth::create_development_session,
    connect,
    expenses::{load_board, load_category_detail},
    payday,
    planning::materialize_household,
    tenant,
};
use chrono::NaiveDate;
use rust_decimal_macros::dec;
use uuid::Uuid;

fn date(month: u32, day: u32) -> anyhow::Result<NaiveDate> {
    NaiveDate::from_ymd_opt(2026, month, day).ok_or_else(|| anyhow::anyhow!("invalid test date"))
}

#[tokio::test]
async fn loan_schedule_is_grouped_exactly_once_and_respects_scope_and_household()
-> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; loan expense integration test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let context = create_development_session(
        &pool,
        &format!("loan-expenses-{}@example.com", Uuid::new_v4()),
        "Loan Owner",
        "owner",
        24,
    )
    .await?;
    let household = context.household.id;
    let mut tx = tenant::begin(&pool, household, false).await?;
    let property: Uuid = sqlx::query_scalar(
        "INSERT INTO properties (household_id, name, valuation_date, status, data_source)
         VALUES ($1, 'Loan property', $2, 'active', 'app_manual') RETURNING id",
    )
    .bind(household)
    .bind(date(5, 1)?)
    .fetch_one(&mut *tx)
    .await?;
    let account: Uuid = sqlx::query_scalar(
        "INSERT INTO financial_accounts (household_id, name, account_kind, account_type, owner_scope)
         VALUES ($1, 'Test loan account', 'liability', 'loan', 'joint') RETURNING id",
    ).bind(household).fetch_one(&mut *tx).await?;
    let loan: Uuid = sqlx::query_scalar(
        "INSERT INTO loans (household_id, account_id, name, liability_type, owner_scope, original_balance,
            current_balance, interest_rate, monthly_payment, start_date, end_date, linked_property_id)
         VALUES ($1, $2, 'Test loan', 'loan', 'joint', 1000, 250, 0, 100, $3, $4, $5) RETURNING id",
    ).bind(household).bind(account).bind(date(5, 1)?).bind(date(8, 31)?).bind(property).fetch_one(&mut *tx).await?;
    let category: Uuid = sqlx::query_scalar(
        "SELECT id FROM categories WHERE household_id = $1 AND linked_loan_id = $2 AND parent_id IS NULL",
    ).bind(household).bind(loan).fetch_one(&mut *tx).await?;
    for (month, payment, extra) in [(5, dec!(80.01), dec!(0.02)), (6, dec!(110), dec!(5))] {
        sqlx::query(
            "INSERT INTO loan_payments (household_id, loan_id, payment_date, total_payment,
                 principal_amount, interest_amount, extra_payment, source_key)
             VALUES ($1, $2, $3, $4, $4, 0, $5, $6)",
        )
        .bind(household)
        .bind(loan)
        .bind(date(month, 15)?)
        .bind(payment)
        .bind(extra)
        .bind(format!("test:{loan}:{month}"))
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "INSERT INTO loan_overpayment_plans (household_id, loan_id, period, amount)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(household)
    .bind(loan)
    .bind(date(7, 1)?)
    .bind(dec!(10.01))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    materialize_household(&pool, household, date(6, 21)?).await?;
    let scopes = vec!["joint".to_owned()];
    let initial = load_category_detail(&pool, household, category, &scopes).await?;
    assert_eq!(initial.entries.len(), 4);
    assert!(
        initial
            .entries
            .iter()
            .all(|entry| entry.data_source == "loan_schedule")
    );
    assert_eq!(
        initial
            .monthly_totals
            .iter()
            .map(|row| row.amount)
            .collect::<Vec<_>>(),
        vec![dec!(80.03), dec!(115), dec!(110.01), dec!(50)]
    );
    // Payday uses the same category/month amounts, including imported extra payments
    // and materialized schedules, without counting both sources for a month.
    for (month, expected) in [
        (5, dec!(80.03)),
        (6, dec!(115)),
        (7, dec!(110.01)),
        (8, dec!(50)),
    ] {
        let period = date(month, 1)?;
        let records = payday::load(&pool, household, period, date(6, 1)?, &scopes).await?;
        let actuals: Vec<_> = records
            .actuals
            .iter()
            .filter(|row| row.month == period && row.category_id == Some(category))
            .collect();
        assert_eq!(actuals.len(), 1, "one row per comparison bucket");
        assert_eq!(actuals[0].amount, expected);
    }
    let end_month = date(8, 1)?;
    assert!(
        initial
            .monthly_totals
            .iter()
            .all(|row| row.period <= end_month)
    );

    let mut tx = tenant::begin(&pool, household, false).await?;
    sqlx::query(
        "INSERT INTO ledger_entries (household_id, direction, status, amount, entry_date,
             description, owner_scope, category_id, data_source)
         VALUES ($1, 'expense', 'actual', 90.02, $2, 'Paid loan', 'joint', $3, 'app_manual')",
    )
    .bind(household)
    .bind(date(6, 20)?)
    .bind(category)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let detail = load_category_detail(&pool, household, category, &scopes).await?;
    assert_eq!(detail.entries.len(), 4);
    assert_eq!(
        detail
            .entries
            .iter()
            .filter(|entry| entry.data_source == "loan_schedule")
            .count(),
        3
    );
    let board = load_board(&pool, household, &scopes, None, None).await?;
    assert_eq!(board.last_actual_entry_date, Some(date(6, 20)?));
    let stat = board
        .stats
        .iter()
        .find(|row| row.category_id == category)
        .ok_or_else(|| anyhow::anyhow!("loan category stats missing"))?;
    assert_eq!(stat.total_amount, dec!(330.06));
    assert_eq!(stat.entry_count, 4);
    assert_eq!(stat.month_count, 4);
    assert!(
        board
            .categories
            .iter()
            .any(|row| row.id == category && row.expense_group_id.is_some())
    );
    assert_eq!(
        board
            .monthly_totals
            .iter()
            .map(|row| row.amount)
            .sum::<rust_decimal::Decimal>(),
        stat.total_amount
    );
    let window = load_board(
        &pool,
        household,
        &scopes,
        Some(date(6, 1)?),
        Some(date(6, 30)?),
    )
    .await?;
    assert_eq!(window.stats[0].total_amount, dec!(90.02));
    let june_period = date(6, 1)?;
    let july_period = date(7, 1)?;
    let planner = payday::load(&pool, household, june_period, june_period, &scopes).await?;
    let june: Vec<_> = planner
        .actuals
        .iter()
        .filter(|row| row.month == june_period && row.category_id == Some(category))
        .collect();
    assert_eq!(june.len(), 1);
    assert_eq!(
        june[0].amount,
        dec!(90.02),
        "actual replaces schedule, not adds to it"
    );
    assert!(planner.actuals.iter().all(|row| row.month < july_period));
    let hidden_planner =
        payday::load(&pool, household, date(6, 1)?, date(6, 1)?, &["self".into()]).await?;
    assert!(hidden_planner.actuals.is_empty());
    let hidden = load_board(&pool, household, &["self".to_owned()], None, None).await?;
    // The property's empty Utilities projection remains visible, but no joint loan data does.
    assert_eq!(hidden.utility_property_ids, vec![property]);
    assert_eq!(hidden.stats.len(), 1);
    let utility_stat = &hidden.stats[0];
    assert_eq!(utility_stat.category_id, property);
    assert_eq!(utility_stat.total_amount, dec!(0));
    assert_eq!(utility_stat.entry_count, 0);
    assert_eq!(utility_stat.month_count, 0);
    assert_eq!(utility_stat.first_entry_date, None);
    assert_eq!(utility_stat.last_entry_date, None);
    assert_eq!(hidden.last_actual_entry_date, None);
    assert!(hidden.monthly_totals.is_empty());
    let other = create_development_session(
        &pool,
        &format!("other-loan-{}@example.com", Uuid::new_v4()),
        "Other Owner",
        "owner",
        24,
    )
    .await?;
    let isolated = load_board(&pool, other.household.id, &scopes, None, None).await?;
    assert!(isolated.stats.is_empty());
    assert!(isolated.monthly_totals.is_empty());
    let isolated_planner =
        payday::load(&pool, other.household.id, june_period, june_period, &scopes).await?;
    assert!(isolated_planner.actuals.is_empty());
    assert!(
        load_category_detail(&pool, other.household.id, category, &scopes)
            .await
            .is_err()
    );
    Ok(())
}
