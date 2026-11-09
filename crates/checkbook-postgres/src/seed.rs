use chrono::{Datelike, NaiveDate, Utc};
use rust_decimal::Decimal;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::tenant;

pub async fn seed_development_household(
    pool: &PgPool,
    household_id: Uuid,
) -> Result<(), sqlx::Error> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let income_category = sqlx::query!(
        "SELECT id FROM categories
         WHERE household_id = $1 AND kind = 'income'
         ORDER BY created_at LIMIT 1",
        household_id
    )
    .fetch_one(&mut *transaction)
    .await?
    .id;
    sqlx::query!(
        "INSERT INTO ledger_entries
            (household_id, direction, status, amount, entry_date, description,
             owner_scope, data_source, category_id, source_key)
         VALUES ($1,'income','actual',$2,current_date,$3,'joint','app_manual',$4,$5)
         ON CONFLICT (household_id, source_key)
         DO UPDATE SET amount = EXCLUDED.amount,
                       entry_date = EXCLUDED.entry_date,
                       description = EXCLUDED.description,
                       category_id = EXCLUDED.category_id,
                       updated_at = now()",
        household_id,
        Decimal::from(8_000),
        "Development salary",
        income_category,
        "seed:income"
    )
    .execute(&mut *transaction)
    .await?;

    // Grouped expense structure: each group carries a few expense categories
    // so the dashboard mix and the expenses page have realistic demo data.
    let today = Utc::now().date_naive();
    for (group_name, color, categories) in [
        (
            "Food",
            "16 148 111",
            &[
                ("Groceries", Decimal::from(1_200)),
                ("Eating out", Decimal::from(400)),
            ][..],
        ),
        (
            "Commute",
            "30 111 214",
            &[
                ("Vehicles", Decimal::from(650)),
                ("Public transport", Decimal::from(120)),
            ][..],
        ),
        (
            "Housing",
            "217 119 6",
            &[("Rent", Decimal::from(2_500))][..],
        ),
    ] {
        let group_id = seed_group(&mut transaction, household_id, group_name, color).await?;
        for (category_name, monthly_amount) in categories {
            let category_id = seed_expense_category(
                &mut transaction,
                household_id,
                category_name,
                Some(group_id),
            )
            .await?;
            for months_back in 0..3_u32 {
                let entry_date = shift_months(today, months_back);
                sqlx::query!(
                    "INSERT INTO ledger_entries
                        (household_id, direction, status, amount, entry_date, description,
                         owner_scope, data_source, category_id, source_key)
                     VALUES ($1,'expense','actual',$2,$3,$4,'joint','app_manual',$5,$6)
                     ON CONFLICT (household_id, source_key)
                     DO UPDATE SET amount = EXCLUDED.amount,
                                   entry_date = EXCLUDED.entry_date,
                                   description = EXCLUDED.description,
                                   category_id = EXCLUDED.category_id,
                                   updated_at = now()",
                    household_id,
                    monthly_amount,
                    entry_date,
                    format!("{category_name} spend"),
                    category_id,
                    format!("seed:expense:{category_name}:{months_back}")
                )
                .execute(&mut *transaction)
                .await?;
            }
        }
    }
    transaction.commit().await
}

async fn seed_group(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    name: &str,
    color: &str,
) -> Result<Uuid, sqlx::Error> {
    sqlx::query!(
        "INSERT INTO expense_groups (household_id, name, normalized_name, color)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (household_id, normalized_name)
         DO UPDATE SET color = EXCLUDED.color, updated_at = now()
         RETURNING id",
        household_id,
        name,
        name.to_lowercase(),
        color
    )
    .fetch_one(&mut **transaction)
    .await
    .map(|row| row.id)
}

async fn seed_expense_category(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    name: &str,
    expense_group_id: Option<Uuid>,
) -> Result<Uuid, sqlx::Error> {
    if let Some(existing) = sqlx::query!(
        "SELECT id FROM categories
         WHERE household_id = $1 AND kind = 'expense'
           AND parent_id IS NULL AND normalized_name = $2",
        household_id,
        name.to_lowercase()
    )
    .fetch_optional(&mut **transaction)
    .await?
    {
        sqlx::query!(
            "UPDATE categories SET expense_group_id = $3, updated_at = now()
             WHERE household_id = $1 AND id = $2",
            household_id,
            existing.id,
            expense_group_id
        )
        .execute(&mut **transaction)
        .await?;
        return Ok(existing.id);
    }
    sqlx::query!(
        "INSERT INTO categories
            (household_id, kind, name, normalized_name, expense_group_id)
         VALUES ($1, 'expense', $2, $3, $4)
         RETURNING id",
        household_id,
        name,
        name.to_lowercase(),
        expense_group_id
    )
    .fetch_one(&mut **transaction)
    .await
    .map(|row| row.id)
}

fn shift_months(date: NaiveDate, months_back: u32) -> NaiveDate {
    let total = date.year() * 12 + date.month0() as i32 - months_back as i32;
    let year = total.div_euclid(12);
    let month0 = total.rem_euclid(12) as u32;
    NaiveDate::from_ymd_opt(year, month0 + 1, 15).unwrap_or(date)
}
