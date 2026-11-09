use checkbook_postgres::{
    auth::create_development_session,
    connect,
    expenses::{
        ExpenseCategoryInput, ExpenseGroupInput, create_category, create_group, load_board,
        load_category_detail, update_category, update_group,
    },
    migrate,
    records::RecordsStoreError,
    tenant,
};
use uuid::Uuid;

#[tokio::test]
async fn source_linkage_uses_direct_assets_and_loans_not_delete_policy() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; expense source linkage test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    migrate(&pool).await?;
    let identity = Uuid::new_v4();
    let context = create_development_session(
        &pool,
        &format!("expense-source-linked-{identity}@example.com"),
        "Source Link Owner",
        "owner",
        24,
    )
    .await?;
    let household_id = context.household.id;
    let mut tx = tenant::begin(&pool, household_id, false).await?;
    let mut utility_property_ids = Vec::new();
    for (name, category) in [
        ("House", "property"),
        ("Car", "vehicle"),
        ("Other asset", "other"),
    ] {
        let property_id: Uuid = sqlx::query_scalar(
            "INSERT INTO properties (household_id, name, category, valuation, valuation_date, status, data_source, source_key)
             VALUES ($1, $2, $3, 100, CURRENT_DATE, 'active', 'app_manual', $4) RETURNING id",
        )
        .bind(household_id)
        .bind(name)
        .bind(category)
        .bind(format!("source-linked:{identity}:{category}"))
        .fetch_one(&mut *tx)
        .await?;
        if category == "property" {
            utility_property_ids.push(property_id);
        }
    }
    sqlx::query(
        "INSERT INTO projects (household_id, name, valuation_date, stored_status, data_source, source_key)
         VALUES ($1, 'Generic project', CURRENT_DATE, 'active', 'app_manual', $2)",
    )
    .bind(household_id)
    .bind(format!("source-linked:{identity}:project"))
    .execute(&mut *tx)
    .await?;
    let account_id: Uuid = sqlx::query_scalar(
        "INSERT INTO financial_accounts (household_id, name, account_kind, account_type, owner_scope, source_key)
         VALUES ($1, 'Loan account', 'liability', 'loan', 'joint', $2) RETURNING id",
    )
    .bind(household_id)
    .bind(format!("source-linked:{identity}:account"))
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO loans (household_id, account_id, name, liability_type, owner_scope, original_balance, current_balance, source_key)
         VALUES ($1, $2, 'Standalone loan', 'loan', 'joint', 100, 100, $3)",
    )
    .bind(household_id)
    .bind(account_id)
    .bind(format!("source-linked:{identity}:loan"))
    .execute(&mut *tx)
    .await?;
    for origin in ["manual", "automatic", "legacy_unknown"] {
        sqlx::query(
            "INSERT INTO expense_groups (household_id, name, normalized_name, creation_origin)
             VALUES ($1, $2, $2, $3)",
        )
        .bind(household_id)
        .bind(format!("unlinked {origin}"))
        .bind(origin)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO categories (household_id, kind, name, normalized_name, creation_origin)
             VALUES ($1, 'expense', $2, $2, $3)",
        )
        .bind(household_id)
        .bind(format!("unlinked {origin}"))
        .bind(origin)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    // A persisted namesake must still follow the normal category detail/edit flow.
    create_category(
        &pool,
        household_id,
        ExpenseCategoryInput {
            name: "Utilities".to_owned(),
            expense_group_id: None,
            sort_order: 0,
            is_retired: None,
        },
    )
    .await?;
    let scopes = vec!["joint".to_owned()];
    let board = load_board(&pool, household_id, &scopes, None, None).await?;
    let house = board
        .groups
        .iter()
        .find(|row| row.name == "House")
        .ok_or_else(|| anyhow::anyhow!("house group missing"))?;
    for group in &board.groups {
        assert_eq!(
            group.is_source_linked,
            matches!(group.name.as_str(), "House" | "Car"),
            "{}",
            group.name
        );
        if group.name != "unlinked manual" {
            assert!(!group.can_delete, "{}", group.name);
        }
        let updated = update_group(
            &pool,
            household_id,
            group.id,
            ExpenseGroupInput {
                name: group.name.clone(),
                color: group.color.clone(),
                notes: group.notes.clone(),
                sort_order: group.sort_order,
                is_retired: Some(true),
            },
        )
        .await?;
        assert_eq!(updated.is_source_linked, group.is_source_linked);
    }
    assert_eq!(board.utility_property_ids, utility_property_ids);
    for category in &board.categories {
        if board.utility_property_ids.contains(&category.id) {
            assert_eq!(category.name, "Utilities");
            assert!(category.is_source_linked);
            assert!(category.is_system);
            assert!(!category.can_delete);
            assert_eq!(category.parent_id, None);
            assert_eq!(category.expense_group_id, Some(house.id));
            // The synthetic category now projects a read-only bill history
            // instead of being unreachable from category detail.
            let utility_detail =
                load_category_detail(&pool, household_id, category.id, &scopes).await?;
            assert_eq!(utility_detail.category.id, category.id);
            assert!(utility_detail.category.is_source_linked);
            assert!(utility_detail.entries.is_empty());
            assert!(utility_detail.subcategories.is_empty());
            assert!(matches!(
                update_category(
                    &pool,
                    household_id,
                    category.id,
                    ExpenseCategoryInput {
                        name: "Edited utility projection".to_owned(),
                        expense_group_id: category.expense_group_id,
                        sort_order: category.sort_order,
                        is_retired: Some(true),
                    },
                )
                .await,
                Err(RecordsStoreError::NotFound)
            ));
            continue;
        }
        assert_eq!(
            category.is_source_linked,
            category.name == "Standalone loan",
            "{}",
            category.name
        );
        let detail = load_category_detail(&pool, household_id, category.id, &scopes).await?;
        assert_eq!(detail.category.is_source_linked, category.is_source_linked);
        let updated = update_category(
            &pool,
            household_id,
            category.id,
            ExpenseCategoryInput {
                name: category.name.clone(),
                expense_group_id: category.expense_group_id,
                sort_order: category.sort_order,
                is_retired: Some(true),
            },
        )
        .await?;
        assert_eq!(updated.is_source_linked, category.is_source_linked);
    }
    let mut tx = tenant::begin(&pool, household_id, true).await?;
    let stored_projections: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM categories WHERE household_id = $1 AND id = ANY($2)",
    )
    .bind(household_id)
    .bind(&utility_property_ids)
    .fetch_one(&mut *tx)
    .await?;
    assert_eq!(stored_projections, 0);
    tx.commit().await?;
    let manual_group = create_group(
        &pool,
        household_id,
        ExpenseGroupInput {
            name: "Manual group".to_owned(),
            color: String::new(),
            notes: String::new(),
            sort_order: 0,
            is_retired: None,
        },
    )
    .await?;
    assert!(!manual_group.is_source_linked);
    let manual_category = create_category(
        &pool,
        household_id,
        ExpenseCategoryInput {
            name: "Manual property member".to_owned(),
            expense_group_id: Some(house.id),
            sort_order: 0,
            is_retired: None,
        },
    )
    .await?;
    assert!(!manual_category.is_source_linked);
    let mut tx = tenant::begin(&pool, household_id, false).await?;
    let child_id: Uuid = sqlx::query_scalar(
        "INSERT INTO categories (household_id, kind, name, normalized_name, parent_id, is_system)
         VALUES ($1, 'expense', 'Protected child', 'protected child', $2, true) RETURNING id",
    )
    .bind(household_id)
    .bind(manual_category.id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let detail = load_category_detail(&pool, household_id, manual_category.id, &scopes).await?;
    assert!(!detail.category.is_source_linked);
    assert!(!detail.category.can_delete);
    let child = detail
        .subcategories
        .iter()
        .find(|row| row.id == child_id)
        .ok_or_else(|| anyhow::anyhow!("child missing"))?;
    assert!(!child.is_source_linked);
    assert!(!child.can_delete);

    let mut tx = tenant::begin(&pool, household_id, false).await?;
    sqlx::query("DELETE FROM loans WHERE household_id = $1")
        .bind(household_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM properties WHERE household_id = $1")
        .bind(household_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let detached = load_board(&pool, household_id, &scopes, None, None).await?;
    assert!(detached.groups.iter().all(|row| !row.is_source_linked));
    assert!(detached.categories.iter().all(|row| !row.is_source_linked));
    Ok(())
}
