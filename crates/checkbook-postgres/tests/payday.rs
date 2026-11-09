use checkbook_postgres::{
    auth::create_development_session,
    connect,
    payday::{self, Input},
    tenant,
};
use chrono::{NaiveDate, Utc};
use rust_decimal_macros::dec;
use uuid::Uuid;

fn input() -> Input {
    Input {
        position: None,
        title: "Reserve".into(),
        section: "mandatory".into(),
        kind: "savings".into(),
        expense_group_id: None,
        category_id: None,
        subcategory_id: None,
        amount: dec!(100.25),
        notes: "Snapshot".into(),
        completed: false,
        recurring: None,
        template_id: None,
        source_key: None,
    }
}

#[tokio::test]
async fn recurring_changes_are_forward_only_and_deleted_occurrences_stay_deleted()
-> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; recurring payday integration test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let owner = create_development_session(
        &pool,
        &format!("payday-recurring-{}@example.com", Uuid::new_v4()),
        "Planner",
        "owner",
        24,
    )
    .await?;
    let household = owner.household.id;
    let scopes = vec!["self".into(), "spouse".into(), "joint".into()];
    let past: NaiveDate = "2026-05-01".parse()?;
    let month: NaiveDate = "2026-06-01".parse()?;
    let future: NaiveDate = "2026-07-01".parse()?;
    let later: NaiveDate = "2026-08-01".parse()?;
    let unopened: NaiveDate = "2026-09-01".parse()?;
    let mut tx = tenant::begin(&pool, household, false).await?;
    let category: Uuid = sqlx::query_scalar("INSERT INTO categories (household_id,kind,name,normalized_name,creation_origin) VALUES ($1,'expense','Reserve','reserve','manual') RETURNING id")
        .bind(household).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    let other = create_development_session(
        &pool,
        &format!("payday-other-{}@example.com", Uuid::new_v4()),
        "Other",
        "owner",
        24,
    )
    .await?;
    for section in ["mandatory", "monthly", "flexible"] {
        // Initialize future months before marking a current allocation recurring.
        payday::load(&pool, household, future, month, &scopes).await?;
        payday::load(&pool, household, later, month, &scopes).await?;
        let mut value = input();
        value.section = section.into();
        value.category_id = Some(category);
        value.title = format!("Reserve {section}");
        value.position = Some(7);
        payday::save(&pool, household, month, None, &value, Utc::now()).await?;
        let current = payday::load(&pool, household, month, month, &scopes).await?;
        let id = current
            .allocations
            .iter()
            .find(|r| r.title == value.title)
            .ok_or_else(|| anyhow::anyhow!("missing allocation"))?
            .id;
        value.recurring = Some(true);
        payday::save(&pool, household, month, Some(id), &value, Utc::now()).await?;
        let current = payday::load(&pool, household, month, month, &scopes).await?;
        let original_template = current
            .allocations
            .iter()
            .find(|r| r.id == id)
            .and_then(|r| r.template_id)
            .ok_or_else(|| anyhow::anyhow!("missing template"))?;
        assert!(
            payday::load(&pool, household, past, month, &scopes)
                .await?
                .allocations
                .iter()
                .all(|r| r.title != value.title)
        );
        let next = payday::load(&pool, household, future, month, &scopes).await?;
        let next_id = next
            .allocations
            .iter()
            .find(|r| r.template_id == Some(original_template))
            .ok_or_else(|| anyhow::anyhow!("missing initialized future occurrence"))?
            .id;
        assert!(
            payday::save(
                &pool,
                other.household.id,
                month,
                Some(id),
                &value,
                Utc::now()
            )
            .await
            .is_err()
        );
        assert!(
            payday::delete(&pool, other.household.id, next_id, false)
                .await
                .is_err()
        );
        let mut invalid = value.clone();
        invalid.category_id = Some(Uuid::new_v4());
        assert!(
            payday::save(&pool, household, month, Some(id), &invalid, Utc::now())
                .await
                .is_err()
        );
        // Completion only must not revise the recurrence or complete future months.
        value.completed = true;
        value.position = None;
        payday::save(&pool, household, month, Some(id), &value, Utc::now()).await?;
        let next = payday::load(&pool, household, future, month, &scopes).await?;
        let next_row = next
            .allocations
            .iter()
            .find(|r| r.id == next_id)
            .ok_or_else(|| anyhow::anyhow!("missing occurrence"))?;
        assert_eq!(next_row.template_id, Some(original_template));
        assert_eq!(next_row.position, 7);
        assert!(next_row.completed_at.is_none());
        // A position-only edit must version recurrence just like financial details.
        value.completed = false;
        value.position = Some(3);
        payday::save(&pool, household, future, Some(next_id), &value, Utc::now()).await?;
        let reordered = payday::load(&pool, household, future, month, &scopes).await?;
        let reordered = reordered
            .allocations
            .iter()
            .find(|r| r.id == next_id)
            .ok_or_else(|| anyhow::anyhow!("missing reordered occurrence"))?;
        assert_eq!(reordered.position, 3);
        assert_ne!(reordered.template_id, Some(original_template));
        // An edit from July preserves June but updates already initialized August.
        value.position = Some(3);
        value.amount = dec!(222.22);
        value.notes = "July revision".into();
        value.completed = false;
        value.recurring = None;
        payday::save(&pool, household, future, Some(next_id), &value, Utc::now()).await?;
        let current = payday::load(&pool, household, month, month, &scopes).await?;
        let old = current
            .allocations
            .iter()
            .find(|r| r.id == id)
            .ok_or_else(|| anyhow::anyhow!("missing historical occurrence"))?;
        assert_eq!(old.amount, dec!(100.25));
        assert_eq!(old.position, 7);
        assert_eq!(old.template_id, Some(original_template));
        assert!(old.completed_at.is_some());
        let next = payday::load(&pool, household, later, month, &scopes).await?;
        let later_id = next
            .allocations
            .iter()
            .find(|r| r.title == value.title)
            .ok_or_else(|| anyhow::anyhow!("missing propagated occurrence"))?
            .id;
        assert_eq!(
            next.allocations
                .iter()
                .find(|r| r.id == later_id)
                .map(|r| r.amount),
            Some(dec!(222.22))
        );
        assert_eq!(
            next.allocations
                .iter()
                .find(|r| r.id == later_id)
                .map(|r| r.position),
            Some(3)
        );
        payday::delete(&pool, household, later_id, false).await?;
        assert!(
            payday::load(&pool, household, later, month, &scopes)
                .await?
                .allocations
                .iter()
                .all(|r| r.id != later_id)
        );
        // Edit an earlier version: all chained future versions follow it, except deletions.
        value.recurring = Some(true);
        value.position = Some(11);
        value.amount = dec!(333.33);
        payday::save(&pool, household, month, Some(id), &value, Utc::now()).await?;
        assert!(
            payday::load(&pool, household, later, month, &scopes)
                .await?
                .allocations
                .iter()
                .all(|r| r.title != value.title)
        );
        assert!(
            payday::load(&pool, household, unopened, month, &scopes)
                .await?
                .allocations
                .iter()
                .any(|r| r.title == value.title && r.amount == dec!(333.33) && r.position == 11)
        );
        // Unmark from July removes August/September, but preserves June and July.
        value.recurring = Some(false);
        payday::save(&pool, household, future, Some(next_id), &value, Utc::now()).await?;
        assert!(
            payday::load(&pool, household, unopened, month, &scopes)
                .await?
                .allocations
                .iter()
                .all(|r| r.title != value.title)
        );
        let current = payday::load(&pool, household, month, month, &scopes).await?;
        assert!(
            current
                .allocations
                .iter()
                .any(|r| r.id == id && r.template_id.is_some())
        );
        let next = payday::load(&pool, household, future, month, &scopes).await?;
        assert!(
            next.allocations
                .iter()
                .any(|r| r.id == next_id && r.template_id.is_none())
        );
        // Reviving an earlier linked version preserves explicit occurrence deletions.
        value.recurring = Some(true);
        value.amount = dec!(444.44);
        payday::save(&pool, household, month, Some(id), &value, Utc::now()).await?;
        assert!(
            payday::load(&pool, household, later, month, &scopes)
                .await?
                .allocations
                .iter()
                .all(|r| r.title != value.title)
        );
        assert!(
            payday::load(&pool, household, unopened, month, &scopes)
                .await?
                .allocations
                .iter()
                .any(|r| r.title == value.title && r.amount == dec!(444.44))
        );
        let unopened_past: NaiveDate = "2026-04-01".parse()?;
        assert!(
            payday::load(&pool, household, unopened_past, month, &scopes)
                .await?
                .allocations
                .iter()
                .all(|r| r.title != value.title)
        );
    }
    Ok(())
}

#[tokio::test]
async fn positions_validate_persist_and_sort_with_stable_ties() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; payday ordering integration test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let owner = create_development_session(
        &pool,
        &format!("payday-order-{}@example.com", Uuid::new_v4()),
        "Planner",
        "owner",
        24,
    )
    .await?;
    let household = owner.household.id;
    let month: NaiveDate = "2026-06-01".parse()?;
    let scopes = vec!["self".into(), "joint".into()];
    let mut value = input();
    value.section = "flexible".into();
    value.position = Some(-1);
    assert!(
        payday::save(&pool, household, month, None, &value, Utc::now())
            .await
            .is_err()
    );
    assert!(
        payday::save_template(&pool, household, None, &value)
            .await
            .is_err()
    );
    for (title, position) in [
        ("Z first", Some(0)),
        ("A last", Some(i32::MAX)),
        ("B tie", Some(2)),
        ("B tie", Some(2)),
        ("A tie", Some(2)),
        ("Default", None),
    ] {
        value.title = title.into();
        value.position = position;
        payday::save(&pool, household, month, None, &value, Utc::now()).await?;
        payday::save_template(&pool, household, None, &value).await?;
    }
    let records = payday::load(&pool, household, month, month, &scopes).await?;
    for rows in [&records.allocations, &records.templates] {
        assert_eq!(
            rows.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(),
            ["Default", "Z first", "A tie", "B tie", "B tie", "A last"]
        );
        assert_eq!(
            rows.iter().map(|r| r.position).collect::<Vec<_>>(),
            [0, 0, 2, 2, 2, i32::MAX]
        );
        assert!(rows[3].id < rows[4].id);
    }
    let row = &records.allocations[5];
    value.title = row.title.clone();
    value.position = None;
    payday::save(&pool, household, month, Some(row.id), &value, Utc::now()).await?;
    let template = &records.templates[5];
    payday::save_template(&pool, household, Some(template.id), &value).await?;
    let records = payday::load(&pool, household, month, month, &scopes).await?;
    assert_eq!(records.allocations[5].position, i32::MAX);
    assert_eq!(records.templates[5].position, i32::MAX);
    Ok(())
}

#[tokio::test]
async fn snapshots_completion_idempotence_and_rls() -> anyhow::Result<()> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL missing; payday integration test skipped");
        return Ok(());
    };
    let pool = connect(&url, 5).await?;
    let owner = create_development_session(
        &pool,
        &format!("payday-{}@example.com", Uuid::new_v4()),
        "Planner",
        "owner",
        24,
    )
    .await?;
    let other = create_development_session(
        &pool,
        &format!("payday-{}@example.com", Uuid::new_v4()),
        "Other",
        "owner",
        24,
    )
    .await?;
    let household = owner.household.id;
    let month: NaiveDate = "2026-06-01".parse()?;
    let scopes = vec!["self".into(), "spouse".into(), "joint".into()];
    let mut value = input();
    let mut tx = tenant::begin(&pool, household, false).await?;
    let category:Uuid=sqlx::query_scalar("INSERT INTO categories (household_id,kind,name,normalized_name,creation_origin) VALUES ($1,'expense','Reserve','reserve','manual') RETURNING id").bind(household).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    value.category_id = Some(category);
    let template = payday::save_template(&pool, household, None, &value).await?;
    let initial = payday::load(&pool, household, month, month, &scopes).await?;
    assert_eq!(initial.allocations.len(), 1);
    let id = initial.allocations[0].id;
    value.amount = dec!(999);
    payday::save_template(&pool, household, Some(template), &value).await?;
    let unchanged = payday::load(&pool, household, month, month, &scopes).await?;
    assert_eq!(unchanged.allocations[0].amount, dec!(100.25));
    let added_template = payday::save_template(&pool, household, None, &value).await?;
    assert_eq!(
        payday::load(&pool, household, month, month, &scopes)
            .await?
            .allocations
            .len(),
        1,
        "adding templates cannot mutate existing months"
    );
    payday::delete(&pool, household, added_template, true).await?;
    payday::delete(&pool, household, template, true).await?;
    let preserved = payday::load(&pool, household, month, month, &scopes).await?;
    assert_eq!(preserved.allocations[0].id, id);
    assert_eq!(preserved.allocations[0].title, "Reserve");
    assert!(preserved.allocations[0].template_id.is_none());
    value.completed = true;
    payday::save(&pool, household, month, Some(id), &value, Utc::now()).await?;
    let completed = payday::load(&pool, household, month, month, &scopes).await?;
    assert!(completed.allocations[0].completed_at.is_some());
    let mut tx = tenant::begin(&pool, household, true).await?;
    let expenses: i64 =
        sqlx::query_scalar("SELECT count(*) FROM ledger_entries WHERE household_id=$1")
            .bind(household)
            .fetch_one(&mut *tx)
            .await?;
    assert_eq!(expenses, 0, "completion must never create an expense");
    tx.commit().await?;
    let next: NaiveDate = "2026-07-01".parse()?;
    let new_template = payday::save_template(&pool, household, None, &value).await?;
    let next_records = payday::load(&pool, household, next, next, &scopes).await?;
    let next_id = next_records
        .allocations
        .first()
        .ok_or_else(|| anyhow::anyhow!("missing snapshot"))?
        .id;
    payday::delete(&pool, household, next_id, false).await?;
    assert!(
        payday::load(&pool, household, next, next, &scopes)
            .await?
            .allocations
            .is_empty(),
        "deleted snapshots must not reappear"
    );
    payday::delete(&pool, household, new_template, true).await?;
    value.title = "Selected additional reserve".into();
    value.source_key = Some("explicit:selected".into());
    payday::apply(
        &pool,
        household,
        month,
        &[value.clone(), value.clone()],
        Utc::now(),
    )
    .await?;
    payday::apply(&pool, household, month, &[value.clone()], Utc::now()).await?;
    let applied = payday::load(&pool, household, month, month, &scopes).await?;
    assert_eq!(applied.allocations.len(), 2);
    let outsider = payday::load(&pool, other.household.id, month, month, &scopes).await?;
    assert!(outsider.allocations.is_empty());
    assert!(
        payday::save(
            &pool,
            other.household.id,
            month,
            Some(id),
            &value,
            Utc::now()
        )
        .await
        .is_err()
    );
    let mut tx = tenant::begin(&pool, other.household.id, true).await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM payday_allocations WHERE id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    assert_eq!(
        count, 0,
        "forced RLS must hide another household's snapshot"
    );
    tx.commit().await?;
    let mut tx = tenant::begin(&pool, household, false).await?;
    sqlx::query("DELETE FROM categories WHERE household_id=$1 AND id=$2")
        .bind(household)
        .bind(category)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    value.category_id = None;
    value.notes = "Updated after category deletion".into();
    payday::save(&pool, household, month, Some(id), &value, Utc::now()).await?;
    let orphan = payday::load(&pool, household, month, month, &scopes).await?;
    let snapshot = orphan
        .allocations
        .iter()
        .find(|row| row.id == id)
        .ok_or_else(|| anyhow::anyhow!("orphan snapshot missing"))?;
    assert_eq!(snapshot.category_name.as_deref(), Some("Reserve"));
    assert!(snapshot.completed_at.is_some());
    assert!(
        payday::save(&pool, household, month, None, &value, Utc::now())
            .await
            .is_err()
    );
    Ok(())
}
