use crate::{assets::AssetStoreError, tenant};
use checkbook_domain::holding_prices::{DailyClose, refresh_due};
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct CachedPrice {
    pub ticker: String,
    pub close: Option<Decimal>,
    pub price_date: Option<NaiveDate>,
    pub last_attempt_at: DateTime<Utc>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
}

pub async fn account_tickers(
    pool: &PgPool,
    household_id: Uuid,
    asset_id: Uuid,
) -> Result<Vec<String>, AssetStoreError> {
    let mut tx = tenant::begin(pool, household_id, true).await?;
    let exists = sqlx::query_scalar!("SELECT id FROM properties WHERE household_id = $1 AND id = $2 AND category = 'account' AND account_type = 'stocks'", household_id, asset_id).fetch_optional(&mut *tx).await?;
    if exists.is_none() {
        return Err(AssetStoreError::NotFound);
    }
    let tickers = sqlx::query_scalar!(r#"SELECT DISTINCT ticker AS "ticker!" FROM account_holdings WHERE household_id = $1 AND property_id = $2 AND ticker IS NOT NULL AND sold_on IS NULL AND sell_value IS NULL ORDER BY ticker LIMIT 51"#, household_id, asset_id).fetch_all(&mut *tx).await?;
    if tickers.len() > 50 {
        return Err(AssetStoreError::Validation(
            "At most 50 distinct open holding tickers can be priced.".to_owned(),
        ));
    }
    tx.commit().await?;
    Ok(tickers)
}

pub async fn cached(
    pool: &PgPool,
    household_id: Uuid,
    ticker: &str,
) -> Result<Option<CachedPrice>, sqlx::Error> {
    let mut tx = tenant::begin(pool, household_id, true).await?;
    let row = sqlx::query_as!(CachedPrice, "SELECT ticker, close, price_date, last_attempt_at, last_success_at, error FROM holding_price_cache WHERE household_id = $1 AND ticker = $2", household_id, ticker).fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    Ok(row)
}

/// Claim before networking and immediately release the tenant mutation lock.
/// A failed/interrupted fetch is retried after backoff, not on every request.
pub async fn claim(
    pool: &PgPool,
    household_id: Uuid,
    ticker: &str,
    now: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    let mut tx = tenant::begin(pool, household_id, false).await?;
    let row = sqlx::query!("SELECT last_attempt_at, last_success_at FROM holding_price_cache WHERE household_id = $1 AND ticker = $2", household_id, ticker).fetch_optional(&mut *tx).await?;
    if !refresh_due(
        row.as_ref().map(|row| row.last_attempt_at),
        row.and_then(|row| row.last_success_at),
        now,
    ) {
        tx.commit().await?;
        return Ok(false);
    }
    sqlx::query!("INSERT INTO holding_price_cache (household_id, ticker, last_attempt_at, error) VALUES ($1, $2, $3, 'Price refresh pending.') ON CONFLICT (household_id, ticker) DO UPDATE SET last_attempt_at = EXCLUDED.last_attempt_at, error = EXCLUDED.error", household_id, ticker, now).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}

pub async fn finish(
    pool: &PgPool,
    household_id: Uuid,
    ticker: &str,
    attempted: DateTime<Utc>,
    result: Result<DailyClose, String>,
) -> Result<(), sqlx::Error> {
    let mut tx = tenant::begin(pool, household_id, false).await?;
    let previous = sqlx::query_scalar!(
        "SELECT price_date FROM holding_price_cache WHERE household_id = $1 AND ticker = $2",
        household_id,
        ticker
    )
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    let result = match result {
        Ok(price) if previous.is_some_and(|date| date > price.price_date) => {
            Err("Provider returned an older closing price.".to_owned())
        }
        other => other,
    };
    let (close, date, error) = match result {
        Ok(price) => (Some(price.close), Some(price.price_date), None),
        Err(error) => (None, None, Some(error)),
    };
    sqlx::query!("UPDATE holding_price_cache SET close = COALESCE($4, close), price_date = COALESCE($5, price_date), last_success_at = CASE WHEN $4::numeric IS NOT NULL THEN $3 ELSE last_success_at END, error = $6 WHERE household_id = $1 AND ticker = $2 AND last_attempt_at = $3", household_id, ticker, attempted, close, date, error).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
