use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub async fn begin(
    pool: &PgPool,
    household_id: Uuid,
    read_only: bool,
) -> Result<Transaction<'_, Postgres>, sqlx::Error> {
    let mut transaction = pool.begin().await?;
    if read_only {
        sqlx::query!("SET TRANSACTION READ ONLY")
            .execute(&mut *transaction)
            .await?;
    }
    let _ = sqlx::query!(
        r#"SELECT set_config('app.household_id', $1, true) AS "value!""#,
        household_id.to_string()
    )
    .fetch_one(&mut *transaction)
    .await?;
    if !read_only {
        advisory_lock(&mut transaction, household_id).await?;
    }
    Ok(transaction)
}

pub async fn advisory_lock(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
) -> Result<(), sqlx::Error> {
    let _ = sqlx::query!(
        r#"SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) IS NULL AS "locked!""#,
        household_id.to_string()
    )
    .fetch_one(&mut **transaction)
    .await?;
    Ok(())
}
