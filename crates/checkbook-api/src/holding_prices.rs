use crate::{
    ApiState,
    auth::{authenticated, require_permission},
    error::ApiError,
};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use checkbook_application::{ApplicationError, Clock, SystemClock};
use checkbook_domain::holding_prices::{DailyClose, select_completed_close};
use checkbook_postgres::holding_prices as store;
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{str::FromStr, sync::OnceLock, time::Duration};
use tokio::sync::Semaphore;
use uuid::Uuid;

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct HoldingPricesResponse {
    pub prices: Vec<HoldingPrice>,
}
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct HoldingPrice {
    pub ticker: String,
    pub currency: String,
    #[serde(with = "rust_decimal::serde::float_option")]
    pub close: Option<Decimal>,
    pub price_date: Option<NaiveDate>,
    pub fetched_at: Option<DateTime<Utc>>,
    pub stale: bool,
    pub error: Option<String>,
}

#[utoipa::path(get, path = "/api/household/assets/{asset_id}/holding-prices", operation_id = "getHoldingPrices",
    params(("asset_id" = Uuid, Path, description = "Account asset id")),
    responses((status = 200, body = HoldingPricesResponse), (status = 401, body = crate::error::ErrorBody), (status = 403, body = crate::error::ErrorBody), (status = 404, body = crate::error::ErrorBody)), security(("bearerAuth" = [])))]
pub async fn get_holding_prices(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(asset_id): Path<Uuid>,
) -> Result<Json<HoldingPricesResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "read")?;
    let household = context.household.id;
    let tickers = store::account_tickers(&state.pool, household, asset_id)
        .await
        .map_err(crate::assets::map_asset_store_error)?;
    let mut prices = Vec::with_capacity(tickers.len());
    // Bound provider concurrency across accounts, and finish inside the route timeout.
    static FETCH_SLOTS: Semaphore = Semaphore::const_new(4);
    let mut refreshes = tokio::task::JoinSet::new();
    for ticker in &tickers {
        let now = SystemClock.now();
        if store::claim(&state.pool, household, ticker, now)
            .await
            .map_err(storage_error)?
        {
            let pool = state.pool.clone();
            let ticker = ticker.clone();
            refreshes.spawn(async move {
                let result =
                    match tokio::time::timeout(Duration::from_secs(105), FETCH_SLOTS.acquire())
                        .await
                    {
                        Ok(Ok(_permit)) => fetch_yahoo(&ticker, now).await,
                        _ => Err("Price provider busy; retry after backoff.".to_owned()),
                    };
                store::finish(&pool, household, &ticker, now, result).await
            });
        }
    }
    while let Some(result) = refreshes.join_next().await {
        result
            .map_err(|_| ApiError(ApplicationError::Storage))?
            .map_err(storage_error)?;
    }
    for ticker in tickers {
        if let Some(row) = store::cached(&state.pool, household, &ticker)
            .await
            .map_err(storage_error)?
        {
            prices.push(HoldingPrice {
                ticker: row.ticker,
                currency: "USD".to_owned(),
                close: row.close,
                price_date: row.price_date,
                fetched_at: row.last_success_at,
                stale: row.error.is_some() || row.last_success_at.is_none(),
                error: row.error,
            });
        }
    }
    Ok(Json(HoldingPricesResponse { prices }))
}
fn storage_error(error: sqlx::Error) -> ApiError {
    tracing::error!(%error, "holding price storage failed");
    ApiError(ApplicationError::Storage)
}

async fn fetch_yahoo(ticker: &str, now: DateTime<Utc>) -> Result<DailyClose, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
    let client = CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(8))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("Checkbook/1.0 daily holdings")
                .build()
        })
        .as_ref()
        .map_err(|_| "Price provider unavailable.".to_owned())?;
    fetch_url(
        client,
        &format!("https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"),
        ticker,
        now,
    )
    .await
}

// The production caller supplies only the fixed Yahoo origin; tests inject loopback.
async fn fetch_url(
    client: &reqwest::Client,
    url: &str,
    ticker: &str,
    now: DateTime<Utc>,
) -> Result<DailyClose, String> {
    let mut response = client
        .get(url)
        .query(&[("range", "1mo"), ("interval", "1d")])
        .send()
        .await
        .map_err(|_| "Price provider unavailable.".to_owned())?;
    if !response.status().is_success() {
        return Err("Price provider returned an unsuccessful response.".to_owned());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Price provider response failed.".to_owned())?
    {
        if bytes.len() + chunk.len() > 256 * 1024 {
            return Err("Price provider response exceeds limit.".to_owned());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_yahoo(&bytes, ticker, now).map_err(str::to_owned)
}

#[derive(Deserialize)]
struct Envelope {
    chart: Chart,
}
#[derive(Deserialize)]
struct Chart {
    result: Option<Vec<ChartResult>>,
    error: Option<serde_json::Value>,
}
#[derive(Deserialize)]
struct ChartResult {
    meta: Meta,
    timestamp: Vec<i64>,
    indicators: Indicators,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    symbol: String,
    currency: String,
    exchange_name: String,
    instrument_type: String,
    exchange_timezone_name: String,
    price_hint: u32,
    current_trading_period: TradingPeriod,
}
#[derive(Deserialize)]
struct TradingPeriod {
    regular: Regular,
}
#[derive(Deserialize)]
struct Regular {
    start: i64,
    end: i64,
}
#[derive(Deserialize)]
struct Indicators {
    quote: Vec<Quote>,
}
#[derive(Deserialize)]
struct Quote {
    close: Vec<Option<Box<RawValue>>>,
}

fn parse_yahoo(bytes: &[u8], ticker: &str, now: DateTime<Utc>) -> Result<DailyClose, &'static str> {
    let envelope: Envelope =
        serde_json::from_slice(bytes).map_err(|_| "Invalid price provider response.")?;
    if envelope.chart.error.is_some() {
        return Err("Ticker unavailable from price provider.");
    }
    let mut results = envelope
        .chart
        .result
        .ok_or("Ticker unavailable from price provider.")?;
    if results.len() != 1 {
        return Err("Invalid price provider result count.");
    }
    let result = results.remove(0);
    let meta = result.meta;
    if meta.symbol != ticker
        || meta.currency != "USD"
        || meta.exchange_timezone_name != "America/New_York"
        || !["NYQ", "NMS", "NGM", "NCM", "ASE", "PCX", "BTS", "BATS"]
            .contains(&meta.exchange_name.as_str())
        || !["EQUITY", "ETF"].contains(&meta.instrument_type.as_str())
    {
        return Err("Only US exchange-listed USD stocks and ETFs are supported.");
    }
    let start = DateTime::from_timestamp(meta.current_trading_period.regular.start, 0)
        .ok_or("Invalid trading session.")?;
    let end = DateTime::from_timestamp(meta.current_trading_period.regular.end, 0)
        .ok_or("Invalid trading session.")?;
    if end <= start
        || end - start > chrono::Duration::hours(8)
        || end > now + chrono::Duration::days(4)
        || end < now - chrono::Duration::days(7)
        || start.date_naive() != end.date_naive()
        || meta.price_hint > 6
    {
        return Err("Invalid trading session or precision.");
    }
    if result.timestamp.len() > 40 || result.indicators.quote.len() != 1 {
        return Err("Invalid daily bar count.");
    }
    let quote = &result.indicators.quote[0];
    if result.timestamp.len() != quote.close.len() {
        return Err("Invalid daily price bars.");
    }
    let bars = result
        .timestamp
        .iter()
        .zip(&quote.close)
        .map(|(timestamp, close)| {
            let at = DateTime::from_timestamp(*timestamp, 0).ok_or("Invalid price timestamp.")?;
            let close = close
                .as_ref()
                .map(|raw| Decimal::from_str(raw.get()).map_err(|_| "Invalid decimal close."))
                .transpose()?;
            Ok((at, close))
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    let price = select_completed_close(&bars, now, end, meta.price_hint)
        .ok_or("No completed daily closing price available.")?;
    if now >= end + chrono::Duration::minutes(20) && price.price_date < end.date_naive() {
        return Err("Latest completed session close not yet published.");
    }
    Ok(price)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};
    fn fixture(now: DateTime<Utc>) -> serde_json::Value {
        serde_json::json!({"chart":{"error":null,"result":[{
            "meta":{"symbol":"AAPL","currency":"USD","exchangeName":"NMS","instrumentType":"EQUITY","exchangeTimezoneName":"America/New_York","priceHint":2,"currentTradingPeriod":{"regular":{"start":(now-Duration::hours(7)).timestamp(),"end":(now-Duration::minutes(21)).timestamp()}}},
            "timestamp":[(now-Duration::hours(7)).timestamp()],"indicators":{"quote":[{"close":[349.3901062011719]}]}
        }]}})
    }
    #[tokio::test]
    async fn transport_bounds_status_body_redirect_and_timeout() -> anyhow::Result<()> {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        let now = Utc
            .with_ymd_and_hms(2026, 11, 4, 21, 21, 0)
            .single()
            .ok_or_else(|| anyhow::anyhow!("date"))?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_millis(100))
            .build()?;
        let body = serde_json::to_string(&fixture(now))?;
        for (status, body, delay, expected_ok) in [
            ("200 OK", body, false, true),
            ("503 Unavailable", "unavailable".to_owned(), false, false),
            ("302 Found", String::new(), false, false),
            ("200 OK", "x".repeat(256 * 1024 + 1), false, false),
            ("200 OK", String::new(), true, false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await?;
            let address = listener.local_addr()?;
            let task = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await?;
                let mut request = [0; 2048];
                if socket.read(&mut request).await? == 0 {
                    return Ok::<_, std::io::Error>(());
                }
                if delay {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:1/never\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                Ok::<_, std::io::Error>(())
            });
            assert_eq!(
                fetch_url(
                    &client,
                    &format!("http://{address}/chart/AAPL"),
                    "AAPL",
                    now
                )
                .await
                .is_ok(),
                expected_ok
            );
            task.await??;
        }
        Ok(())
    }
    #[test]
    fn parser_validates_market_session_and_exact_decimal() -> anyhow::Result<()> {
        let now = Utc
            .with_ymd_and_hms(2026, 11, 4, 21, 21, 0)
            .single()
            .ok_or_else(|| anyhow::anyhow!("date"))?;
        let original = fixture(now);
        let price = parse_yahoo(&serde_json::to_vec(&original)?, "AAPL", now)
            .map_err(anyhow::Error::msg)?;
        assert_eq!(price.close, Decimal::from_str("349.39")?);
        for (field, value) in [
            ("currency", "CAD"),
            ("symbol", "MSFT"),
            ("exchangeName", "LSE"),
            ("instrumentType", "OPTION"),
            ("exchangeTimezoneName", "UTC"),
        ] {
            let mut invalid = original.clone();
            invalid["chart"]["result"][0]["meta"][field] = serde_json::json!(value);
            assert!(parse_yahoo(&serde_json::to_vec(&invalid)?, "AAPL", now).is_err());
        }
        let mut unpublished = original.clone();
        unpublished["chart"]["result"][0]["timestamp"] =
            serde_json::json!([(now - Duration::days(1)).timestamp()]);
        assert!(parse_yahoo(&serde_json::to_vec(&unpublished)?, "AAPL", now).is_err());
        assert!(parse_yahoo(b"not json", "AAPL", now).is_err());
        assert!(
            parse_yahoo(
                br#"{"chart":{"error":{"code":"Not Found"},"result":null}}"#,
                "AAPL",
                now
            )
            .is_err()
        );
        Ok(())
    }
}
