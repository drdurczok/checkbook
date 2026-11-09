use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use getrandom::fill;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum AuthStoreError {
    #[error("authentication required")]
    Unauthenticated,
    #[error("invalid identity")]
    InvalidIdentity,
    #[error("database error")]
    Database(#[from] sqlx::Error),
    #[error("secure random generation failed")]
    Random,
}

#[derive(Debug, Clone)]
pub struct SessionContext {
    pub session_id: Uuid,
    pub token: Option<String>,
    pub expires_at: DateTime<Utc>,
    pub user: UserRecord,
    pub household: HouseholdRecord,
    pub membership: MembershipRecord,
    pub settings: SettingsRecord,
    pub role_permissions: Value,
    pub external_subject: String,
}

#[derive(Debug, Clone)]
pub struct UserRecord {
    pub id: Uuid,
    pub email: String,
    pub full_name: String,
    pub picture_url: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct HouseholdRecord {
    pub id: Uuid,
    pub name: String,
    pub base_currency: String,
    pub timezone: String,
    pub created_by_user_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct MembershipRecord {
    pub id: Uuid,
    pub household_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub relationship_kind: String,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct SettingsRecord {
    pub id: Uuid,
    pub household_id: Uuid,
    pub privacy_mode: String,
    pub allow_cross_member_visibility: bool,
    pub projection_baseline_window_months: i32,
    pub projection_horizon_months: i32,
    pub savings_allocation_strategy: String,
    pub backup_path: String,
    pub backup_retention: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug)]
struct SessionLookup {
    session_id: Uuid,
    user_id: Uuid,
    household_id: Uuid,
    expires_at: DateTime<Utc>,
    external_subject: String,
}

#[derive(Debug)]
struct PermissionRecord {
    module: String,
    role: String,
    can_read: bool,
    can_write: bool,
    can_delete: bool,
}

#[derive(Debug)]
struct PendingInvitation {
    id: Uuid,
    household_id: Uuid,
    role: String,
    relationship_kind: String,
}

pub async fn create_development_session(
    pool: &PgPool,
    email: &str,
    full_name: &str,
    relationship_kind: &str,
    session_hours: i64,
) -> Result<SessionContext, AuthStoreError> {
    let normalized_email = email.trim().to_ascii_lowercase();
    create_identity_session(
        pool,
        "development",
        &normalized_email,
        &normalized_email,
        full_name,
        "",
        relationship_kind,
        session_hours,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn create_identity_session(
    pool: &PgPool,
    provider: &str,
    subject: &str,
    email: &str,
    full_name: &str,
    picture_url: &str,
    relationship_kind: &str,
    session_hours: i64,
) -> Result<SessionContext, AuthStoreError> {
    let normalized_email = email.trim().to_ascii_lowercase();
    if normalized_email.is_empty() || !normalized_email.contains('@') || full_name.trim().is_empty()
    {
        return Err(AuthStoreError::InvalidIdentity);
    }
    if !matches!(provider, "cloudflare" | "google" | "local" | "development")
        || subject.trim().is_empty()
    {
        return Err(AuthStoreError::InvalidIdentity);
    }
    if !matches!(relationship_kind, "owner" | "spouse" | "member") {
        return Err(AuthStoreError::InvalidIdentity);
    }

    let mut transaction = pool.begin().await?;
    let subject = subject.trim().to_owned();
    let user = resolve_identity_user(
        &mut transaction,
        provider,
        &subject,
        &normalized_email,
        full_name.trim(),
        picture_url,
    )
    .await?;

    let existing_membership = sqlx::query_as!(
        MembershipRecord,
        r#"SELECT id AS "id!", household_id AS "household_id!", user_id AS "user_id!",
                  role AS "role!", relationship_kind AS "relationship_kind!",
                  is_active AS "is_active!", created_at AS "created_at!",
                  updated_at AS "updated_at!"
         FROM app.active_membership_for_user($1)"#,
        user.id
    )
    .fetch_optional(&mut *transaction)
    .await?;

    let (household, membership, settings) = if let Some(membership) = existing_membership {
        set_household_context(&mut transaction, membership.household_id).await?;
        let household = load_household(&mut transaction, membership.household_id).await?;
        let settings = load_settings(&mut transaction, membership.household_id).await?;
        (household, membership, settings)
    } else if let Some(invitation) = sqlx::query_as!(
        PendingInvitation,
        r#"SELECT id AS "id!", household_id AS "household_id!", role AS "role!",
                  relationship_kind AS "relationship_kind!"
         FROM app.pending_invitation_for_email($1)"#,
        &normalized_email
    )
    .fetch_optional(&mut *transaction)
    .await?
    {
        set_household_context(&mut transaction, invitation.household_id).await?;
        crate::tenant::advisory_lock(&mut transaction, invitation.household_id).await?;
        if matches!(invitation.relationship_kind.as_str(), "owner" | "spouse") {
            let occupied = sqlx::query!(
                r#"SELECT EXISTS(
                    SELECT 1 FROM household_memberships
                    WHERE household_id = $1 AND is_active AND relationship_kind = $2
                 ) AS "occupied!""#,
                invitation.household_id,
                &invitation.relationship_kind
            )
            .fetch_one(&mut *transaction)
            .await?
            .occupied;
            if occupied {
                return Err(AuthStoreError::InvalidIdentity);
            }
        }
        let membership = sqlx::query_as!(
            MembershipRecord,
            r#"INSERT INTO household_memberships
                (household_id, user_id, role, relationship_kind)
             VALUES ($1, $2, $3, $4)
             RETURNING id, household_id, user_id, role, relationship_kind, is_active,
                       created_at, updated_at"#,
            invitation.household_id,
            user.id,
            invitation.role,
            invitation.relationship_kind
        )
        .fetch_one(&mut *transaction)
        .await?;
        sqlx::query!(
            "UPDATE household_invitations
             SET accepted_at = now(), updated_at = now()
             WHERE household_id = $1 AND id = $2 AND accepted_at IS NULL",
            invitation.household_id,
            invitation.id
        )
        .execute(&mut *transaction)
        .await?;
        let household = load_household(&mut transaction, invitation.household_id).await?;
        let settings = load_settings(&mut transaction, invitation.household_id).await?;
        (household, membership, settings)
    } else {
        create_household(
            &mut transaction,
            &user,
            relationship_kind,
            "PLN",
            "Europe/Warsaw",
        )
        .await?
    };

    let (token, token_hash) = generate_session_token()?;
    let expires_at = Utc::now() + Duration::hours(session_hours);
    let session_id = sqlx::query!(
        "INSERT INTO sessions (user_id, household_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id",
        user.id,
        household.id,
        token_hash,
        expires_at
    )
    .fetch_one(&mut *transaction)
    .await?
    .id;
    let permissions = load_permissions(&mut transaction, household.id).await?;
    transaction.commit().await?;

    Ok(SessionContext {
        session_id,
        token: Some(token),
        expires_at,
        user,
        household,
        membership,
        settings,
        role_permissions: permissions,
        external_subject: subject,
    })
}

pub async fn authenticate(pool: &PgPool, token: &str) -> Result<SessionContext, AuthStoreError> {
    let token_hash = hash_token(token.as_bytes());
    let lookup = sqlx::query_as!(
        SessionLookup,
        r#"SELECT s.id AS "session_id!", s.user_id AS "user_id!",
                s.household_id AS "household_id!", s.expires_at AS "expires_at!",
                CASE ei.provider
                    WHEN 'development' THEN 'dev'
                    ELSE ei.provider
                END || ':' || ei.subject AS "external_subject!"
         FROM sessions s
         JOIN LATERAL (
             SELECT provider, subject
             FROM external_identities
             WHERE user_id = s.user_id
             ORDER BY CASE provider
                 WHEN 'cloudflare' THEN 0
                 WHEN 'google' THEN 1
                 WHEN 'local' THEN 2
                 ELSE 3
             END, created_at
             LIMIT 1
         ) ei ON true
         WHERE s.token_hash = $1
           AND s.revoked_at IS NULL
           AND s.expires_at > now()"#,
        token_hash
    )
    .fetch_optional(pool)
    .await?
    .ok_or(AuthStoreError::Unauthenticated)?;

    let mut transaction = pool.begin().await?;
    set_household_context(&mut transaction, lookup.household_id).await?;
    let user = sqlx::query_as!(
        UserRecord,
        "SELECT id, email, full_name, picture_url, created_at, updated_at
         FROM users WHERE id = $1",
        lookup.user_id
    )
    .fetch_one(&mut *transaction)
    .await?;
    let household = load_household(&mut transaction, lookup.household_id).await?;
    let membership = sqlx::query_as!(
        MembershipRecord,
        "SELECT id, household_id, user_id, role, relationship_kind, is_active,
                created_at, updated_at
         FROM household_memberships
         WHERE household_id = $1 AND user_id = $2 AND is_active",
        lookup.household_id,
        lookup.user_id
    )
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(AuthStoreError::Unauthenticated)?;
    let settings = load_settings(&mut transaction, lookup.household_id).await?;
    let permissions = load_permissions(&mut transaction, lookup.household_id).await?;
    transaction.commit().await?;

    Ok(SessionContext {
        session_id: lookup.session_id,
        token: None,
        expires_at: lookup.expires_at,
        user,
        household,
        membership,
        settings,
        role_permissions: permissions,
        external_subject: lookup.external_subject,
    })
}

pub async fn allow_auth_bootstrap_request(
    pool: &PgPool,
    scope: &str,
    subject_hash: Vec<u8>,
) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query!(
        r#"INSERT INTO auth_rate_limits
            (scope, subject_hash, window_started, request_count)
         VALUES ($1,$2,now(),1)
         ON CONFLICT (scope, subject_hash) DO UPDATE
         SET request_count = CASE
                 WHEN auth_rate_limits.window_started <= now() - interval '60 seconds'
                 THEN 1
                 ELSE auth_rate_limits.request_count + 1
             END,
             window_started = CASE
                 WHEN auth_rate_limits.window_started <= now() - interval '60 seconds'
                 THEN now()
                 ELSE auth_rate_limits.window_started
             END,
             updated_at = now()
         RETURNING request_count <= 30 AS "allowed!""#,
        scope,
        subject_hash
    )
    .fetch_one(pool)
    .await?
    .allowed)
}

pub async fn revoke_session(pool: &PgPool, session_id: Uuid) -> Result<(), AuthStoreError> {
    sqlx::query!(
        "UPDATE sessions SET revoked_at = now(), updated_at = now() WHERE id = $1",
        session_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn resolve_identity_user(
    transaction: &mut Transaction<'_, Postgres>,
    provider: &str,
    subject: &str,
    email: &str,
    full_name: &str,
    picture_url: &str,
) -> Result<UserRecord, AuthStoreError> {
    let existing = sqlx::query_as!(
        UserRecord,
        "SELECT user_record.id, user_record.email, user_record.full_name,
                user_record.picture_url, user_record.created_at, user_record.updated_at
         FROM external_identities identity
         JOIN users user_record ON user_record.id = identity.user_id
         WHERE identity.provider = $1 AND identity.subject = $2",
        provider,
        subject
    )
    .fetch_optional(&mut **transaction)
    .await?;
    if let Some(existing) = existing {
        let email_owner =
            sqlx::query!("SELECT id FROM users WHERE lower(email) = lower($1)", email)
                .fetch_optional(&mut **transaction)
                .await?
                .map(|row| row.id);
        if email_owner.is_some_and(|user_id| user_id != existing.id) {
            return Err(AuthStoreError::InvalidIdentity);
        }
        return sqlx::query_as!(
            UserRecord,
            "UPDATE users
             SET email = $2, full_name = $3, picture_url = $4, updated_at = now()
             WHERE id = $1
             RETURNING id, email, full_name, picture_url, created_at, updated_at",
            existing.id,
            email,
            full_name,
            picture_url
        )
        .fetch_one(&mut **transaction)
        .await
        .map_err(AuthStoreError::from);
    }

    let user = upsert_user(transaction, email, full_name, picture_url).await?;
    let inserted = sqlx::query!(
        "INSERT INTO external_identities (user_id, provider, subject)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, subject) DO NOTHING",
        user.id,
        provider,
        subject
    )
    .execute(&mut **transaction)
    .await?;
    if inserted.rows_affected() == 0 {
        let mapped_user_id = sqlx::query!(
            "SELECT user_id FROM external_identities
             WHERE provider = $1 AND subject = $2",
            provider,
            subject
        )
        .fetch_one(&mut **transaction)
        .await?
        .user_id;
        if mapped_user_id != user.id {
            return Err(AuthStoreError::InvalidIdentity);
        }
    }
    Ok(user)
}

async fn upsert_user(
    transaction: &mut Transaction<'_, Postgres>,
    email: &str,
    full_name: &str,
    picture_url: &str,
) -> Result<UserRecord, sqlx::Error> {
    if let Some(user) = sqlx::query_as!(
        UserRecord,
        "SELECT id, email, full_name, picture_url, created_at, updated_at
         FROM users WHERE lower(email) = lower($1)",
        email
    )
    .fetch_optional(&mut **transaction)
    .await?
    {
        return sqlx::query_as!(
            UserRecord,
            "UPDATE users
             SET email = $2, full_name = $3, picture_url = $4, updated_at = now()
             WHERE id = $1
             RETURNING id, email, full_name, picture_url, created_at, updated_at",
            user.id,
            email,
            full_name,
            picture_url
        )
        .fetch_one(&mut **transaction)
        .await;
    }

    sqlx::query_as!(
        UserRecord,
        "INSERT INTO users (email, full_name, picture_url)
         VALUES ($1, $2, $3)
         RETURNING id, email, full_name, picture_url, created_at, updated_at",
        email,
        full_name,
        picture_url
    )
    .fetch_one(&mut **transaction)
    .await
}

async fn create_household(
    transaction: &mut Transaction<'_, Postgres>,
    user: &UserRecord,
    relationship_kind: &str,
    currency: &str,
    timezone: &str,
) -> Result<(HouseholdRecord, MembershipRecord, SettingsRecord), sqlx::Error> {
    let household_id = Uuid::now_v7();
    set_household_context(transaction, household_id).await?;
    let first_name = user
        .full_name
        .split_whitespace()
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("My");
    let household_name = if first_name.ends_with('s') {
        format!("{first_name}' Household")
    } else {
        format!("{first_name}'s Household")
    };
    let household = sqlx::query_as!(
        HouseholdRecord,
        "INSERT INTO households
            (id, name, base_currency, timezone, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, base_currency, timezone, created_by_user_id,
                   created_at, updated_at",
        household_id,
        household_name,
        currency,
        timezone,
        user.id
    )
    .fetch_one(&mut **transaction)
    .await?;
    let membership = sqlx::query_as!(
        MembershipRecord,
        "INSERT INTO household_memberships
            (household_id, user_id, role, relationship_kind)
         VALUES ($1, $2, 'owner', $3)
         RETURNING id, household_id, user_id, role, relationship_kind, is_active,
                   created_at, updated_at",
        household_id,
        user.id,
        relationship_kind
    )
    .fetch_one(&mut **transaction)
    .await?;
    let settings = sqlx::query_as!(
        SettingsRecord,
        "INSERT INTO household_settings (household_id)
         VALUES ($1)
         RETURNING id, household_id, privacy_mode, allow_cross_member_visibility,
                   projection_baseline_window_months, projection_horizon_months,
                   savings_allocation_strategy, backup_path, backup_retention,
                   created_at, updated_at",
        household_id
    )
    .fetch_one(&mut **transaction)
    .await?;
    seed_permissions(transaction, household_id).await?;
    seed_categories(transaction, household_id).await?;
    Ok((household, membership, settings))
}

async fn seed_permissions(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "INSERT INTO role_permissions
            (household_id, module, role, can_read, can_write, can_delete)
         VALUES
            ($1, 'planning', 'owner', true, true, true),
            ($1, 'planning', 'contributor', true, true, false),
            ($1, 'settings', 'owner', true, true, true),
            ($1, 'settings', 'contributor', true, false, false),
            ($1, 'imports', 'owner', true, true, false),
            ($1, 'imports', 'contributor', true, false, false),
            ($1, 'records', 'owner', true, true, true),
            ($1, 'records', 'contributor', true, true, false)",
        household_id
    )
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn seed_categories(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "INSERT INTO categories
            (household_id, kind, name, normalized_name, is_system, sort_order)
         VALUES
            ($1, 'expense', 'Other', 'other', true, 100),
            ($1, 'income', 'Household income', 'household income', true, 0),
            ($1, 'utility', 'Utilities', 'utilities', true, 0),
            ($1, 'planning', 'Debt Repayment', 'debt repayment', true, 0)",
        household_id
    )
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn load_household(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
) -> Result<HouseholdRecord, sqlx::Error> {
    sqlx::query_as!(
        HouseholdRecord,
        "SELECT id, name, base_currency, timezone, created_by_user_id,
                created_at, updated_at
         FROM households WHERE id = $1",
        household_id
    )
    .fetch_one(&mut **transaction)
    .await
}

async fn load_settings(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
) -> Result<SettingsRecord, sqlx::Error> {
    sqlx::query_as!(
        SettingsRecord,
        "SELECT id, household_id, privacy_mode, allow_cross_member_visibility,
                projection_baseline_window_months, projection_horizon_months,
                savings_allocation_strategy, backup_path, backup_retention,
                created_at, updated_at
         FROM household_settings WHERE household_id = $1",
        household_id
    )
    .fetch_one(&mut **transaction)
    .await
}

async fn load_permissions(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
) -> Result<Value, sqlx::Error> {
    let rows = sqlx::query_as!(
        PermissionRecord,
        "SELECT module, role, can_read, can_write, can_delete
         FROM role_permissions WHERE household_id = $1
         ORDER BY module, role",
        household_id
    )
    .fetch_all(&mut **transaction)
    .await?;
    let mut modules = Map::new();
    for row in rows {
        let roles = modules
            .entry(row.module)
            .or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(roles) = roles {
            roles.insert(
                row.role,
                json!({
                    "read": row.can_read,
                    "write": row.can_write,
                    "delete": row.can_delete
                }),
            );
        }
    }
    Ok(Value::Object(modules))
}

async fn set_household_context(
    transaction: &mut Transaction<'_, Postgres>,
    household_id: Uuid,
) -> Result<(), sqlx::Error> {
    let _ = sqlx::query!(
        r#"SELECT set_config('app.household_id', $1, true) AS "value!""#,
        household_id.to_string()
    )
    .fetch_one(&mut **transaction)
    .await?;
    Ok(())
}

fn generate_session_token() -> Result<(String, Vec<u8>), AuthStoreError> {
    let token = generate_opaque_token()?;
    let hash = hash_opaque_token(&token);
    Ok((token, hash))
}

pub fn generate_opaque_token() -> Result<String, AuthStoreError> {
    let mut bytes = [0_u8; 48];
    fill(&mut bytes).map_err(|_| AuthStoreError::Random)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

#[must_use]
pub fn hash_opaque_token(token: &str) -> Vec<u8> {
    hash_token(token.as_bytes())
}

fn hash_token(token: &[u8]) -> Vec<u8> {
    Sha256::digest(token).to_vec()
}
