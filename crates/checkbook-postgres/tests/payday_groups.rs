use checkbook_postgres::{
    auth::create_development_session,
    connect,
    payday::{self, Input},
    tenant,
};
use chrono::{NaiveDate, Utc};
use rust_decimal_macros::dec;
use uuid::Uuid;

#[tokio::test]
async fn group_snapshots_validate_hierarchy_and_preserve_deleted_names() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; payday group integration skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let owner = create_development_session(
        &pool,
        &format!("groups-{}@example.com", Uuid::new_v4()),
        "Owner",
        "owner",
        24,
    )
    .await?;
    let other = create_development_session(
        &pool,
        &format!("groups-{}@example.com", Uuid::new_v4()),
        "Other",
        "owner",
        24,
    )
    .await?;
    let household = owner.household.id;
    let month: NaiveDate = "2026-06-01".parse()?;
    let scopes = vec!["self".into(), "joint".into()];
    let mut tx = tenant::begin(&pool, household, false).await?;
    let group: Uuid = sqlx::query_scalar("INSERT INTO expense_groups (household_id,name,normalized_name,creation_origin) VALUES ($1,'Food','food','manual') RETURNING id").bind(household).fetch_one(&mut *tx).await?;
    let category: Uuid = sqlx::query_scalar("INSERT INTO categories (household_id,kind,name,normalized_name,expense_group_id) VALUES ($1,'expense','Groceries','groceries',$2) RETURNING id").bind(household).bind(group).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO ledger_entries (household_id,direction,status,amount,currency,entry_date,description,owner_scope,data_source,category_id) VALUES ($1,'expense','actual',173.80,'PLN',$2,'Food','joint','app_manual',$3)").bind(household).bind(month).bind(category).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut value = Input {
        position: None,
        title: "Food".into(),
        section: "monthly".into(),
        kind: "expense".into(),
        expense_group_id: Some(group),
        category_id: None,
        subcategory_id: None,
        amount: dec!(200),
        notes: String::new(),
        completed: false,
        recurring: Some(true),
        template_id: None,
        source_key: None,
    };
    payday::save(&pool, household, month, None, &value, Utc::now()).await?;
    let records = payday::load(&pool, household, month, month, &scopes).await?;
    assert_eq!(records.allocations.len(), 1);
    let allocation = &records.allocations[0];
    assert_eq!(allocation.expense_group_id, Some(group));
    assert_eq!(allocation.expense_group_name.as_deref(), Some("Food"));
    assert_eq!(records.templates[0].expense_group_id, Some(group));
    assert_eq!(records.actuals[0].expense_group_id, Some(group));
    assert_eq!(records.actuals[0].amount, dec!(173.80));
    assert!(
        payday::save(&pool, other.household.id, month, None, &value, Utc::now())
            .await
            .is_err()
    );
    value.category_id = Some(category);
    value.expense_group_id = Some(Uuid::new_v4());
    assert!(
        payday::save(&pool, household, month, None, &value, Utc::now())
            .await
            .is_err()
    );
    value.expense_group_id = None;
    value.recurring = None;
    payday::save(&pool, household, month, None, &value, Utc::now()).await?;
    let legacy = payday::load(&pool, household, month, month, &scopes).await?;
    assert!(
        legacy
            .allocations
            .iter()
            .all(|row| row.expense_group_id == Some(group))
    );
    let snapshot = checkbook_postgres::backup::snapshot_household(&pool, household).await?;
    checkbook_postgres::backup::restore_household(&pool, household, owner.user.id, &snapshot)
        .await?;
    let restored = payday::load(&pool, household, month, month, &scopes).await?;
    assert!(
        restored
            .allocations
            .iter()
            .any(|row| row.category_id.is_none() && row.expense_group_id == Some(group))
    );
    let mut broken = snapshot.clone();
    let row = broken
        .tables
        .get_mut("payday_allocations")
        .and_then(|rows| rows.get_mut(0))
        .ok_or_else(|| anyhow::anyhow!("missing backup allocation"))?;
    row["expense_group_id"] = serde_json::json!(Uuid::new_v4());
    assert!(
        checkbook_postgres::backup::restore_household(&pool, household, owner.user.id, &broken)
            .await
            .is_err()
    );
    // The composite FK clears only the group reference and retains historical labels.
    let mut tx = tenant::begin(&pool, household, false).await?;
    sqlx::query("UPDATE categories SET expense_group_id=NULL WHERE household_id=$1 AND id=$2")
        .bind(household)
        .bind(category)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM expense_groups WHERE household_id=$1 AND id=$2")
        .bind(household)
        .bind(group)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    value.category_id = None;
    value.expense_group_id = None;
    value.recurring = Some(false);
    value.notes = "Deleted group snapshot".into();
    payday::save(
        &pool,
        household,
        month,
        Some(allocation.id),
        &value,
        Utc::now(),
    )
    .await?;
    let records = payday::load(&pool, household, month, month, &scopes).await?;
    let preserved = records
        .allocations
        .iter()
        .find(|row| row.id == allocation.id)
        .ok_or_else(|| anyhow::anyhow!("missing snapshot"))?;
    assert_eq!(preserved.expense_group_id, None);
    assert_eq!(preserved.expense_group_name.as_deref(), Some("Food"));
    Ok(())
}
