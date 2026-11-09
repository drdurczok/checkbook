use std::collections::BTreeMap;

use checkbook_domain::shift_month_start;
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{planning::PlanningStoreError, tenant};

type Error = PlanningStoreError;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Item {
    pub position: i32,
    pub id: Uuid,
    pub template_id: Option<Uuid>,
    pub title: String,
    pub section: String,
    pub kind: String,
    pub expense_group_id: Option<Uuid>,
    pub category_id: Option<Uuid>,
    pub subcategory_id: Option<Uuid>,
    pub expense_group_name: Option<String>,
    pub category_name: Option<String>,
    pub subcategory_name: Option<String>,
    pub amount: Decimal,
    pub notes: String,
    pub source: String,
    pub completed_at: Option<DateTime<Utc>>,
    pub source_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Input {
    pub position: Option<i32>,
    pub title: String,
    pub section: String,
    pub kind: String,
    pub expense_group_id: Option<Uuid>,
    pub category_id: Option<Uuid>,
    pub subcategory_id: Option<Uuid>,
    pub amount: Decimal,
    pub notes: String,
    pub completed: bool,
    pub recurring: Option<bool>,
    pub template_id: Option<Uuid>,
    pub source_key: Option<String>,
}

#[derive(Debug)]
pub struct Actual {
    pub expense_group_id: Option<Uuid>,
    pub category_id: Option<Uuid>,
    pub subcategory_id: Option<Uuid>,
    pub expense_group_name: Option<String>,
    pub category_name: Option<String>,
    pub subcategory_name: Option<String>,
    pub month: NaiveDate,
    pub amount: Decimal,
}

pub struct Records {
    pub allocations: Vec<Item>,
    pub templates: Vec<Item>,
    pub history: Vec<(NaiveDate, Item)>,
    pub actuals: Vec<Actual>,
    pub income: Decimal,
    pub currency: String,
}

fn aggregate_actuals(rows: Vec<Actual>) -> Vec<Actual> {
    let mut buckets = BTreeMap::new();
    for row in rows {
        let key = (row.month, row.category_id, row.subcategory_id);
        let bucket = buckets.entry(key).or_insert_with(|| Actual {
            expense_group_id: row.expense_group_id,
            expense_group_name: row.expense_group_name,
            category_id: row.category_id,
            subcategory_id: row.subcategory_id,
            category_name: row.category_name,
            subcategory_name: row.subcategory_name,
            month: row.month,
            amount: Decimal::ZERO,
        });
        bucket.amount += row.amount;
    }
    buckets.into_values().collect()
}

fn shift(month: NaiveDate, delta: i32) -> Result<NaiveDate, Error> {
    shift_month_start(month, delta).map_err(|error| Error::Validation(error.to_string()))
}

async fn initialize(
    tx: &mut Transaction<'_, Postgres>,
    household: Uuid,
    month: NaiveDate,
) -> Result<Uuid, Error> {
    let inserted = sqlx::query!("INSERT INTO payday_months (household_id, month) VALUES ($1,$2) ON CONFLICT (household_id, month) DO NOTHING RETURNING id", household, month).fetch_optional(&mut **tx).await?;
    let Some(inserted) = inserted else {
        return Ok(sqlx::query!(
            "SELECT id FROM payday_months WHERE household_id=$1 AND month=$2",
            household,
            month
        )
        .fetch_one(&mut **tx)
        .await?
        .id);
    };
    let id = inserted.id;
    // Initialize once: explicitly deleted occurrences must not reappear on reload.
    sqlx::query!("INSERT INTO payday_allocations (household_id, month_id, template_id, title, section, position, kind, expense_group_id, expense_group_name, category_id, subcategory_id, category_name, subcategory_name, amount, notes, source, source_key) SELECT household_id, $2, id, title, section, position, kind, expense_group_id, expense_group_name, category_id, subcategory_id, category_name, subcategory_name, amount, notes, 'template', 'template:' || recurrence_id::text FROM payday_templates WHERE household_id=$1 AND starts_on <= $3 AND (ends_before IS NULL OR ends_before > $3) ON CONFLICT (household_id, month_id, source_key) DO NOTHING", household, id, month).execute(&mut **tx).await?;
    Ok(id)
}

pub async fn load(
    pool: &PgPool,
    household: Uuid,
    month: NaiveDate,
    current_month: NaiveDate,
    scopes: &[String],
) -> Result<Records, Error> {
    let mut tx = tenant::begin(pool, household, false).await?;
    let id = initialize(&mut tx, household, month).await?;
    let allocations = sqlx::query_as!(Item, "SELECT id, template_id, title, section, position, kind, expense_group_id, expense_group_name, category_id, subcategory_id, category_name, subcategory_name, amount, notes, source, completed_at, source_key FROM payday_allocations WHERE household_id=$1 AND month_id=$2 AND deleted_at IS NULL ORDER BY section,position,title,id", household, id).fetch_all(&mut *tx).await?;
    let templates = sqlx::query_as!(Item, "SELECT id, NULL::uuid AS template_id, title, section, position, kind, expense_group_id, expense_group_name, category_id, subcategory_id, category_name, subcategory_name, amount, notes, 'template'::text AS \"source!\", NULL::timestamptz AS completed_at, NULL::text AS source_key FROM payday_templates WHERE household_id=$1 AND starts_on <= $2 AND (ends_before IS NULL OR ends_before > $2) ORDER BY section,position,title,id", household, month).fetch_all(&mut *tx).await?;
    let end = month.min(current_month);
    let start = shift(end, -3)?;
    let next = shift(month, 1)?;
    let rows = sqlx::query!("SELECT a.id, a.template_id, a.title, a.section, a.position, a.kind, a.expense_group_id, a.expense_group_name, a.category_id, a.subcategory_id, a.category_name, a.subcategory_name, a.amount, a.notes, a.source, a.completed_at, a.source_key, m.month FROM payday_allocations a JOIN payday_months m ON m.household_id=a.household_id AND m.id=a.month_id WHERE a.household_id=$1 AND a.deleted_at IS NULL AND m.month >= $2 AND m.month < $3 ORDER BY m.month DESC, a.completed_at DESC NULLS LAST, a.id", household, start, end).fetch_all(&mut *tx).await?;
    let history = rows
        .into_iter()
        .map(|r| {
            (
                r.month,
                Item {
                    id: r.id,
                    template_id: r.template_id,
                    title: r.title,
                    section: r.section,
                    position: r.position,
                    kind: r.kind,
                    expense_group_id: r.expense_group_id,
                    expense_group_name: r.expense_group_name,
                    category_id: r.category_id,
                    subcategory_id: r.subcategory_id,
                    category_name: r.category_name,
                    subcategory_name: r.subcategory_name,
                    amount: r.amount,
                    notes: r.notes,
                    source: r.source,
                    completed_at: r.completed_at,
                    source_key: r.source_key,
                },
            )
        })
        .collect();
    let actuals = sqlx::query!("SELECT e.category_id,e.subcategory_id,c.name AS \"category_name?\",s.name AS \"subcategory_name?\",date_trunc('month',e.entry_date)::date AS \"month!\",sum(e.amount)::numeric AS \"amount!\" FROM ledger_entries e LEFT JOIN categories c ON c.household_id=e.household_id AND c.id=e.category_id LEFT JOIN categories s ON s.household_id=e.household_id AND s.id=e.subcategory_id WHERE e.household_id=$1 AND e.status='actual' AND e.direction='expense' AND e.owner_scope=ANY($2) AND ((e.entry_date >= $3 AND e.entry_date < $4) OR (e.entry_date >= $5 AND e.entry_date < $6)) GROUP BY e.category_id,e.subcategory_id,c.name,s.name,date_trunc('month',e.entry_date)", household, scopes, month, next, start, end).fetch_all(&mut *tx).await?.into_iter().map(|r| Actual {expense_group_id:None,expense_group_name:None,category_id:r.category_id,subcategory_id:r.subcategory_id,category_name:r.category_name,subcategory_name:r.subcategory_name,month:r.month,amount:r.amount}).collect();
    // Match Expenses' canonical loan projection, including its actual-payment replacement rules.
    let loan_entries = crate::expenses::load_loan_expenses(
        &mut tx,
        household,
        scopes,
        None,
        Some(start.min(month)),
        next.max(end).pred_opt(),
    )
    .await?;
    let mut actuals: Vec<Actual> = actuals;
    for entry in loan_entries {
        let Some(date) = entry.entry_date else {
            continue;
        };
        if !((date >= month && date < next) || (date >= start && date < end)) {
            continue;
        }
        actuals.push(Actual {
            expense_group_id: None,
            expense_group_name: None,
            category_id: entry.category_id,
            subcategory_id: entry.subcategory_id,
            category_name: Some(entry.description),
            subcategory_name: None,
            month: checkbook_domain::month_start(date)
                .map_err(|error| Error::Validation(error.to_string()))?,
            amount: entry.amount,
        });
    }
    let groups = sqlx::query!("SELECT c.id, g.id AS expense_group_id, g.name FROM categories c JOIN expense_groups g ON g.household_id=c.household_id AND g.id=c.expense_group_id WHERE c.household_id=$1", household).fetch_all(&mut *tx).await?;
    for actual in &mut actuals {
        if let Some(group) = groups
            .iter()
            .find(|group| Some(group.id) == actual.category_id)
        {
            actual.expense_group_id = Some(group.expense_group_id);
            actual.expense_group_name = Some(group.name.clone());
        }
    }
    let actuals = aggregate_actuals(actuals);
    let income = sqlx::query!("SELECT COALESCE(sum(COALESCE(CASE WHEN COALESCE(extra_payload->'payslip'->>'netPayable', extra_payload->>'netPayable') ~ '^[0-9]+([.][0-9]+)?$' THEN COALESCE(extra_payload->'payslip'->>'netPayable', extra_payload->>'netPayable')::numeric END, amount)),0)::numeric AS \"amount!\" FROM ledger_entries WHERE household_id=$1 AND direction='income' AND status='actual' AND owner_scope=ANY($2) AND entry_date >= $3 AND entry_date < $4", household, scopes, month, next).fetch_one(&mut *tx).await?.amount;
    let currency = sqlx::query!(
        "SELECT base_currency FROM households WHERE id=$1",
        household
    )
    .fetch_one(&mut *tx)
    .await?
    .base_currency;
    tx.commit().await?;
    Ok(Records {
        allocations,
        templates,
        history,
        actuals,
        income,
        currency,
    })
}

async fn validate(
    tx: &mut Transaction<'_, Postgres>,
    household: Uuid,
    input: &Input,
) -> Result<(Option<Uuid>, Option<String>, Option<String>, Option<String>), Error> {
    if input.title.trim().is_empty()
        || input.title.len() > 200
        || input.position.is_some_and(|position| position < 0)
        || input.amount < Decimal::ZERO
        || input.amount.scale() > 2
        || !["mandatory", "monthly", "flexible"].contains(&input.section.as_str())
        || !["expense", "savings", "transfer", "other"].contains(&input.kind.as_str())
        || (input.category_id.is_none()
            && (input.subcategory_id.is_some()
                || (input.expense_group_id.is_none() && input.section != "flexible")))
        || (input.expense_group_id.is_some() && input.kind != "expense")
    {
        return Err(Error::Validation("invalid allocation".into()));
    }
    let category = sqlx::query!("SELECT id,name,parent_id,expense_group_id FROM categories WHERE household_id=$1 AND id=$2 AND kind='expense'", household,input.category_id).fetch_optional(&mut **tx).await?;
    let child = sqlx::query!("SELECT id,name,parent_id FROM categories WHERE household_id=$1 AND id=$2 AND kind='expense'", household,input.subcategory_id).fetch_optional(&mut **tx).await?;
    if (input.category_id.is_some() && category.as_ref().is_none_or(|row| row.parent_id.is_some()))
        || (input.subcategory_id.is_some()
            && child
                .as_ref()
                .is_none_or(|c| c.parent_id != input.category_id))
    {
        return Err(Error::Validation("invalid category hierarchy".into()));
    }
    let expense_group_id = input
        .expense_group_id
        .or(category.as_ref().and_then(|row| row.expense_group_id));
    let group = sqlx::query!(
        "SELECT id,name FROM expense_groups WHERE household_id=$1 AND id=$2",
        household,
        expense_group_id
    )
    .fetch_optional(&mut **tx)
    .await?;
    if (expense_group_id.is_some() && group.is_none())
        || (input.expense_group_id.is_some()
            && category
                .as_ref()
                .is_some_and(|row| row.expense_group_id != input.expense_group_id))
    {
        return Err(Error::Validation("invalid expense group hierarchy".into()));
    }
    Ok((
        expense_group_id,
        group.map(|row| row.name),
        category.map(|r| r.name),
        child.map(|r| r.name),
    ))
}

pub async fn save(
    pool: &PgPool,
    household: Uuid,
    month: NaiveDate,
    id: Option<Uuid>,
    input: &Input,
    now: DateTime<Utc>,
) -> Result<(), Error> {
    let mut tx = tenant::begin(pool, household, false).await?;
    save_in(&mut tx, household, month, id, input, now).await?;
    tx.commit().await?;
    Ok(())
}

async fn save_in(
    tx: &mut Transaction<'_, Postgres>,
    household: Uuid,
    month: NaiveDate,
    id: Option<Uuid>,
    input: &Input,
    now: DateTime<Utc>,
) -> Result<(), Error> {
    let month_id = initialize(tx, household, month).await?;
    let previous = if let Some(id) = id {
        Some(sqlx::query_as!(Item, "SELECT id, template_id, title, section, position, kind, expense_group_id, expense_group_name, category_id, subcategory_id, category_name, subcategory_name, amount, notes, source, completed_at, source_key FROM payday_allocations WHERE household_id=$1 AND month_id=$2 AND deleted_at IS NULL ORDER BY section,position,title,id", household, month_id).fetch_all(&mut **tx).await?.into_iter().find(|row|row.id==id).ok_or(Error::NotFound("allocation"))?)
    } else {
        None
    };
    let mut input = input.clone();
    input.position = Some(
        input
            .position
            .or(previous.as_ref().map(|row| row.position))
            .unwrap_or_default(),
    );
    let input = &input;
    // Deleted category references must not prevent editing a preserved snapshot.
    let orphan = previous.as_ref().filter(|row| {
        row.category_id.is_none()
            && (row.category_name.is_some()
                || (row.expense_group_id.is_none() && row.expense_group_name.is_some()))
            && input.expense_group_id == row.expense_group_id
            && input.category_id.is_none()
            && input.subcategory_id.is_none()
            && row.section == input.section
            && row.kind == input.kind
    });
    let mut validated = input.clone();
    if orphan.is_some() {
        validated.section = "flexible".into();
    }
    let (expense_group_id, expense_group_name, category_name, subcategory_name) =
        validate(tx, household, &validated).await?;
    let (expense_group_name, category_name, subcategory_name) = if let Some(row) = orphan {
        (
            row.expense_group_name.clone(),
            row.category_name.clone(),
            row.subcategory_name.clone(),
        )
    } else {
        (expense_group_name, category_name, subcategory_name)
    };
    // Existing snapshots, not client-supplied IDs, determine which recurrence is edited.
    let linked_template = previous
        .as_ref()
        .map_or(input.template_id, |row| row.template_id);
    let template_id = match input.recurring {
        Some(true) | None
            if (input.recurring == Some(true) || linked_template.is_some())
                && previous.as_ref().is_none_or(|row| {
                    row.template_id.is_none()
                        || !same_details(
                            row,
                            input,
                            expense_group_id,
                            &expense_group_name,
                            &category_name,
                            &subcategory_name,
                        )
                }) =>
        {
            Some(
                revise_recurrence(
                    tx,
                    household,
                    month,
                    linked_template,
                    input,
                    (
                        expense_group_id,
                        expense_group_name.clone(),
                        category_name.clone(),
                        subcategory_name.clone(),
                    ),
                )
                .await?,
            )
        }
        Some(false) => {
            if let Some(template_id) = linked_template {
                end_recurrence(tx, household, month, template_id).await?;
            }
            None
        }
        _ => linked_template,
    };
    let completed_at = input.completed.then_some(now);
    if let Some(id) = id {
        let affected=sqlx::query!("UPDATE payday_allocations SET title=$3,section=$4,kind=$5,category_id=$6,subcategory_id=$7,category_name=$8,subcategory_name=$9,amount=$10,notes=$11,completed_at=CASE WHEN $12::timestamptz IS NULL THEN NULL ELSE COALESCE(completed_at,$12) END,template_id=$13,expense_group_id=$14,expense_group_name=$15,position=$16 WHERE household_id=$1 AND id=$2",household,id,input.title,input.section,input.kind,input.category_id,input.subcategory_id,category_name,subcategory_name,input.amount,input.notes,completed_at,template_id,expense_group_id,expense_group_name,input.position).execute(&mut **tx).await?.rows_affected();
        if affected == 0 {
            return Err(Error::NotFound("allocation"));
        }
    } else {
        let source = if input.source_key.is_some() {
            "suggestion"
        } else if template_id.is_some() {
            "template"
        } else {
            "manual"
        };
        let source_key = input
            .source_key
            .clone()
            .or_else(|| template_id.map(|id| format!("template:{id}")));
        sqlx::query!("INSERT INTO payday_allocations (household_id,month_id,template_id,title,section,kind,category_id,subcategory_id,category_name,subcategory_name,amount,notes,source,source_key,completed_at,expense_group_id,expense_group_name,position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (household_id,month_id,source_key) DO NOTHING",household,month_id,template_id,input.title,input.section,input.kind,input.category_id,input.subcategory_id,category_name,subcategory_name,input.amount,input.notes,source,source_key,completed_at,expense_group_id,expense_group_name,input.position.unwrap_or_default()).execute(&mut **tx).await?;
    }
    Ok(())
}

pub async fn apply(
    pool: &PgPool,
    household: Uuid,
    month: NaiveDate,
    items: &[Input],
    now: DateTime<Utc>,
) -> Result<(), Error> {
    let mut tx = tenant::begin(pool, household, false).await?;
    let month_id = initialize(&mut tx, household, month).await?;
    let mut existing=sqlx::query_as!(Item, "SELECT id, template_id, title, section, position, kind, expense_group_id, expense_group_name, category_id, subcategory_id, category_name, subcategory_name, amount, notes, source, completed_at, source_key FROM payday_allocations WHERE household_id=$1 AND month_id=$2 AND deleted_at IS NULL ORDER BY section,position,title,id", household, month_id).fetch_all(&mut *tx).await?;
    for input in items {
        if existing.iter().any(|row| {
            row.source_key == input.source_key
                || (row.kind == input.kind
                    && row.expense_group_id == input.expense_group_id
                    && row.category_id == input.category_id
                    && ((input.kind == "expense"
                        && (row.subcategory_id.is_none()
                            || input.subcategory_id.is_none()
                            || row.subcategory_id == input.subcategory_id))
                        || (row.subcategory_id == input.subcategory_id
                            && row.title.eq_ignore_ascii_case(&input.title))))
        }) {
            continue;
        }
        save_in(&mut tx, household, month, None, input, now).await?;
        existing.push(Item {
            id: Uuid::nil(),
            template_id: input.template_id,
            title: input.title.clone(),
            section: input.section.clone(),
            position: input.position.unwrap_or_default(),
            kind: input.kind.clone(),
            expense_group_id: input.expense_group_id,
            expense_group_name: None,
            category_id: input.category_id,
            subcategory_id: input.subcategory_id,
            category_name: None,
            subcategory_name: None,
            amount: input.amount,
            notes: input.notes.clone(),
            source: "suggestion".into(),
            source_key: input.source_key.clone(),
            completed_at: None,
        });
    }
    tx.commit().await?;
    Ok(())
}

fn same_details(
    row: &Item,
    input: &Input,
    expense_group_id: Option<Uuid>,
    group_name: &Option<String>,
    category_name: &Option<String>,
    subcategory_name: &Option<String>,
) -> bool {
    row.position == input.position.unwrap_or(row.position)
        && row.title == input.title
        && row.section == input.section
        && row.kind == input.kind
        && row.expense_group_id == expense_group_id
        && row.category_id == input.category_id
        && row.subcategory_id == input.subcategory_id
        && row.expense_group_name == *group_name
        && row.category_name == *category_name
        && row.subcategory_name == *subcategory_name
        && row.amount == input.amount
        && row.notes == input.notes
}

async fn end_recurrence(
    tx: &mut Transaction<'_, Postgres>,
    household: Uuid,
    month: NaiveDate,
    template: Uuid,
) -> Result<(), Error> {
    let series = sqlx::query!(
        "SELECT recurrence_id FROM payday_templates WHERE household_id=$1 AND id=$2",
        household,
        template
    )
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(Error::NotFound("template"))?
    .recurrence_id;
    sqlx::query!("DELETE FROM payday_allocations a USING payday_months m, payday_templates t WHERE a.household_id=$1 AND m.household_id=a.household_id AND m.id=a.month_id AND t.household_id=a.household_id AND t.id=a.template_id AND t.recurrence_id=$2 AND m.month > $3 AND a.deleted_at IS NULL", household, series, month).execute(&mut **tx).await?;
    sqlx::query!("UPDATE payday_templates SET ends_before=GREATEST(starts_on,$3) WHERE household_id=$1 AND recurrence_id=$2 AND (ends_before IS NULL OR ends_before > $3)", household, series, month).execute(&mut **tx).await?;
    Ok(())
}

async fn revise_recurrence(
    tx: &mut Transaction<'_, Postgres>,
    household: Uuid,
    month: NaiveDate,
    linked: Option<Uuid>,
    input: &Input,
    snapshot: (Option<Uuid>, Option<String>, Option<String>, Option<String>),
) -> Result<Uuid, Error> {
    let series = if let Some(template) = linked {
        sqlx::query!(
            "SELECT recurrence_id FROM payday_templates WHERE household_id=$1 AND id=$2",
            household,
            template
        )
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound("template"))?
        .recurrence_id
    } else {
        Uuid::new_v4()
    };
    // Close every later version, not just the selected occurrence's version.
    sqlx::query!("UPDATE payday_templates SET ends_before=GREATEST(starts_on,$3) WHERE household_id=$1 AND recurrence_id=$2 AND (ends_before IS NULL OR ends_before > $3)", household, series, month).execute(&mut **tx).await?;
    let id = save_template_in(tx, household, None, input, snapshot).await?;
    sqlx::query!(
        "UPDATE payday_templates SET recurrence_id=$3,starts_on=$4 WHERE household_id=$1 AND id=$2",
        household,
        id,
        series,
        month
    )
    .execute(&mut **tx)
    .await?;
    // Preserve per-month completion and deletion while replacing recurring details.
    sqlx::query!("UPDATE payday_allocations a SET template_id=n.id,title=n.title,section=n.section,position=n.position,kind=n.kind,expense_group_id=n.expense_group_id,expense_group_name=n.expense_group_name,category_id=n.category_id,subcategory_id=n.subcategory_id,category_name=n.category_name,subcategory_name=n.subcategory_name,amount=n.amount,notes=n.notes FROM payday_templates old,payday_templates n,payday_months m WHERE a.household_id=$1 AND old.household_id=a.household_id AND old.id=a.template_id AND old.recurrence_id=$2 AND n.household_id=a.household_id AND n.id=$3 AND m.household_id=a.household_id AND m.id=a.month_id AND m.month > $4", household, series, id, month).execute(&mut **tx).await?;
    sqlx::query!("INSERT INTO payday_allocations (household_id,month_id,template_id,title,section,position,kind,expense_group_id,expense_group_name,category_id,subcategory_id,category_name,subcategory_name,amount,notes,source,source_key) SELECT t.household_id,m.id,t.id,t.title,t.section,t.position,t.kind,t.expense_group_id,t.expense_group_name,t.category_id,t.subcategory_id,t.category_name,t.subcategory_name,t.amount,t.notes,'template','template:' || t.recurrence_id::text FROM payday_templates t JOIN payday_months m ON m.household_id=t.household_id WHERE t.household_id=$1 AND t.id=$2 AND m.month > $3 AND NOT EXISTS (SELECT 1 FROM payday_allocations a JOIN payday_templates old ON old.household_id=a.household_id AND old.id=a.template_id WHERE a.household_id=t.household_id AND a.month_id=m.id AND old.recurrence_id=t.recurrence_id) ON CONFLICT (household_id,month_id,source_key) DO NOTHING", household, id, month).execute(&mut **tx).await?;
    Ok(id)
}

async fn save_template_in(
    tx: &mut Transaction<'_, Postgres>,
    household: Uuid,
    id: Option<Uuid>,
    input: &Input,
    snapshot: (Option<Uuid>, Option<String>, Option<String>, Option<String>),
) -> Result<Uuid, Error> {
    let (expense_group_id, expense_group_name, category_name, subcategory_name) = snapshot;
    if let Some(id) = id {
        let row = sqlx::query!("UPDATE payday_templates SET title=$3,section=$4,kind=$5,category_id=$6,subcategory_id=$7,category_name=$8,subcategory_name=$9,amount=$10,notes=$11,expense_group_id=$12,expense_group_name=$13,position=COALESCE($14,position) WHERE household_id=$1 AND id=$2 RETURNING id",household,id,input.title,input.section,input.kind,input.category_id,input.subcategory_id,category_name,subcategory_name,input.amount,input.notes,expense_group_id,expense_group_name,input.position).fetch_optional(&mut **tx).await?;
        Ok(row.ok_or(Error::NotFound("template"))?.id)
    } else {
        Ok(sqlx::query!("INSERT INTO payday_templates (household_id,title,section,kind,category_id,subcategory_id,category_name,subcategory_name,amount,notes,expense_group_id,expense_group_name,position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id",household,input.title,input.section,input.kind,input.category_id,input.subcategory_id,category_name,subcategory_name,input.amount,input.notes,expense_group_id,expense_group_name,input.position.unwrap_or_default()).fetch_one(&mut **tx).await?.id)
    }
}

pub async fn save_template(
    pool: &PgPool,
    household: Uuid,
    id: Option<Uuid>,
    input: &Input,
) -> Result<Uuid, Error> {
    let mut tx = tenant::begin(pool, household, false).await?;
    let (expense_group_id, expense_group_name, category_name, subcategory_name) =
        validate(&mut tx, household, input).await?;
    let id = save_template_in(
        &mut tx,
        household,
        id,
        input,
        (
            expense_group_id,
            expense_group_name,
            category_name,
            subcategory_name,
        ),
    )
    .await?;
    tx.commit().await?;
    Ok(id)
}

pub async fn delete(pool: &PgPool, household: Uuid, id: Uuid, template: bool) -> Result<(), Error> {
    let mut tx = tenant::begin(pool, household, false).await?;
    let count = if template {
        sqlx::query!(
            "DELETE FROM payday_templates WHERE household_id=$1 AND id=$2",
            household,
            id
        )
        .execute(&mut *tx)
        .await?
        .rows_affected()
    } else {
        sqlx::query!(
            "UPDATE payday_allocations SET deleted_at=now() WHERE household_id=$1 AND id=$2 AND deleted_at IS NULL",
            household,
            id
        )
        .execute(&mut *tx)
        .await?
        .rows_affected()
    };
    if count == 0 {
        return Err(Error::NotFound("payday item"));
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod actual_tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn combines_scopes_exactly_without_merging_months_or_subcategories() -> anyhow::Result<()> {
        let month: NaiveDate = "2026-06-01".parse()?;
        let previous: NaiveDate = "2026-05-01".parse()?;
        let category = Uuid::new_v4();
        let child = Uuid::new_v4();
        let rows = [
            (month, None, dec!(173.79)),
            (month, None, dec!(0.01)),
            (previous, None, dec!(12.34)),
            (month, Some(child), dec!(0.02)),
        ]
        .into_iter()
        .map(|(month, subcategory_id, amount)| Actual {
            expense_group_id: None,
            expense_group_name: None,
            category_id: Some(category),
            subcategory_id,
            category_name: Some("Thermomix (Alior Bank)".into()),
            subcategory_name: None,
            month,
            amount,
        })
        .collect();
        let rows = aggregate_actuals(rows);
        assert_eq!(rows.len(), 3);
        let combined = rows
            .iter()
            .find(|row| row.month == month && row.subcategory_id.is_none())
            .ok_or_else(|| anyhow::anyhow!("missing combined bucket"))?;
        assert_eq!(combined.amount, dec!(173.80));
        assert_eq!(
            rows.iter().map(|row| row.amount).sum::<Decimal>(),
            dec!(186.16)
        );
        Ok(())
    }
}
