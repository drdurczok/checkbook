use checkbook_postgres::{
    auth::create_development_session, backup::replace_household_data, connect, migrate, tenant,
};
use chrono::{Datelike, Utc};
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
async fn expense_sources_sync_without_creating_payments() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL expense source test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    migrate(&pool).await?;
    let identity = Uuid::new_v4();
    let context = create_development_session(
        &pool,
        &format!("expense-source-{identity}@example.com"),
        "Expense Owner",
        "owner",
        24,
    )
    .await?;
    let household_id = context.household.id;
    let mut tx = tenant::begin(&pool, household_id, false).await?;
    let probe_property_id: Uuid = sqlx::query_scalar(
        "INSERT INTO properties (household_id, name, valuation, valuation_date, status, data_source, source_key)
         VALUES ($1, 'Restore probe', 1, CURRENT_DATE, 'active', 'app_manual', $2) RETURNING id",
    )
    .bind(household_id)
    .bind(format!("test:restore-probe:{identity}"))
    .fetch_one(&mut *tx)
    .await?;
    let probe_link: Uuid = sqlx::query_scalar(
        "SELECT linked_property_id FROM expense_groups WHERE household_id = $1 AND linked_property_id = $2",
    )
    .bind(household_id)
    .bind(probe_property_id)
    .fetch_one(&mut *tx)
    .await?;
    assert_eq!(probe_link, probe_property_id);
    sqlx::query("DELETE FROM properties WHERE id = $1")
        .bind(probe_property_id)
        .execute(&mut *tx)
        .await?;
    let property_id: Uuid = sqlx::query_scalar(
        "INSERT INTO properties (household_id, name, valuation, valuation_date, status, data_source, source_key)
         VALUES ($1, 'House', 100, CURRENT_DATE, 'active', 'app_manual', $2) RETURNING id",
    )
    .bind(household_id)
    .bind(format!("test:property:{identity}"))
    .fetch_one(&mut *tx)
    .await?;
    let group_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM expense_groups WHERE household_id = $1 AND linked_property_id = $2",
    )
    .bind(household_id)
    .bind(property_id)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE expense_groups SET name = 'New house', normalized_name = 'new house' WHERE id = $1",
    )
    .bind(group_id)
    .execute(&mut *tx)
    .await?;
    let name: String = sqlx::query_scalar("SELECT name FROM properties WHERE id = $1")
        .bind(property_id)
        .fetch_one(&mut *tx)
        .await?;
    assert_eq!(name, "New house");
    sqlx::query("UPDATE properties SET name = 'Renamed house' WHERE id = $1")
        .bind(property_id)
        .execute(&mut *tx)
        .await?;
    let group_name: String =
        sqlx::query_scalar("SELECT name FROM expense_groups WHERE household_id = $1 AND id = $2")
            .bind(household_id)
            .bind(group_id)
            .fetch_one(&mut *tx)
            .await?;
    assert_eq!(group_name, "Renamed house");
    let project_id: Uuid = sqlx::query_scalar(
        "INSERT INTO projects (household_id, name, budget, valuation_date, stored_status, data_source, linked_property_id, source_key)
         VALUES ($1, 'Renovation', 50, CURRENT_DATE, 'active', 'app_manual', $2, $3) RETURNING id",
    )
    .bind(household_id)
    .bind(property_id)
    .bind(format!("test:project:{identity}"))
    .fetch_one(&mut *tx)
    .await?;
    let (category_id, bucket): (Uuid, Option<Uuid>) = sqlx::query_as(
        "SELECT id, expense_group_id FROM categories WHERE household_id = $1 AND linked_project_id = $2",
    )
    .bind(household_id)
    .bind(project_id)
    .fetch_one(&mut *tx)
    .await?;
    assert_eq!(bucket, Some(group_id));
    sqlx::query("UPDATE categories SET name = 'Kitchen', normalized_name = 'kitchen', expense_group_id = NULL WHERE id = $1")
        .bind(category_id)
        .execute(&mut *tx)
        .await?;
    let (name, linked_property): (String, Option<Uuid>) =
        sqlx::query_as("SELECT name, linked_property_id FROM projects WHERE id = $1")
            .bind(project_id)
            .fetch_one(&mut *tx)
            .await?;
    assert_eq!(name, "Kitchen");
    assert_eq!(linked_property, None);
    sqlx::query("SAVEPOINT linked_delete")
        .execute(&mut *tx)
        .await?;
    assert!(
        sqlx::query("DELETE FROM categories WHERE id = $1")
            .bind(category_id)
            .execute(&mut *tx)
            .await
            .is_err()
    );
    sqlx::query("ROLLBACK TO SAVEPOINT linked_delete")
        .execute(&mut *tx)
        .await?;
    let payment_id: Uuid = sqlx::query_scalar(
        "INSERT INTO ledger_entries (household_id, direction, status, amount, entry_date,
            description, owner_scope, data_source, category_id, source_key)
         VALUES ($1, 'expense', 'actual', 25, CURRENT_DATE, 'Recorded renovation payment',
            'joint', 'app_manual', $2, $3) RETURNING id",
    )
    .bind(household_id)
    .bind(category_id)
    .bind(format!("test:payment:{identity}"))
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM projects WHERE id = $1")
        .bind(project_id)
        .execute(&mut *tx)
        .await?;
    let detached: Option<Uuid> =
        sqlx::query_scalar("SELECT linked_project_id FROM categories WHERE id = $1")
            .bind(category_id)
            .fetch_one(&mut *tx)
            .await?;
    assert_eq!(detached, None);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM ledger_entries WHERE household_id = $1")
            .bind(household_id)
            .fetch_one(&mut *tx)
            .await?;
    assert_eq!(count, 1);
    let retained_category: Option<Uuid> =
        sqlx::query_scalar("SELECT category_id FROM ledger_entries WHERE id = $1")
            .bind(payment_id)
            .fetch_one(&mut *tx)
            .await?;
    assert_eq!(retained_category, Some(category_id));
    let account_id: Uuid = sqlx::query_scalar(
        "INSERT INTO financial_accounts (household_id, name, account_kind, account_type,
            owner_scope, source_key)
         VALUES ($1, 'Mortgage', 'liability', 'mortgage', 'joint', $2) RETURNING id",
    )
    .bind(household_id)
    .bind(format!("test:account:{identity}"))
    .fetch_one(&mut *tx)
    .await?;
    let loan_id: Uuid = sqlx::query_scalar(
        "INSERT INTO loans (household_id, account_id, name, liability_type, owner_scope,
            original_balance, current_balance, linked_property_id, source_key)
         VALUES ($1, $2, 'Mortgage', 'mortgage', 'joint', 100, 100, $3, $4) RETURNING id",
    )
    .bind(household_id)
    .bind(account_id)
    .bind(property_id)
    .bind(format!("test:loan:{identity}"))
    .fetch_one(&mut *tx)
    .await?;
    let loan_bucket: Option<Uuid> =
        sqlx::query_scalar("SELECT expense_group_id FROM categories WHERE linked_loan_id = $1")
            .bind(loan_id)
            .fetch_one(&mut *tx)
            .await?;
    assert_eq!(loan_bucket, Some(group_id));
    let loan_category_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM categories WHERE household_id = $1 AND linked_loan_id = $2",
    )
    .bind(household_id)
    .bind(loan_id)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("UPDATE loans SET name = 'Mortgage renamed' WHERE household_id = $1 AND id = $2")
        .bind(household_id)
        .bind(loan_id)
        .execute(&mut *tx)
        .await?;
    let loan_category_name: String = sqlx::query_scalar(
        "SELECT name FROM categories WHERE household_id = $1 AND linked_loan_id = $2",
    )
    .bind(household_id)
    .bind(loan_id)
    .fetch_one(&mut *tx)
    .await?;
    assert_eq!(loan_category_name, "Mortgage renamed");
    sqlx::query("UPDATE categories SET name = 'Home loan', normalized_name = 'home loan' WHERE household_id = $1 AND linked_loan_id = $2")
        .bind(household_id)
        .bind(loan_id)
        .execute(&mut *tx)
        .await?;
    let loan_name: String =
        sqlx::query_scalar("SELECT name FROM loans WHERE household_id = $1 AND id = $2")
            .bind(household_id)
            .bind(loan_id)
            .fetch_one(&mut *tx)
            .await?;
    assert_eq!(loan_name, "Home loan");
    let ordinary_group_id: Uuid = sqlx::query_scalar(
        "INSERT INTO expense_groups (household_id, name, normalized_name)
         VALUES ($1, 'Other expenses', 'other expenses') RETURNING id",
    )
    .bind(household_id)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("SAVEPOINT loan_invalid_group")
        .execute(&mut *tx)
        .await?;
    // A move must target a property category or Uncategorized, never an ordinary category.
    let invalid_move = sqlx::query("UPDATE categories SET expense_group_id = $1 WHERE household_id = $2 AND linked_loan_id = $3")
        .bind(ordinary_group_id)
        .bind(household_id)
        .bind(loan_id)
        .execute(&mut *tx)
        .await;
    let invalid_move_error = invalid_move
        .err()
        .ok_or_else(|| anyhow::anyhow!("loan group move to an ordinary category must fail"))?;
    assert_eq!(
        invalid_move_error
            .as_database_error()
            .and_then(|error| error.code())
            .as_deref(),
        Some("23514")
    );
    sqlx::query("ROLLBACK TO SAVEPOINT loan_invalid_group")
        .execute(&mut *tx)
        .await?;
    let loan_linked_group: Uuid = sqlx::query_scalar(
        "SELECT expense_group_id FROM categories WHERE household_id = $1 AND linked_loan_id = $2",
    )
    .bind(household_id)
    .bind(loan_id)
    .fetch_one(&mut *tx)
    .await?;
    assert_eq!(loan_linked_group, group_id);
    let second_property_id: Uuid = sqlx::query_scalar(
        "INSERT INTO properties (household_id, name, valuation, valuation_date, status, data_source, source_key)
         VALUES ($1, 'Second house', 10, CURRENT_DATE, 'active', 'app_manual', $2) RETURNING id",
    )
    .bind(household_id)
    .bind(format!("test:property-two:{identity}"))
    .fetch_one(&mut *tx)
    .await?;
    let second_group_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM expense_groups WHERE household_id = $1 AND linked_property_id = $2",
    )
    .bind(household_id)
    .bind(second_property_id)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("UPDATE categories SET expense_group_id = $1 WHERE household_id = $2 AND linked_loan_id = $3")
        .bind(second_group_id)
        .bind(household_id)
        .bind(loan_id)
        .execute(&mut *tx)
        .await?;
    let reassigned_property: Option<Uuid> = sqlx::query_scalar(
        "SELECT linked_property_id FROM loans WHERE household_id = $1 AND id = $2",
    )
    .bind(household_id)
    .bind(loan_id)
    .fetch_one(&mut *tx)
    .await?;
    assert_eq!(reassigned_property, Some(second_property_id));
    sqlx::query("UPDATE categories SET expense_group_id = NULL WHERE household_id = $1 AND linked_loan_id = $2")
        .bind(household_id)
        .bind(loan_id)
        .execute(&mut *tx)
        .await?;
    let (uncategorized_group, unlinked_property): (Option<Uuid>, Option<Uuid>) = sqlx::query_as(
        "SELECT category.expense_group_id, loan.linked_property_id
         FROM categories category JOIN loans loan ON loan.household_id = category.household_id
           AND loan.id = category.linked_loan_id
         WHERE category.household_id = $1 AND category.linked_loan_id = $2",
    )
    .bind(household_id)
    .bind(loan_id)
    .fetch_one(&mut *tx)
    .await?;
    assert_eq!((uncategorized_group, unlinked_property), (None, None));
    sqlx::query("UPDATE categories SET expense_group_id = $1 WHERE household_id = $2 AND linked_loan_id = $3")
        .bind(group_id)
        .bind(household_id)
        .bind(loan_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE loans SET monthly_payment = 10 WHERE household_id = $1 AND id = $2")
        .bind(household_id)
        .bind(loan_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SAVEPOINT linked_property_delete")
        .execute(&mut *tx)
        .await?;
    assert!(
        sqlx::query("DELETE FROM expense_groups WHERE household_id = $1 AND id = $2")
            .bind(household_id)
            .bind(second_group_id)
            .execute(&mut *tx)
            .await
            .is_err()
    );
    sqlx::query("ROLLBACK TO SAVEPOINT linked_property_delete")
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE categories SET expense_group_id = $1 WHERE household_id = $2 AND linked_loan_id = $3")
        .bind(group_id)
        .bind(household_id)
        .bind(loan_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM properties WHERE household_id = $1 AND id = $2")
        .bind(household_id)
        .bind(second_property_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SAVEPOINT source_collision")
        .execute(&mut *tx)
        .await?;
    assert!(sqlx::query(
        "INSERT INTO projects (household_id, name, valuation_date, stored_status, data_source, source_key)
         VALUES ($1, 'Home loan', CURRENT_DATE, 'active', 'app_manual', $2)",
    )
    .bind(household_id)
    .bind(format!("test:collision:{identity}"))
    .execute(&mut *tx)
    .await
    .is_err());
    sqlx::query("ROLLBACK TO SAVEPOINT source_collision")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let today = Utc::now().date_naive();
    let current_month = today
        .with_day(1)
        .ok_or_else(|| anyhow::anyhow!("invalid current month"))?;
    checkbook_postgres::planning::materialize_household(&pool, household_id, current_month).await?;
    let mut planning_check = tenant::begin(&pool, household_id, true).await?;
    let planned_category: Uuid = sqlx::query_scalar(
        "SELECT category_id FROM planning_rules WHERE household_id = $1 AND linked_loan_id = $2",
    )
    .bind(household_id)
    .bind(loan_id)
    .fetch_one(&mut *planning_check)
    .await?;
    assert_eq!(planned_category, loan_category_id);
    planning_check.commit().await?;
    let snapshot = checkbook_postgres::backup::snapshot_household(&pool, household_id).await?;
    checkbook_postgres::backup::restore_household(&pool, household_id, context.user.id, &snapshot)
        .await?;
    let mut restored = tenant::begin(&pool, household_id, true).await?;
    let restored_bucket: Uuid = sqlx::query_scalar(
        "SELECT id FROM expense_groups WHERE household_id = $1 AND linked_property_id = $2",
    )
    .bind(household_id)
    .bind(property_id)
    .fetch_one(&mut *restored)
    .await?;
    assert_eq!(restored_bucket, group_id);
    let restored_payment_category: Option<Uuid> =
        sqlx::query_scalar("SELECT category_id FROM ledger_entries WHERE id = $1")
            .bind(payment_id)
            .fetch_one(&mut *restored)
            .await?;
    assert_eq!(restored_payment_category, Some(category_id));
    restored.commit().await?;

    let mut tx = tenant::begin(&pool, household_id, false).await?;
    let mut invalid_restore =
        checkbook_postgres::backup::snapshot_household(&pool, household_id).await?;
    let groups = invalid_restore
        .tables
        .get_mut("expense_groups")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| anyhow::anyhow!("snapshot expense_groups must be an array"))?;
    let mut duplicate_group = groups
        .first()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("snapshot must contain the property expense group"))?;
    duplicate_group["id"] = json!(Uuid::new_v4());
    duplicate_group["linked_property_id"] = serde_json::Value::Null;
    groups.push(duplicate_group);
    assert!(
        replace_household_data(&mut tx, household_id, &invalid_restore)
            .await
            .is_err()
    );
    let restored_payment_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ledger_entries WHERE household_id = $1 AND id = $2",
    )
    .bind(household_id)
    .bind(payment_id)
    .fetch_one(&mut *tx)
    .await?;
    assert_eq!(restored_payment_count, 1);
    let recovery_property: Uuid = sqlx::query_scalar(
        "INSERT INTO properties (household_id, name, valuation, valuation_date, status, data_source, source_key)
         VALUES ($1, 'Recovery property', 1, CURRENT_DATE, 'active', 'app_manual', $2) RETURNING id",
    )
    .bind(household_id)
    .bind(format!("test:recovery:{identity}"))
    .fetch_one(&mut *tx)
    .await?;
    let recovery_link: Uuid = sqlx::query_scalar(
        "SELECT linked_property_id FROM expense_groups WHERE household_id = $1 AND linked_property_id = $2",
    )
    .bind(household_id)
    .bind(recovery_property)
    .fetch_one(&mut *tx)
    .await?;
    assert_eq!(recovery_link, recovery_property);
    tx.rollback().await?;
    Ok(())
}
