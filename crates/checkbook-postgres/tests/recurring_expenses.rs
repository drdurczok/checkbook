use checkbook_postgres::{
    auth::create_development_session,
    connect,
    records::RecordsStoreError,
    recurring_expenses::{self as recurring, RecurringExpenseInput},
    tenant,
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use uuid::Uuid;

fn date(value: &str) -> anyhow::Result<NaiveDate> {
    Ok(NaiveDate::parse_from_str(value, "%Y-%m-%d")?)
}

fn input(start_date: NaiveDate, amount: Decimal) -> RecurringExpenseInput {
    RecurringExpenseInput {
        description: "Subscription".to_owned(),
        amount,
        start_date,
        end_date: None,
        cadence: "monthly".to_owned(),
        owner_scope: "joint".to_owned(),
        category_name: "Subscriptions".to_owned(),
        notes: "Schedule notes".to_owned(),
    }
}

#[tokio::test]
async fn recurring_cursor_history_early_expense_and_retirement() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; recurring integration test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let session = create_development_session(
        &pool,
        &format!("recurring-{}@example.com", Uuid::new_v4()),
        "Owner",
        "owner",
        24,
    )
    .await?;
    let household = session.household.id;
    let scopes = vec!["joint".to_owned()];
    let today = date("2026-03-01")?;
    let start = date("2026-01-31")?;
    let record = recurring::create(
        &pool,
        household,
        &scopes,
        input(start, dec!(12)),
        today,
        "EUR",
    )
    .await?;
    assert_eq!(record.next_due_date, Some(date("2026-03-31")?));
    assert_eq!(record.price_history.as_array().map(Vec::len), Some(1));
    let (first_read, second_read) = tokio::join!(
        recurring::list(&pool, household, &scopes, today, "EUR"),
        recurring::list(&pool, household, &scopes, today, "EUR"),
    );
    first_read?;
    second_read?;
    let record = recurring::expense_now(&pool, household, &scopes, record.id, today, "EUR").await?;
    assert_eq!(record.next_due_date, Some(date("2026-04-30")?));
    let unchanged = recurring::update(
        &pool,
        household,
        &scopes,
        record.id,
        input(start, dec!(12)),
        today,
        "EUR",
    )
    .await?;
    assert_eq!(unchanged.price_history, record.price_history);
    // An overdue old-price occurrence is emitted before applying the changed amount.
    let changed = recurring::update(
        &pool,
        household,
        &scopes,
        record.id,
        input(start, dec!(20)),
        date("2026-05-01")?,
        "EUR",
    )
    .await?;
    assert_eq!(changed.next_due_date, Some(date("2026-05-31")?));
    assert_eq!(changed.price_history.as_array().map(Vec::len), Some(2));
    let retired = recurring::retire(
        &pool,
        household,
        &scopes,
        record.id,
        date("2026-06-01")?,
        "EUR",
    )
    .await?;
    assert!(!retired.is_active);
    assert_eq!(retired.next_due_date, None);
    assert_eq!(retired.price_history, changed.price_history);
    recurring::list(&pool, household, &scopes, date("2027-01-01")?, "EUR").await?;
    let mut tx = tenant::begin(&pool, household, true).await?;
    let rows = sqlx::query!(
        "SELECT amount, entry_date, status, data_source, source_key FROM ledger_entries
        WHERE household_id = $1 AND data_source = 'app_recurring' ORDER BY entry_date, source_key",
        household
    )
    .fetch_all(&mut *tx)
    .await?;
    assert_eq!(rows.len(), 5);
    assert_eq!(
        rows.iter().map(|row| row.amount).collect::<Vec<_>>(),
        vec![dec!(12), dec!(12), dec!(12), dec!(12), dec!(20)]
    );
    assert_eq!(
        rows.iter().map(|row| row.entry_date).collect::<Vec<_>>(),
        vec![
            Some(start),
            Some(date("2026-02-28")?),
            Some(today),
            Some(date("2026-04-30")?),
            Some(date("2026-05-31")?)
        ]
    );
    assert!(rows.iter().all(|row| {
        row.status == "actual"
            && row
                .source_key
                .as_deref()
                .is_some_and(|key| key.starts_with("app_recurring:"))
    }));
    tx.commit().await?;
    let snapshot = checkbook_postgres::backup::snapshot_household(&pool, household).await?;
    checkbook_postgres::backup::restore_household(&pool, household, session.user.id, &snapshot)
        .await?;
    let restored = recurring::list(&pool, household, &scopes, date("2027-01-01")?, "EUR").await?;
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].price_history, retired.price_history);
    assert!(!restored[0].is_active);
    Ok(())
}

#[tokio::test]
async fn recurring_forecast_aggregates_and_excludes_consumed_occurrences() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; recurring forecast test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let session = create_development_session(
        &pool,
        &format!("recurring-forecast-{}@example.com", Uuid::new_v4()),
        "Owner",
        "owner",
        24,
    )
    .await?;
    let household = session.household.id;
    let scopes = vec!["joint".to_owned()];
    let today = date("2026-01-01")?;
    let mut payload = input(date("2026-01-05")?, dec!(10));
    payload.cadence = "weekly".to_owned();
    payload.end_date = Some(date("2026-02-28")?);
    let record = recurring::create(&pool, household, &scopes, payload, today, "EUR").await?;
    checkbook_postgres::planning::materialize_household(&pool, household, today).await?;
    let stable_key = format!("system:recurring-expense:{}", record.id);
    let mut tx = tenant::begin(&pool, household, true).await?;
    let months = sqlx::query!("SELECT o.period, o.calculated_amount AS amount FROM planning_occurrences o JOIN planning_rules r ON r.household_id = o.household_id AND r.id = o.planning_rule_id WHERE o.household_id = $1 AND r.stable_key = $2 ORDER BY o.period", household, stable_key).fetch_all(&mut *tx).await?;
    assert_eq!(
        months
            .iter()
            .map(|row| (row.period, row.amount))
            .collect::<Vec<_>>(),
        vec![(today, dec!(40)), (date("2026-02-01")?, dec!(40))]
    );
    tx.commit().await?;
    recurring::expense_now(&pool, household, &scopes, record.id, today, "EUR").await?;
    checkbook_postgres::planning::materialize_household(&pool, household, today).await?;
    let mut tx = tenant::begin(&pool, household, true).await?;
    let january = sqlx::query!("SELECT o.calculated_amount AS amount FROM planning_occurrences o JOIN planning_rules r ON r.household_id = o.household_id AND r.id = o.planning_rule_id WHERE o.household_id = $1 AND r.stable_key = $2 AND o.period = $3", household, stable_key, today).fetch_one(&mut *tx).await?;
    assert_eq!(january.amount, dec!(30));
    tx.commit().await?;
    recurring::retire(&pool, household, &scopes, record.id, today, "EUR").await?;
    checkbook_postgres::planning::materialize_household(&pool, household, today).await?;
    let mut tx = tenant::begin(&pool, household, true).await?;
    let rules = sqlx::query!(
        "SELECT id FROM planning_rules WHERE household_id = $1 AND stable_key = $2",
        household,
        stable_key
    )
    .fetch_all(&mut *tx)
    .await?;
    assert!(rules.is_empty());
    tx.commit().await?;
    Ok(())
}

#[tokio::test]
async fn recurring_housing_does_not_seed_duplicate_forecast_and_ancient_create_rolls_back()
-> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; recurring housing test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let session = create_development_session(
        &pool,
        &format!("recurring-housing-{}@example.com", Uuid::new_v4()),
        "Owner",
        "owner",
        24,
    )
    .await?;
    let household = session.household.id;
    let scopes = vec!["joint".to_owned()];
    let today = date("2026-03-01")?;
    let mut payload = input(date("2026-01-01")?, dec!(100));
    payload.description = "Rent".to_owned();
    payload.category_name = "Housing".to_owned();
    let record = recurring::create(&pool, household, &scopes, payload, today, "EUR").await?;
    checkbook_postgres::planning::materialize_household(&pool, household, today).await?;
    let mut tx = tenant::begin(&pool, household, true).await?;
    let rules = sqlx::query!("SELECT stable_key FROM planning_rules WHERE household_id = $1 AND stable_key LIKE 'system:%'", household).fetch_all(&mut *tx).await?;
    assert!(!rules.iter().any(|rule| rule.stable_key == "system:housing"));
    assert!(
        rules
            .iter()
            .any(|rule| rule.stable_key == format!("system:recurring-expense:{}", record.id))
    );
    let future = sqlx::query!("SELECT sum(o.calculated_amount)::numeric AS amount FROM planning_occurrences o JOIN planning_rules r ON r.household_id = o.household_id AND r.id = o.planning_rule_id WHERE o.household_id = $1 AND o.period = $2 AND r.direction = 'expense'", household, date("2026-04-01")?).fetch_one(&mut *tx).await?;
    assert_eq!(future.amount, Some(dec!(100)));
    tx.commit().await?;
    recurring::retire(&pool, household, &scopes, record.id, today, "EUR").await?;
    checkbook_postgres::planning::materialize_household(&pool, household, today).await?;
    let mut tx = tenant::begin(&pool, household, true).await?;
    let rules = sqlx::query!("SELECT stable_key FROM planning_rules WHERE household_id = $1 AND stable_key LIKE 'system:%'", household).fetch_all(&mut *tx).await?;
    assert!(!rules.iter().any(|rule| rule.stable_key == "system:housing"
        || rule.stable_key == format!("system:recurring-expense:{}", record.id)));
    let before = sqlx::query!("SELECT count(*) AS \"count!\" FROM ledger_entries WHERE household_id = $1 AND data_source = 'app_recurring'", household).fetch_one(&mut *tx).await?.count;
    assert_eq!(before, 3);
    tx.commit().await?;
    let mut ancient = input(date("1800-01-01")?, dec!(1));
    ancient.cadence = "weekly".to_owned();
    assert!(matches!(
        recurring::create(&pool, household, &scopes, ancient, today, "EUR").await,
        Err(RecordsStoreError::Validation(_))
    ));
    let records = recurring::list(&pool, household, &scopes, today, "EUR").await?;
    assert_eq!(records.len(), 1);
    let mut tx = tenant::begin(&pool, household, true).await?;
    let after = sqlx::query!("SELECT count(*) AS \"count!\" FROM ledger_entries WHERE household_id = $1 AND data_source = 'app_recurring'", household).fetch_one(&mut *tx).await?.count;
    assert_eq!(after, before);
    tx.commit().await?;
    Ok(())
}

#[tokio::test]
async fn recurring_end_reset_validation_scope_and_tenant_boundaries() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; recurring integration test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let first = create_development_session(
        &pool,
        &format!("recurring-security-{}@example.com", Uuid::new_v4()),
        "Owner",
        "owner",
        24,
    )
    .await?;
    let second = create_development_session(
        &pool,
        &format!("recurring-other-{}@example.com", Uuid::new_v4()),
        "Other",
        "owner",
        24,
    )
    .await?;
    let household = first.household.id;
    let scopes = vec!["joint".to_owned()];
    let today = date("2026-01-01")?;
    let start = date("2026-01-31")?;
    let mut payload = input(start, dec!(9));
    payload.end_date = Some(date("2026-02-28")?);
    let record =
        recurring::create(&pool, household, &scopes, payload.clone(), today, "EUR").await?;
    assert_eq!(record.next_due_date, Some(start));
    assert!(matches!(
        recurring::update(
            &pool,
            household,
            &["self".to_owned()],
            record.id,
            payload.clone(),
            today,
            "EUR"
        )
        .await,
        Err(RecordsStoreError::Forbidden)
    ));
    assert!(matches!(
        recurring::retire(&pool, second.household.id, &scopes, record.id, today, "EUR").await,
        Err(RecordsStoreError::NotFound)
    ));
    assert!(
        recurring::list(&pool, second.household.id, &scopes, today, "EUR")
            .await?
            .is_empty()
    );
    assert!(
        recurring::list(&pool, household, &["self".to_owned()], today, "EUR")
            .await?
            .is_empty()
    );
    let exhausted = recurring::list(&pool, household, &scopes, date("2026-03-01")?, "EUR").await?;
    assert_eq!(exhausted[0].next_due_date, None);
    assert!(
        recurring::expense_now(
            &pool,
            household,
            &scopes,
            record.id,
            date("2026-03-01")?,
            "EUR"
        )
        .await
        .is_err()
    );
    // Cadence edits preserve actuals rather than replaying the new schedule's past.
    payload.cadence = "weekly".to_owned();
    payload.end_date = Some(start);
    let reset = recurring::update(
        &pool,
        household,
        &scopes,
        record.id,
        payload.clone(),
        date("2026-03-01")?,
        "EUR",
    )
    .await?;
    assert_eq!(reset.next_due_date, None);
    assert_eq!(reset.price_history.as_array().map(Vec::len), Some(1));
    let mut tx = tenant::begin(&pool, household, true).await?;
    let count = sqlx::query!("SELECT count(*) AS \"count!\" FROM ledger_entries WHERE household_id = $1 AND data_source = 'app_recurring'", household).fetch_one(&mut *tx).await?.count;
    assert_eq!(count, 2);
    tx.commit().await?;
    let mut shifted = payload.clone();
    shifted.start_date = date("2026-01-01")?;
    shifted.end_date = None;
    let shifted = recurring::update(
        &pool,
        household,
        &scopes,
        record.id,
        shifted,
        date("2026-03-01")?,
        "EUR",
    )
    .await?;
    assert_eq!(shifted.next_due_date, Some(date("2026-03-05")?));
    let mut tx = tenant::begin(&pool, household, true).await?;
    let count = sqlx::query!("SELECT count(*) AS \"count!\" FROM ledger_entries WHERE household_id = $1 AND data_source = 'app_recurring'", household).fetch_one(&mut *tx).await?.count;
    assert_eq!(count, 2);
    tx.commit().await?;
    for amount in [dec!(0), dec!(-1), dec!(0.001)] {
        let mut invalid = payload.clone();
        invalid.amount = amount;
        assert!(matches!(
            recurring::create(&pool, household, &scopes, invalid, today, "EUR").await,
            Err(RecordsStoreError::Validation(_))
        ));
    }
    let mut invalid = payload.clone();
    invalid.end_date = Some(today);
    assert!(
        recurring::create(&pool, household, &scopes, invalid, today, "EUR")
            .await
            .is_err()
    );
    let mut invalid = payload.clone();
    invalid.cadence = "nonsense".to_owned();
    assert!(
        recurring::create(&pool, household, &scopes, invalid, today, "EUR")
            .await
            .is_err()
    );
    assert!(
        recurring::create(&pool, household, &scopes, payload.clone(), today, "INVALID")
            .await
            .is_err()
    );
    // Database forced RLS and the composite category FK reject cross-tenant writes.
    let mut tx = tenant::begin(&pool, second.household.id, false).await?;
    let visible = sqlx::query!("SELECT id FROM recurring_expenses WHERE id = $1", record.id)
        .fetch_all(&mut *tx)
        .await?;
    assert!(visible.is_empty());
    let foreign_category = record.category_id;
    let attempted = sqlx::query!("INSERT INTO recurring_expenses (household_id, description, amount, start_date, cadence, owner_scope, category_id)
        VALUES ($1, 'Cross tenant', 1, $2, 'monthly', 'joint', $3)", second.household.id, today, foreign_category).execute(&mut *tx).await;
    assert!(attempted.is_err());
    tx.rollback().await?;
    let mut tx = tenant::begin(&pool, household, false).await?;
    sqlx::query!(
        "UPDATE categories SET is_retired = true WHERE household_id = $1 AND id = $2",
        household,
        foreign_category
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    assert!(matches!(
        recurring::create(&pool, household, &scopes, payload, today, "EUR").await,
        Err(RecordsStoreError::Validation(_))
    ));
    Ok(())
}
