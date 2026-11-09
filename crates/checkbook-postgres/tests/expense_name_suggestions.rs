use checkbook_postgres::{
    auth::create_development_session,
    connect,
    expenses::{
        ExpenseCategoryInput, ExpenseGroupInput, create_category, create_group,
        load_name_suggestions,
    },
    migrate, tenant,
};
use chrono::NaiveDate;
use sqlx::PgPool;
use uuid::Uuid;

async fn category(
    pool: &PgPool,
    household: Uuid,
    name: &str,
    group: Option<Uuid>,
    retired: bool,
) -> anyhow::Result<Uuid> {
    Ok(create_category(
        pool,
        household,
        ExpenseCategoryInput {
            name: name.to_owned(),
            expense_group_id: group,
            sort_order: 0,
            is_retired: Some(retired),
        },
    )
    .await?
    .id)
}

#[allow(clippy::too_many_arguments)]
async fn entry(
    pool: &PgPool,
    household: Uuid,
    category: Uuid,
    description: &str,
    scope: &str,
    date: &str,
    status: &str,
) -> anyhow::Result<()> {
    let mut tx = tenant::begin(pool, household, false).await?;
    sqlx::query("INSERT INTO ledger_entries (id, household_id, source_key, direction, status, amount, entry_date, description, owner_scope, data_source, category_id) VALUES ($1,$2,$3,'expense',$4,1,$5,$6,$7,'app_manual',$8)")
        .bind(Uuid::new_v4()).bind(household).bind(Uuid::new_v4().to_string()).bind(status)
        .bind(date.parse::<NaiveDate>()?).bind(description).bind(scope).bind(category)
        .execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

#[tokio::test]
async fn suggestions_rank_deduplicate_filter_and_bound_history() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set; expense suggestions test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    migrate(&pool).await?;
    let owner = create_development_session(
        &pool,
        &format!("suggestions-{}@example.com", Uuid::new_v4()),
        "Suggestions owner",
        "owner",
        24,
    )
    .await?;
    let other = create_development_session(
        &pool,
        &format!("suggestions-other-{}@example.com", Uuid::new_v4()),
        "Other owner",
        "owner",
        24,
    )
    .await?;
    let h = owner.household.id;
    let scopes = vec!["self".to_owned(), "joint".to_owned()];
    let today: NaiveDate = "2026-06-30".parse()?;
    let a = category(&pool, h, "Food", None, false).await?;
    let b = category(&pool, h, "Travel", None, false).await?;
    let retired = category(&pool, h, "Retired", None, true).await?;
    let group = create_group(
        &pool,
        h,
        ExpenseGroupInput {
            name: "Retired bucket".to_owned(),
            color: String::new(),
            notes: String::new(),
            sort_order: 0,
            is_retired: Some(true),
        },
    )
    .await?;
    let retired_group = category(&pool, h, "Inactive bucket item", Some(group.id), false).await?;
    let foreign = category(&pool, other.household.id, "Foreign", None, false).await?;
    for (cat, name, scope, date, status) in [
        (a, "  Coffee\t SHOP  ", "self", "2026-01-01", "actual"),
        (a, "coffee shop", "self", "2026-01-02", "actual"),
        (b, "COFFEE SHOP", "joint", "2026-02-01", "actual"),
        (a, "Coffee shop supplies", "self", "2026-04-01", "actual"),
        (a, "Best coffee shop", "self", "2026-06-01", "actual"),
        (a, "coffee shop planned", "self", "2026-06-01", "planned"),
        (a, "coffee shop future", "self", "2026-07-01", "actual"),
        (
            a,
            "coffee shop hidden scope",
            "spouse",
            "2026-06-01",
            "actual",
        ),
        (
            retired,
            "coffee shop retired",
            "self",
            "2026-06-01",
            "actual",
        ),
        (
            retired_group,
            "coffee shop retired bucket",
            "self",
            "2026-06-01",
            "actual",
        ),
    ] {
        entry(&pool, h, cat, name, scope, date, status).await?;
    }
    entry(
        &pool,
        other.household.id,
        foreign,
        "coffee shop foreign",
        "self",
        "2026-06-01",
        "actual",
    )
    .await?;
    let rows = load_name_suggestions(&pool, h, &scopes, " COFFEE \n SHOP ", today).await?;
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].description, "COFFEE SHOP");
    assert_eq!(rows[0].category_id, b);
    assert_eq!(rows[0].category_name, "Travel");
    assert_eq!(rows[0].expense_group_id, None);
    assert_eq!(rows[1].description, "Coffee shop supplies");
    assert_eq!(rows[2].description, "Best coffee shop");
    assert!(
        load_name_suggestions(&pool, h, &[], "coffee", today)
            .await?
            .is_empty()
    );
    for query in ["", " ", "c"] {
        assert!(
            load_name_suggestions(&pool, h, &scopes, query, today)
                .await?
                .is_empty()
        );
    }
    assert!(
        load_name_suggestions(&pool, h, &scopes, &"c".repeat(121), today)
            .await
            .is_err()
    );

    // Equal recency resolves a description to the most frequently used classification.
    for cat in [a, b, b] {
        entry(
            &pool,
            h,
            cat,
            "Frequency tie",
            "self",
            "2026-05-01",
            "actual",
        )
        .await?;
    }
    assert_eq!(
        load_name_suggestions(&pool, h, &scopes, "frequency", today).await?[0].category_id,
        b
    );
    for name in ["100%_\\ literal", "100XX literal"] {
        entry(&pool, h, a, name, "self", "2026-05-01", "actual").await?;
    }
    let literal = load_name_suggestions(&pool, h, &scopes, "%_\\", today).await?;
    assert_eq!(literal.len(), 1);
    assert_eq!(literal[0].description, "100%_\\ literal");
    for i in 0..12 {
        entry(
            &pool,
            h,
            a,
            &format!("Bounded {i:02}"),
            "self",
            "2026-05-01",
            "actual",
        )
        .await?;
    }
    let bounded = load_name_suggestions(&pool, h, &scopes, "bounded", today).await?;
    assert_eq!(bounded.len(), 8);
    assert_eq!(bounded[0].description, "Bounded 00");
    assert_eq!(bounded[7].description, "Bounded 07");

    // Historical child classifications resolve to the selectable root, unless retired.
    let child = Uuid::new_v4();
    let mut tx = tenant::begin(&pool, h, false).await?;
    sqlx::query("INSERT INTO categories (id, household_id, kind, name, normalized_name, parent_id) VALUES ($1,$2,'expense','Child','child',$3)")
        .bind(child).bind(h).bind(a).execute(&mut *tx).await?;
    tx.commit().await?;
    entry(
        &pool,
        h,
        child,
        "Child history",
        "self",
        "2026-05-01",
        "actual",
    )
    .await?;
    assert_eq!(
        load_name_suggestions(&pool, h, &scopes, "child", today).await?[0].category_id,
        a
    );
    // The normal ledger representation stores the root and child separately.
    let mut tx = tenant::begin(&pool, h, false).await?;
    sqlx::query("UPDATE ledger_entries SET category_id = $1, subcategory_id = $2 WHERE household_id = $3 AND description = 'Child history'")
        .bind(a).bind(child).bind(h).execute(&mut *tx).await?;
    tx.commit().await?;
    assert_eq!(
        load_name_suggestions(&pool, h, &scopes, "child", today).await?[0].category_id,
        a
    );
    let mut tx = tenant::begin(&pool, h, false).await?;
    sqlx::query("UPDATE categories SET is_retired = true WHERE household_id = $1 AND id = $2")
        .bind(h)
        .bind(child)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    assert!(
        load_name_suggestions(&pool, h, &scopes, "child", today)
            .await?
            .is_empty()
    );
    let mut tx = tenant::begin(&pool, h, false).await?;
    sqlx::query(
        "UPDATE categories SET is_retired = (id = $2) WHERE household_id = $1 AND id = ANY($3)",
    )
    .bind(h)
    .bind(a)
    .bind(vec![a, child])
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    assert!(
        load_name_suggestions(&pool, h, &scopes, "child", today)
            .await?
            .is_empty()
    );
    Ok(())
}
