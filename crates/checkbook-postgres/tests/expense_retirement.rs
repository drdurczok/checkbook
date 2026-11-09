use checkbook_postgres::{
    auth::create_development_session,
    backup::{restore_household, snapshot_household},
    connect,
    expenses::{
        ExpenseCategoryInput, ExpenseGroupInput, create_category, create_group, delete_category,
        delete_group, load_board, load_category_detail, update_category, update_group,
    },
    migrate, tenant,
};
use uuid::Uuid;

fn group_input(name: &str, is_retired: Option<bool>) -> ExpenseGroupInput {
    ExpenseGroupInput {
        name: name.to_owned(),
        color: String::new(),
        notes: String::new(),
        sort_order: 0,
        is_retired,
    }
}

fn category_input(name: &str, group_id: Uuid, is_retired: Option<bool>) -> ExpenseCategoryInput {
    ExpenseCategoryInput {
        name: name.to_owned(),
        expense_group_id: Some(group_id),
        sort_order: 0,
        is_retired,
    }
}

#[tokio::test]
async fn retirement_origin_sources_restore_and_tenant_isolation() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; PostgreSQL retirement test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    migrate(&pool).await?;
    let owner = create_development_session(
        &pool,
        &format!("retirement-{}@example.com", Uuid::new_v4()),
        "Retirement owner",
        "owner",
        24,
    )
    .await?;
    let other = create_development_session(
        &pool,
        &format!("retirement-other-{}@example.com", Uuid::new_v4()),
        "Other owner",
        "owner",
        24,
    )
    .await?;
    let household = owner.household.id;
    let scopes = vec!["self".to_owned(), "spouse".to_owned(), "joint".to_owned()];
    let group = create_group(&pool, household, group_input("Manual bucket", None)).await?;
    assert!(!group.is_retired && group.can_delete);
    let category = create_category(
        &pool,
        household,
        category_input("Manual expense", group.id, Some(true)),
    )
    .await?;
    assert!(category.is_retired && category.can_delete);
    let group = update_group(
        &pool,
        household,
        group.id,
        group_input("Manual bucket", Some(true)),
    )
    .await?;
    assert!(group.is_retired && group.can_delete);
    assert!(
        update_group(
            &pool,
            household,
            group.id,
            group_input("Manual bucket", None)
        )
        .await?
        .is_retired
    );
    assert!(
        update_category(
            &pool,
            household,
            category.id,
            category_input("Manual expense", group.id, None)
        )
        .await?
        .is_retired
    );
    assert!(
        load_category_detail(&pool, household, category.id, &scopes)
            .await?
            .category
            .is_retired
    );
    assert!(
        !update_category(
            &pool,
            household,
            category.id,
            category_input("Manual expense", group.id, Some(false))
        )
        .await?
        .is_retired
    );
    assert!(
        delete_category(&pool, other.household.id, category.id)
            .await
            .is_err()
    );
    assert!(
        update_group(
            &pool,
            other.household.id,
            group.id,
            group_input("Cross tenant", Some(false))
        )
        .await
        .is_err()
    );
    assert!(
        load_category_detail(&pool, other.household.id, category.id, &scopes)
            .await
            .is_err()
    );
    let other_board = load_board(&pool, other.household.id, &scopes, None, None).await?;
    assert!(!other_board.groups.iter().any(|g| g.id == group.id));

    // Default provenance covers every unannotated creation source, including
    // imports, planning and asset helpers; source removal cannot erase it.
    let mut tx = tenant::begin(&pool, household, false).await?;
    let automatic: Uuid = sqlx::query_scalar("INSERT INTO categories (household_id, kind, name, normalized_name) VALUES ($1, 'expense', 'Imported expense', 'imported expense') RETURNING id")
        .bind(household).fetch_one(&mut *tx).await?;
    let property: Uuid = sqlx::query_scalar("INSERT INTO properties (household_id, name, valuation, valuation_date, status, data_source, source_key) VALUES ($1, 'Retired property', 1, CURRENT_DATE, 'active', 'app_manual', $2) RETURNING id")
        .bind(household).bind(format!("retirement:{}", Uuid::new_v4())).fetch_one(&mut *tx).await?;
    let source_group: Uuid = sqlx::query_scalar(
        "SELECT id FROM expense_groups WHERE household_id = $1 AND linked_property_id = $2",
    )
    .bind(household)
    .bind(property)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    checkbook_postgres::assets::create_own_category(&pool, household, property).await?;
    let asset_board = load_board(&pool, household, &scopes, None, None).await?;
    let asset_category = asset_board
        .categories
        .iter()
        .find(|c| c.name == "Retired property")
        .ok_or_else(|| anyhow::anyhow!("asset category missing"))?;
    assert!(!asset_category.can_delete);
    assert!(
        delete_category(&pool, household, asset_category.id)
            .await
            .is_err()
    );

    // A manual item reused by a source remains manual, but cannot be deleted
    // while the source reference exists.
    let mut tx = tenant::begin(&pool, household, false).await?;
    sqlx::query("INSERT INTO property_categories (household_id, property_id, category_id) VALUES ($1, $2, $3)")
        .bind(household).bind(property).bind(category.id).execute(&mut *tx).await?;
    tx.commit().await?;
    assert!(
        !load_category_detail(&pool, household, category.id, &scopes)
            .await?
            .category
            .can_delete
    );
    assert!(
        delete_category(&pool, household, category.id)
            .await
            .is_err()
    );

    let source = update_group(
        &pool,
        household,
        source_group,
        group_input("Retired property", Some(true)),
    )
    .await?;
    assert!(source.is_retired && !source.can_delete);
    let mut tx = tenant::begin(&pool, household, false).await?;
    sqlx::query("UPDATE properties SET name = 'Renamed retired property' WHERE id = $1")
        .bind(property)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let board = load_board(&pool, household, &scopes, None, None).await?;
    assert!(board.groups.iter().any(|g| g.id == source_group
        && g.is_retired
        && !g.can_delete
        && g.name == "Renamed retired property"));
    assert!(
        !load_category_detail(&pool, household, automatic, &scopes)
            .await?
            .category
            .can_delete
    );
    assert!(delete_category(&pool, household, automatic).await.is_err());
    assert!(delete_group(&pool, household, source_group).await.is_err());
    let mut tx = tenant::begin(&pool, household, false).await?;
    sqlx::query("DELETE FROM properties WHERE id = $1")
        .bind(property)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    assert!(delete_group(&pool, household, source_group).await.is_err());

    let snapshot = snapshot_household(&pool, household).await?;
    restore_household(&pool, household, owner.user.id, &snapshot).await?;
    let board = load_board(&pool, household, &scopes, None, None).await?;
    assert!(
        board
            .groups
            .iter()
            .any(|g| g.id == group.id && g.is_retired && g.can_delete)
    );
    assert!(
        board
            .groups
            .iter()
            .any(|g| g.id == source_group && g.is_retired && !g.can_delete)
    );
    delete_category(&pool, household, category.id).await?;
    delete_group(&pool, household, group.id).await?;
    Ok(())
}
