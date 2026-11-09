use chrono::{DateTime, NaiveDate, Utc};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::tenant;

#[derive(Debug, Clone)]
pub struct CategoryRecord {
    pub id: Uuid,
    pub kind: String,
    pub name: String,
    pub normalized_name: String,
    pub parent_id: Option<Uuid>,
    pub is_system: bool,
    pub sort_order: i32,
}

#[derive(Debug, Clone)]
pub struct InviteRecord {
    pub id: Uuid,
    pub email: String,
    pub role: String,
    pub relationship_kind: String,
    pub accepted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct GroupRecord {
    pub id: Uuid,
    pub kind: String,
    pub name: String,
    pub group_type: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    pub notes: String,
    pub metadata_payload: Value,
    pub tracked_fields: Value,
    pub sort_order: i32,
}

#[derive(Debug, Clone)]
pub struct EntryGroupInput {
    pub kind: String,
    pub name: String,
    pub group_type: String,
    pub started_on: Option<NaiveDate>,
    pub ended_on: Option<NaiveDate>,
    pub notes: String,
    pub metadata_payload: Value,
    pub tracked_fields: Value,
    pub sort_order: i32,
}

#[derive(Debug, Clone)]
pub struct NewInvitation {
    pub household_id: Uuid,
    pub invited_by_user_id: Uuid,
    pub email: String,
    pub role: String,
    pub relationship_kind: String,
    pub token_hash: Vec<u8>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, thiserror::Error)]
pub enum HouseholdStoreError {
    #[error("{0}")]
    ConflictMessage(String),
    #[error("conflict")]
    Conflict,
    #[error("not found")]
    NotFound,
    #[error("database error")]
    Database(#[from] sqlx::Error),
}

pub async fn list_categories(
    pool: &PgPool,
    household_id: Uuid,
) -> Result<Vec<CategoryRecord>, HouseholdStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let rows = sqlx::query_as!(
        CategoryRecord,
        "SELECT id, kind, name, normalized_name, parent_id, is_system, sort_order
         FROM categories
         WHERE household_id = $1
         ORDER BY kind, name",
        household_id
    )
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(rows)
}

pub async fn list_invitations(
    pool: &PgPool,
    household_id: Uuid,
) -> Result<Vec<InviteRecord>, HouseholdStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let rows = sqlx::query_as!(
        InviteRecord,
        "SELECT id, email, role, relationship_kind, accepted_at, created_at
         FROM household_invitations
         WHERE household_id = $1
         ORDER BY created_at DESC",
        household_id
    )
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(rows)
}

pub async fn create_invitation(
    pool: &PgPool,
    invitation: NewInvitation,
) -> Result<InviteRecord, HouseholdStoreError> {
    let mut transaction = tenant::begin(pool, invitation.household_id, false).await?;
    let duplicate_email = sqlx::query!(
        "SELECT EXISTS(
            SELECT 1
            FROM household_memberships membership
            JOIN users user_record ON user_record.id = membership.user_id
            WHERE membership.household_id = $1 AND membership.is_active
              AND user_record.email = $2
            UNION ALL
            SELECT 1
            FROM household_invitations invitation
            WHERE invitation.household_id = $1 AND invitation.email = $2
              AND invitation.accepted_at IS NULL AND invitation.expires_at > now()
         ) AS \"duplicate_email!\"",
        invitation.household_id,
        &invitation.email
    )
    .fetch_one(&mut *transaction)
    .await?
    .duplicate_email;
    if duplicate_email {
        return Err(HouseholdStoreError::ConflictMessage(
            "This person is already a member or has a pending invitation.".to_owned(),
        ));
    }
    if matches!(invitation.relationship_kind.as_str(), "owner" | "spouse") {
        let occupied_slot = sqlx::query!(
            "SELECT EXISTS(
                SELECT 1 FROM household_memberships
                WHERE household_id = $1 AND is_active AND relationship_kind = $2
                UNION ALL
                SELECT 1 FROM household_invitations
                WHERE household_id = $1 AND relationship_kind = $2
                  AND accepted_at IS NULL AND expires_at > now()
             ) AS \"occupied_slot!\"",
            invitation.household_id,
            &invitation.relationship_kind
        )
        .fetch_one(&mut *transaction)
        .await?
        .occupied_slot;
        if occupied_slot {
            return Err(HouseholdStoreError::ConflictMessage(format!(
                "The {} household slot is already occupied or invited.",
                invitation.relationship_kind
            )));
        }
    }
    let row = sqlx::query_as!(
        InviteRecord,
        "INSERT INTO household_invitations
            (household_id, invited_by_user_id, email, role, relationship_kind,
             token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, email, role, relationship_kind, accepted_at, created_at",
        invitation.household_id,
        invitation.invited_by_user_id,
        invitation.email,
        invitation.role,
        invitation.relationship_kind,
        invitation.token_hash,
        invitation.expires_at
    )
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(row)
}

pub async fn list_groups(
    pool: &PgPool,
    household_id: Uuid,
    kind: Option<String>,
    include_historic: bool,
    today: NaiveDate,
) -> Result<Vec<GroupRecord>, HouseholdStoreError> {
    let mut transaction = tenant::begin(pool, household_id, true).await?;
    let rows = sqlx::query_as!(
        GroupRecord,
        "SELECT id, kind, name, group_type, started_on, ended_on, notes,
                metadata_payload, tracked_fields, sort_order
         FROM entry_groups
         WHERE household_id = $1
           AND ($2::text IS NULL OR kind = $2)
           AND ($3 OR ended_on IS NULL OR ended_on >= $4)
         ORDER BY kind, sort_order, name",
        household_id,
        kind,
        include_historic,
        today
    )
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(rows)
}

pub async fn create_group(
    pool: &PgPool,
    household_id: Uuid,
    input: EntryGroupInput,
) -> Result<GroupRecord, HouseholdStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let row = sqlx::query_as!(
        GroupRecord,
        "INSERT INTO entry_groups
            (household_id, kind, name, group_type, started_on, ended_on, notes,
             metadata_payload, tracked_fields, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, kind, name, group_type, started_on, ended_on, notes,
                   metadata_payload, tracked_fields, sort_order",
        household_id,
        input.kind,
        input.name,
        input.group_type,
        input.started_on,
        input.ended_on,
        input.notes,
        input.metadata_payload,
        input.tracked_fields,
        input.sort_order
    )
    .fetch_one(&mut *transaction)
    .await
    .map_err(map_write_error)?;
    transaction.commit().await?;
    Ok(row)
}

pub async fn update_group(
    pool: &PgPool,
    household_id: Uuid,
    group_id: Uuid,
    input: EntryGroupInput,
) -> Result<GroupRecord, HouseholdStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let row = sqlx::query_as!(
        GroupRecord,
        "UPDATE entry_groups
         SET kind = $3, name = $4, group_type = $5, started_on = $6,
             ended_on = $7, notes = $8, metadata_payload = $9,
             tracked_fields = $10, sort_order = $11, updated_at = now()
         WHERE household_id = $1 AND id = $2
         RETURNING id, kind, name, group_type, started_on, ended_on, notes,
                   metadata_payload, tracked_fields, sort_order",
        household_id,
        group_id,
        input.kind,
        input.name,
        input.group_type,
        input.started_on,
        input.ended_on,
        input.notes,
        input.metadata_payload,
        input.tracked_fields,
        input.sort_order
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(map_write_error)?
    .ok_or(HouseholdStoreError::NotFound)?;
    transaction.commit().await?;
    Ok(row)
}

pub async fn delete_group(
    pool: &PgPool,
    household_id: Uuid,
    group_id: Uuid,
) -> Result<(), HouseholdStoreError> {
    let mut transaction = tenant::begin(pool, household_id, false).await?;
    let result = sqlx::query!(
        "DELETE FROM entry_groups WHERE household_id = $1 AND id = $2",
        household_id,
        group_id
    )
    .execute(&mut *transaction)
    .await?;
    if result.rows_affected() == 0 {
        return Err(HouseholdStoreError::NotFound);
    }
    transaction.commit().await?;
    Ok(())
}

fn map_write_error(error: sqlx::Error) -> HouseholdStoreError {
    if error
        .as_database_error()
        .is_some_and(|database| database.is_unique_violation())
    {
        HouseholdStoreError::Conflict
    } else {
        HouseholdStoreError::Database(error)
    }
}
