use checkbook_postgres::{
    auth::create_development_session,
    connect,
    expenses::{
        ExpenseCategoryInput, ExpenseEntryUpdateInput, delete_category, delete_expense_entry,
        load_board, load_category_detail, update_category, update_expense_entry,
    },
    records::RecordsStoreError,
    tenant,
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use uuid::Uuid;

#[tokio::test]
async fn property_utilities_are_read_only_scope_filtered_expenses() -> anyhow::Result<()> {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; utility expenses test skipped");
        return Ok(());
    };
    let pool = connect(&database_url, 5).await?;
    let identity = Uuid::new_v4();
    let context = create_development_session(
        &pool,
        &format!("utility-expenses-{identity}@example.com"),
        "Utility expenses owner",
        "owner",
        24,
    )
    .await?;
    let household_id = context.household.id;
    let mut tx = tenant::begin(&pool, household_id, false).await?;
    let mut properties = Vec::new();
    for index in 0..4 {
        let id = sqlx::query_scalar!(
            "INSERT INTO properties (household_id, name, category, valuation, valuation_date,
                 status, data_source, source_key, utilities_enabled, expenses_enabled)
             VALUES ($1, $2, 'property', 100, CURRENT_DATE, 'active', 'app_manual', $3, $4, $5)
             RETURNING id",
            household_id,
            format!("Utility house {index}"),
            format!("utility-expenses:{identity}:{index}"),
            index != 2,
            index != 3
        )
        .fetch_one(&mut *tx)
        .await?;
        properties.push(id);
    }
    let service_id = sqlx::query_scalar!(
        "INSERT INTO utility_services (household_id, service_key, label, service_kind)
         VALUES ($1, 'utility-expenses-test', 'Electricity', 'cost') RETURNING id",
        household_id
    )
    .fetch_one(&mut *tx)
    .await?;
    for (index, date, scope, cents) in [
        (0, "2024-01-05", "joint", 101_i64),
        (0, "2024-01-10", "joint", 202),
        (0, "2024-02-01", "joint", 304),
        (0, "2024-03-01", "spouse", 999),
        (2, "2024-04-01", "joint", 999),
        (3, "2024-05-01", "joint", 999),
    ] {
        let charge_date = NaiveDate::parse_from_str(date, "%Y-%m-%d")?;
        sqlx::query!(
            "INSERT INTO utility_bills (household_id, property_id, service_id, provider,
                 description, amount, charge_date, owner_scope, data_source, source_key)
             VALUES ($1, $2, $3, 'Provider', 'Bill', $4, $5, $6, 'app_manual', $7)",
            household_id,
            properties[index],
            service_id,
            Decimal::new(cents, 2),
            charge_date,
            scope,
            format!("utility-expenses:{identity}:{index}:{date}")
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    let scopes = vec!["joint".to_owned()];
    let board = load_board(&pool, household_id, &scopes, None, None).await?;
    assert_eq!(board.utility_property_ids.len(), 2);
    assert!(board.utility_property_ids.contains(&properties[0]));
    assert!(board.utility_property_ids.contains(&properties[1]));
    for property_id in &properties[..2] {
        let category = board
            .categories
            .iter()
            .find(|row| row.id == *property_id)
            .ok_or_else(|| anyhow::anyhow!("projected category missing"))?;
        assert_eq!(category.name, "Utilities");
        assert!(category.is_source_linked);
        assert!(category.is_system);
        assert!(!category.can_delete);
        assert!(category.expense_group_id.is_some());
    }
    let stats = board
        .stats
        .iter()
        .find(|row| row.category_id == properties[0])
        .ok_or_else(|| anyhow::anyhow!("utility stats missing"))?;
    assert_eq!(stats.total_amount, Decimal::new(607, 2));
    assert_eq!(stats.entry_count, 3);
    assert_eq!(stats.month_count, 2);
    assert_eq!(
        board.last_actual_entry_date,
        Some(NaiveDate::parse_from_str("2024-02-01", "%Y-%m-%d")?)
    );
    let monthly: Vec<_> = board
        .monthly_totals
        .iter()
        .filter(|row| row.category_id == Some(properties[0]))
        .collect();
    assert_eq!(monthly.len(), 2);
    assert_eq!(monthly[0].amount, Decimal::new(303, 2));
    assert_eq!(monthly[1].amount, Decimal::new(304, 2));
    let start = NaiveDate::parse_from_str("2024-01-06", "%Y-%m-%d")?;
    let end = NaiveDate::parse_from_str("2024-01-31", "%Y-%m-%d")?;
    let filtered = load_board(&pool, household_id, &scopes, Some(start), Some(end)).await?;
    let stats = filtered
        .stats
        .iter()
        .find(|row| row.category_id == properties[0])
        .ok_or_else(|| anyhow::anyhow!("filtered utility stats missing"))?;
    assert_eq!(stats.total_amount, Decimal::new(202, 2));
    assert_eq!(stats.entry_count, 1);
    // Detail ignores the board's selected range and keeps each canonical bill intact.
    let detail = load_category_detail(&pool, household_id, properties[0], &scopes).await?;
    assert_eq!(detail.category.id, properties[0]);
    assert_eq!(detail.category.name, "Utilities");
    assert!(detail.category.is_system);
    assert!(detail.category.is_source_linked);
    assert!(!detail.category.can_delete);
    assert!(detail.category.expense_group_id.is_some());
    assert!(detail.subcategories.is_empty());
    assert_eq!(detail.entries.len(), 3);
    assert_eq!(detail.monthly_totals.len(), 2);
    for (actual, expected) in detail.monthly_totals.iter().zip(&monthly) {
        assert_eq!(actual.period, expected.period);
        assert_eq!(actual.amount, expected.amount);
    }
    for (entry, date, amount) in [
        (&detail.entries[0], "2024-02-01", 304),
        (&detail.entries[1], "2024-01-10", 202),
        (&detail.entries[2], "2024-01-05", 101),
    ] {
        assert_eq!(entry.description, "Bill");
        assert_eq!(
            entry.entry_date,
            Some(NaiveDate::parse_from_str(date, "%Y-%m-%d")?)
        );
        assert_eq!(entry.amount, Decimal::new(amount, 2));
        assert_eq!(entry.owner_scope, "joint");
        assert_eq!(entry.data_source, "utility_bill");
        assert_eq!(entry.category_id, Some(properties[0]));
        assert_eq!(entry.subcategory_id, None);
        assert_eq!(entry.extra_payload["read_only"], true);
        assert_eq!(
            entry.extra_payload["linked_property_id"],
            properties[0].to_string()
        );
    }
    let all_scopes = vec!["joint".to_owned(), "spouse".to_owned()];
    let all = load_category_detail(&pool, household_id, properties[0], &all_scopes).await?;
    assert_eq!(all.entries.len(), 4);
    assert_eq!(all.monthly_totals.len(), 3);
    assert_eq!(all.entries[0].owner_scope, "spouse");
    let hidden_detail = load_category_detail(&pool, household_id, properties[0], &[]).await?;
    assert!(hidden_detail.entries.is_empty());
    assert!(hidden_detail.monthly_totals.is_empty());
    let empty_detail = load_category_detail(&pool, household_id, properties[1], &scopes).await?;
    assert!(empty_detail.entries.is_empty());
    assert!(empty_detail.monthly_totals.is_empty());
    for id in [properties[2], properties[3], Uuid::new_v4()] {
        assert!(matches!(
            load_category_detail(&pool, household_id, id, &scopes).await,
            Err(RecordsStoreError::NotFound)
        ));
    }
    let other = create_development_session(
        &pool,
        &format!("utility-expenses-other-{identity}@example.com"),
        "Other utility owner",
        "owner",
        24,
    )
    .await?;
    assert!(matches!(
        load_category_detail(&pool, other.household.id, properties[0], &all_scopes).await,
        Err(RecordsStoreError::NotFound)
    ));
    assert!(matches!(
        update_category(
            &pool,
            household_id,
            properties[0],
            ExpenseCategoryInput {
                name: "Changed".to_owned(),
                expense_group_id: None,
                sort_order: 0,
                is_retired: None,
            },
        )
        .await,
        Err(RecordsStoreError::NotFound)
    ));
    assert!(matches!(
        delete_category(&pool, household_id, properties[0]).await,
        Err(RecordsStoreError::NotFound)
    ));
    assert!(matches!(
        update_expense_entry(
            &pool,
            household_id,
            detail.entries[0].id,
            ExpenseEntryUpdateInput {
                amount: Decimal::ONE,
                entry_date: detail.entries[0].entry_date,
                description: "Changed".to_owned(),
                notes: String::new(),
                owner_scope: "joint".to_owned(),
                category_id: None,
                subcategory_id: None,
                allowed_scopes: scopes.clone(),
            },
        )
        .await,
        Err(RecordsStoreError::NotFound)
    ));
    assert!(matches!(
        delete_expense_entry(&pool, household_id, detail.entries[0].id, &scopes).await,
        Err(RecordsStoreError::NotFound)
    ));
    let unchanged = load_category_detail(&pool, household_id, properties[0], &scopes).await?;
    assert_eq!(unchanged.entries[0].amount, Decimal::new(304, 2));
    // Utilities history must not inherit the manual-ledger 200-row detail limit.
    let mut tx = tenant::begin(&pool, household_id, false).await?;
    for index in 0..201 {
        sqlx::query!(
            "INSERT INTO utility_bills (household_id, property_id, service_id, provider,
                 description, amount, charge_date, owner_scope, data_source, source_key)
             VALUES ($1, $2, $3, 'Provider', 'Bill', $4, $5, $6, 'app_manual', $7)",
            household_id,
            properties[1],
            service_id,
            Decimal::new(1, 2),
            start,
            "joint",
            format!("utility-expenses:{identity}:history:{index}")
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    let history = load_category_detail(&pool, household_id, properties[1], &scopes).await?;
    assert_eq!(history.entries.len(), 201);
    assert_eq!(history.monthly_totals.len(), 1);
    assert_eq!(history.monthly_totals[0].amount, Decimal::new(201, 2));
    let hidden = load_board(&pool, household_id, &[], None, None).await?;
    assert!(
        hidden
            .stats
            .iter()
            .all(|row| row.total_amount == Decimal::ZERO)
    );
    let mut tx = tenant::begin(&pool, household_id, true).await?;
    let count = sqlx::query_scalar!(
        "SELECT count(*) AS \"count!\" FROM ledger_entries WHERE household_id = $1",
        household_id
    )
    .fetch_one(&mut *tx)
    .await?;
    assert_eq!(count, 0);
    let stored_categories = sqlx::query_scalar!(
        "SELECT count(*) AS \"count!\" FROM categories WHERE household_id = $1 AND id = ANY($2)",
        household_id,
        &properties
    )
    .fetch_one(&mut *tx)
    .await?;
    assert_eq!(stored_categories, 0);
    tx.commit().await?;
    Ok(())
}
