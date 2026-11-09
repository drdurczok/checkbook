use std::{env, net::SocketAddr, path::PathBuf};

use anyhow::{Context, Result, bail};
use checkbook_api::{ApiState, admin_data_loads::AdminApiState, router};
use checkbook_postgres::{
    archive::parse_archive, auth::create_development_session, bootstrap_application_role, connect,
    maintenance, migrate, seed::seed_development_household,
};
use clap::{Parser, Subcommand};
use http::HeaderValue;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "checkbook", version, about = "Checkbook backend")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Serve,
    Migrate,
    BootstrapDatabase,
    SeedDevelopment,
    VerifyArchive { path: PathBuf },
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    if let Command::VerifyArchive { path } = &cli.command {
        return verify_archive(path).await;
    }
    let database_url = required_env("DATABASE_URL")?;
    let pool = connect(&database_url, env_u32("DATABASE_MAX_CONNECTIONS", 10)?).await?;

    match cli.command {
        Command::Migrate => {
            migrate(&pool).await?;
            info!("database migrations completed");
        }
        Command::BootstrapDatabase => bootstrap_database(&pool).await?,
        Command::Serve => serve(pool).await?,
        Command::SeedDevelopment => seed_development(&pool).await?,
        Command::VerifyArchive { .. } => {}
    }
    Ok(())
}

async fn verify_archive(path: &std::path::Path) -> Result<()> {
    const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;

    let metadata = std::fs::metadata(path)
        .with_context(|| format!("archive {} is not accessible", path.display()))?;
    if !metadata.is_file() {
        bail!("archive {} is not a regular file", path.display());
    }
    if metadata.len() > MAX_ARCHIVE_BYTES {
        bail!("archive exceeds the 64 MiB upload limit");
    }
    let bytes = std::fs::read(path)
        .with_context(|| format!("archive {} could not be read", path.display()))?;
    let snapshot = parse_archive(&bytes).context("archive structure or checksums are invalid")?;
    checkbook_postgres::backup::validate_snapshot(&snapshot, snapshot.household_id)
        .context("archive domain validation failed")?;
    let row_count = snapshot
        .tables
        .values()
        .filter_map(serde_json::Value::as_array)
        .map(Vec::len)
        .sum::<usize>();
    info!(
        path = %path.display(),
        household_id = %snapshot.household_id,
        format_version = snapshot.format_version,
        schema_version = snapshot.schema_version,
        row_count,
        "archive verification completed"
    );
    Ok(())
}

async fn bootstrap_database(pool: &sqlx::PgPool) -> Result<()> {
    let password = required_env("DB_APP_PASSWORD")?;
    bootstrap_application_role(pool, &password).await?;
    info!("non-superuser database application role configured");
    Ok(())
}

async fn serve(pool: sqlx::PgPool) -> Result<()> {
    let environment = env_string("APP_ENV", "development")?;
    if !matches!(environment.as_str(), "development" | "test" | "production") {
        bail!("APP_ENV must be one of: development, test, production");
    }
    let dev_auth_enabled = env_bool("DEV_AUTH_ENABLED", false)?;
    if environment == "production" && dev_auth_enabled {
        bail!("DEV_AUTH_ENABLED must be false in production");
    }

    let configured_origins = match env::var("ALLOWED_ORIGINS") {
        Ok(value) => value,
        Err(env::VarError::NotPresent) if environment == "production" => {
            bail!("ALLOWED_ORIGINS is required in production");
        }
        Err(env::VarError::NotPresent) => "http://localhost:5173".to_owned(),
        Err(error) => return Err(error).context("ALLOWED_ORIGINS is not valid Unicode"),
    };
    let origins = configured_origins
        .split(',')
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .map(HeaderValue::from_str)
        .collect::<Result<Vec<_>, _>>()
        .context("ALLOWED_ORIGINS contains an invalid HTTP origin")?;
    let cloudflare = cloudflare_verifier(&environment)?;
    let google = google_verifier()?;
    let backup_admin_root = backup_admin_root(&environment)?;
    let address: SocketAddr = env::var("LISTEN_ADDRESS")
        .unwrap_or_else(|_| "0.0.0.0:8000".to_owned())
        .parse()
        .context("LISTEN_ADDRESS is invalid")?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    let dev_listener = dev_auth_listener(dev_auth_enabled, address).await?;
    let admin = admin_listener(&pool, &environment).await?;
    let maintenance_interval = env_u32("MAINTENANCE_INTERVAL_SECONDS", 900)?.max(60);
    let session_hours = env_u32("SESSION_HOURS", 24)?;
    if session_hours == 0 {
        bail!("SESSION_HOURS must be greater than zero");
    }
    let maintenance_pool = pool.clone();
    let maintenance = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(u64::from(
            maintenance_interval,
        )));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            match maintenance::run_once(&maintenance_pool).await {
                Ok(result) => {
                    checkbook_api::metrics::observe_maintenance(true, result.planning_changes);
                    info!(
                        households = result.households_processed,
                        planning_changes = result.planning_changes,
                        sessions_deleted = result.sessions_deleted,
                        "periodic maintenance completed"
                    );
                }
                Err(error) => {
                    checkbook_api::metrics::observe_maintenance(false, 0);
                    tracing::error!(%error, "periodic maintenance failed");
                }
            }
        }
    });
    let state = ApiState {
        pool,
        dev_auth_enabled: false,
        session_hours: i64::from(session_hours),
        cloudflare,
        google,
        backup_admin_root,
    };
    info!(%address, "checkbook API listening");
    let dev_server = dev_listener.map(|(address, listener)| {
        info!(%address, "checkbook development-auth API listening");
        let mut dev_state = state.clone();
        dev_state.dev_auth_enabled = true;
        let dev_origins = origins.clone();
        tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router(dev_state, dev_origins)).await {
                tracing::error!(%error, "development-auth API stopped");
            }
        })
    });
    let admin_server = admin.map(|(address, listener, state)| {
        info!(%address, "checkbook private data-load API listening");
        tokio::spawn(async move {
            if let Err(error) =
                axum::serve(listener, checkbook_api::admin_data_loads::router(state)).await
            {
                tracing::error!(%error, "private data-load API stopped");
            }
        })
    });
    let result = axum::serve(listener, router(state, origins))
        .with_graceful_shutdown(shutdown_signal())
        .await;
    maintenance.abort();
    let _ = maintenance.await;
    if let Some(admin_server) = admin_server {
        admin_server.abort();
        let _ = admin_server.await;
    }
    if let Some(dev_server) = dev_server {
        dev_server.abort();
        let _ = dev_server.await;
    }
    result?;
    Ok(())
}

async fn dev_auth_listener(
    enabled: bool,
    public_address: SocketAddr,
) -> Result<Option<(SocketAddr, tokio::net::TcpListener)>> {
    let configured = env::var("DEV_AUTH_LISTEN_ADDRESS").unwrap_or_default();
    if !enabled {
        return Ok(None);
    }
    if configured.trim().is_empty() {
        bail!("DEV_AUTH_LISTEN_ADDRESS is required when DEV_AUTH_ENABLED=true");
    }
    let address: SocketAddr = configured
        .parse()
        .context("DEV_AUTH_LISTEN_ADDRESS is invalid")?;
    if address == public_address {
        bail!("DEV_AUTH_LISTEN_ADDRESS must differ from LISTEN_ADDRESS");
    }
    let listener = tokio::net::TcpListener::bind(address).await?;
    Ok(Some((address, listener)))
}

async fn admin_listener(
    pool: &sqlx::PgPool,
    environment: &str,
) -> Result<Option<(SocketAddr, tokio::net::TcpListener, AdminApiState)>> {
    let address = optional_env("ADMIN_LISTEN_ADDRESS");
    let token = optional_env("ADMIN_SERVICE_TOKEN");
    let staging_root = optional_env_path("DATA_LOAD_STAGING_ROOT");
    if address.is_none() {
        if token.is_some() || staging_root.is_some() {
            bail!(
                "ADMIN_LISTEN_ADDRESS, ADMIN_SERVICE_TOKEN, and DATA_LOAD_STAGING_ROOT must be configured together"
            );
        }
        return Ok(None);
    }
    let address = address.unwrap_or_default();
    let token = token.unwrap_or_default();
    if token.len() < 32 {
        bail!("ADMIN_SERVICE_TOKEN must contain at least 32 characters");
    }
    let staging_root = staging_root.ok_or_else(|| {
        anyhow::anyhow!(
            "ADMIN_LISTEN_ADDRESS, ADMIN_SERVICE_TOKEN, and DATA_LOAD_STAGING_ROOT must be configured together"
        )
    })?;
    let staging_root = staging_root.canonicalize().with_context(|| {
        format!(
            "DATA_LOAD_STAGING_ROOT {} is not accessible",
            staging_root.display()
        )
    })?;
    if !staging_root.is_dir() {
        bail!(
            "DATA_LOAD_STAGING_ROOT {} is not a directory",
            staging_root.display()
        );
    }
    let address: SocketAddr = address.parse().context("ADMIN_LISTEN_ADDRESS is invalid")?;
    if environment == "production" && address.ip().is_unspecified() {
        info!(
            %address,
            "private data-load listener relies on container/network isolation"
        );
    }
    let listener = tokio::net::TcpListener::bind(address).await?;
    Ok(Some((
        address,
        listener,
        AdminApiState::new(pool.clone(), &token, staging_root),
    )))
}

fn cloudflare_verifier(
    environment: &str,
) -> Result<Option<checkbook_api::cloudflare::CloudflareVerifier>> {
    let team_domain = env::var("CLOUDFLARE_ACCESS_TEAM_DOMAIN").unwrap_or_default();
    let audience = env::var("CLOUDFLARE_ACCESS_AUDIENCE").unwrap_or_default();
    if team_domain.is_empty() && audience.is_empty() {
        if environment == "production" {
            bail!(
                "CLOUDFLARE_ACCESS_TEAM_DOMAIN and CLOUDFLARE_ACCESS_AUDIENCE are required in production"
            );
        }
        return Ok(None);
    }
    if team_domain.is_empty() || audience.is_empty() {
        bail!(
            "CLOUDFLARE_ACCESS_TEAM_DOMAIN and CLOUDFLARE_ACCESS_AUDIENCE must be configured together"
        );
    }
    Ok(Some(
        checkbook_api::cloudflare::CloudflareVerifier::new(&team_domain, &audience)
            .context("Cloudflare Access configuration is invalid")?,
    ))
}

fn google_verifier() -> Result<Option<checkbook_api::google::GoogleVerifier>> {
    let client_id = env::var("GOOGLE_CLIENT_ID").unwrap_or_default();
    if client_id.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(
        checkbook_api::google::GoogleVerifier::new(&client_id)
            .context("GOOGLE_CLIENT_ID configuration is invalid")?,
    ))
}

fn backup_admin_root(environment: &str) -> Result<Option<PathBuf>> {
    let configured = optional_env_path("BACKUP_ADMIN_ROOT");
    let Some(path) = configured else {
        if environment == "production" {
            bail!("BACKUP_ADMIN_ROOT is required in production");
        }
        return Ok(None);
    };
    let canonical = path
        .canonicalize()
        .with_context(|| format!("BACKUP_ADMIN_ROOT {} is not accessible", path.display()))?;
    if !canonical.is_dir() {
        bail!(
            "BACKUP_ADMIN_ROOT {} is not a directory",
            canonical.display()
        );
    }
    Ok(Some(canonical))
}

async fn seed_development(pool: &sqlx::PgPool) -> Result<()> {
    let email = env::var("SEED_EMAIL").unwrap_or_else(|_| "owner@checkbook.local".to_owned());
    let full_name = env::var("SEED_FULL_NAME").unwrap_or_else(|_| "Checkbook Owner".to_owned());
    let context = create_development_session(pool, &email, &full_name, "owner", 24).await?;
    seed_development_household(pool, context.household.id).await?;
    maintenance::run_once(pool).await?;
    info!(
        %email,
        household_id = %context.household.id,
        "development household seeded"
    );
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

fn required_env(name: &str) -> Result<String> {
    env::var(name).with_context(|| format!("{name} is required"))
}

fn optional_env(name: &str) -> Option<String> {
    env::var(name).ok().and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    })
}

fn optional_env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name).and_then(|value| {
        let trimmed = value.to_string_lossy().trim().to_owned();
        if trimmed.is_empty() {
            None
        } else {
            Some(PathBuf::from(trimmed))
        }
    })
}

fn env_string(name: &str, default: &str) -> Result<String> {
    match env::var(name) {
        Ok(value) => Ok(value),
        Err(env::VarError::NotPresent) => Ok(default.to_owned()),
        Err(error) => Err(error).with_context(|| format!("{name} is not valid Unicode")),
    }
}

fn env_u32(name: &str, default: u32) -> Result<u32> {
    match env::var(name) {
        Ok(value) => parse_u32(name, &value),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error).with_context(|| format!("{name} is not valid Unicode")),
    }
}

fn parse_u32(name: &str, value: &str) -> Result<u32> {
    value
        .parse::<u32>()
        .with_context(|| format!("{name} must be a non-negative integer"))
}

fn env_bool(name: &str, default: bool) -> Result<bool> {
    match env::var(name) {
        Ok(value) => parse_bool(name, &value),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error).with_context(|| format!("{name} is not valid Unicode")),
    }
}

fn parse_bool(name: &str, value: &str) -> Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => bail!("{name} must be a boolean (true/false, yes/no, on/off, or 1/0)"),
    }
}

fn init_tracing() {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
}

#[cfg(test)]
mod tests {
    use super::{parse_bool, parse_u32};

    #[test]
    fn configuration_booleans_are_explicit() -> anyhow::Result<()> {
        assert!(parse_bool("FLAG", "true")?);
        assert!(parse_bool("FLAG", "YES")?);
        assert!(!parse_bool("FLAG", "off")?);
        assert!(parse_bool("FLAG", "truthy").is_err());
        Ok(())
    }

    #[test]
    fn configuration_numbers_reject_invalid_values() -> anyhow::Result<()> {
        assert_eq!(parse_u32("COUNT", "42")?, 42);
        assert!(parse_u32("COUNT", "-1").is_err());
        assert!(parse_u32("COUNT", "many").is_err());
        Ok(())
    }
}
