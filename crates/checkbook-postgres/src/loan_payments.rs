use std::collections::HashSet;

use checkbook_domain::LoanSchedulePayment;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::assets::AssetStoreError;

pub(crate) async fn load(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    loan_id: Uuid,
) -> Result<(Vec<LoanSchedulePayment>, HashSet<Uuid>), sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT id, payment_date, total_payment, principal_amount, interest_amount,
                extra_payment, remaining_balance, interest_balance, completed,
                COALESCE((extra_payload->>'uses_contractual_payment')::boolean, false) AS "uses_contractual_payment!"
         FROM loan_payments WHERE household_id = $1 AND loan_id = $2
         ORDER BY payment_date, schedule_order, id"#,
        household_id,
        loan_id
    )
    .fetch_all(&mut **tx)
    .await?;
    let defaults = rows
        .iter()
        .filter(|row| row.uses_contractual_payment)
        .map(|row| row.id)
        .collect();
    Ok((
        rows.into_iter()
            .map(|row| LoanSchedulePayment {
                id: Some(row.id),
                date: row.payment_date,
                payment: row.total_payment,
                principal: row.principal_amount,
                interest: row.interest_amount,
                extra_principal: row.extra_payment,
                outstanding_loan_balance: row.remaining_balance,
                interest_balance: row.interest_balance,
                completed: Some(row.completed),
                projected: Some(!row.completed),
            })
            .collect(),
        defaults,
    ))
}

pub(crate) async fn replace(
    tx: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
    loan_id: Uuid,
    existing: &[LoanSchedulePayment],
    schedule: &mut [LoanSchedulePayment],
    contractual_payments: &HashSet<usize>,
    explicit_order: bool,
) -> Result<(), AssetStoreError> {
    let known: HashSet<_> = existing.iter().filter_map(|row| row.id).collect();
    let mut retained = HashSet::new();
    for row in schedule.iter_mut() {
        if let Some(id) = row.id {
            if !known.contains(&id) || !retained.insert(id) {
                return Err(AssetStoreError::Validation(
                    "Payment identity is invalid or repeated.".to_owned(),
                ));
            }
        } else {
            let id = Uuid::now_v7();
            row.id = Some(id);
            retained.insert(id);
        }
    }
    let ids: Vec<_> = retained.into_iter().collect();
    sqlx::query!(
        "DELETE FROM loan_payments WHERE household_id = $1 AND loan_id = $2 AND NOT (id = ANY($3))",
        household_id,
        loan_id,
        &ids
    )
    .execute(&mut **tx)
    .await?;
    for (index, row) in schedule.iter().enumerate() {
        let order = i32::try_from(index)
            .map_err(|_| AssetStoreError::Validation("Too many payments.".to_owned()))?;
        let id = row
            .id
            .ok_or_else(|| AssetStoreError::Validation("Payment identity missing.".to_owned()))?;
        if row.is_completed() && existing.iter().any(|prior| prior == row) {
            // User-supplied order matters for same-date checkpoints, but automatic
            // recalculation/import must leave completed records untouched.
            if explicit_order {
                sqlx::query!(
                    "UPDATE loan_payments SET schedule_order = $4 WHERE household_id = $1 AND loan_id = $2 AND id = $3 AND schedule_order IS DISTINCT FROM $4",
                    household_id, loan_id, id, order
                ).execute(&mut **tx).await?;
            }
            continue;
        }
        sqlx::query!(
            "INSERT INTO loan_payments
                (id, household_id, loan_id, payment_date, total_payment, principal_amount,
                 interest_amount, extra_payment, remaining_balance, interest_balance,
                 completed, schedule_order, source_key, extra_payload)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 jsonb_build_object('uses_contractual_payment', $14::boolean))
             ON CONFLICT (id) DO UPDATE SET payment_date = EXCLUDED.payment_date,
                 total_payment = EXCLUDED.total_payment, principal_amount = EXCLUDED.principal_amount,
                 interest_amount = EXCLUDED.interest_amount, extra_payment = EXCLUDED.extra_payment,
                 remaining_balance = EXCLUDED.remaining_balance, interest_balance = EXCLUDED.interest_balance,
                 completed = EXCLUDED.completed, schedule_order = EXCLUDED.schedule_order,
                 extra_payload = loan_payments.extra_payload || EXCLUDED.extra_payload, updated_at = now()
             WHERE loan_payments.household_id = EXCLUDED.household_id AND loan_payments.loan_id = EXCLUDED.loan_id",
            id, household_id, loan_id, row.date, row.payment, row.principal, row.interest,
            row.extra_principal, row.outstanding_loan_balance, row.interest_balance,
            row.is_completed(), order, format!("app_manual:loan-payment:{id}"), contractual_payments.contains(&index)
        ).execute(&mut **tx).await?;
    }
    Ok(())
}
