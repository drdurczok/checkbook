use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use checkbook_application::ApplicationError;
use checkbook_domain::local_date_at;
use checkbook_postgres::{
    auth::{authenticate, generate_opaque_token, hash_opaque_token},
    household::{
        EntryGroupInput, GroupRecord, HouseholdStoreError, InviteRecord, NewInvitation,
        create_group as store_create_group, create_invitation as store_create_invitation,
        delete_group as store_delete_group, list_categories, list_groups,
        list_invitations as store_list_invitations, update_group as store_update_group,
    },
};
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    ApiState,
    auth::{authenticated, bearer_token, map_auth_error, require_permission},
    dto::{
        CategoryResponse, EntryGroupPayload, EntryGroupResponse, InvitePayload, InviteResponse,
        RawHousehold, RawHouseholdContextResponse, RawMembership, RawSettings, RawUser,
        TrackedField,
    },
    error::ApiError,
};

pub async fn get_household_me(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<RawHouseholdContextResponse>, ApiError> {
    let token = bearer_token(&headers)?;
    let context = authenticate(&state.pool, token)
        .await
        .map_err(map_auth_error)?;
    Ok(Json(RawHouseholdContextResponse {
        household: RawHousehold {
            id: context.household.id,
            name: context.household.name,
            base_currency: context.household.base_currency,
            timezone: context.household.timezone,
            created_by_user_id: context.household.created_by_user_id,
            created_at: context.household.created_at,
            updated_at: context.household.updated_at,
        },
        membership: RawMembership {
            id: context.membership.id,
            household_id: context.membership.household_id,
            user_id: context.membership.user_id,
            role: context.membership.role,
            relationship_kind: context.membership.relationship_kind,
            is_active: context.membership.is_active,
            created_at: context.membership.created_at,
            updated_at: context.membership.updated_at,
        },
        settings: RawSettings {
            id: context.settings.id,
            household_id: context.settings.household_id,
            privacy_mode: context.settings.privacy_mode,
            allow_cross_member_visibility: context.settings.allow_cross_member_visibility,
            projection_baseline_window_months: context.settings.projection_baseline_window_months,
            projection_horizon_months: context.settings.projection_horizon_months,
            savings_allocation_strategy: context.settings.savings_allocation_strategy,
            role_permissions: context.role_permissions,
            backup_config: if context.settings.backup_path.is_empty()
                && context.settings.backup_retention == 0
            {
                json!({})
            } else {
                json!({
                    "path": context.settings.backup_path,
                    "retention": context.settings.backup_retention
                })
            },
            created_at: context.settings.created_at,
            updated_at: context.settings.updated_at,
        },
        user: RawUser {
            id: context.user.id,
            google_sub: context.external_subject,
            email: context.user.email,
            full_name: context.user.full_name,
            picture_url: context.user.picture_url,
            created_at: context.user.created_at,
            updated_at: context.user.updated_at,
        },
    }))
}

pub async fn categories(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<CategoryResponse>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let rows = list_categories(&state.pool, context.household.id)
        .await
        .map_err(map_store_error)?;
    Ok(Json(
        rows.into_iter()
            .map(|row| CategoryResponse {
                id: row.id,
                kind: row.kind,
                name: row.name,
                normalized_name: row.normalized_name,
                parent_id: row.parent_id,
                is_system: row.is_system,
                sort_order: row.sort_order,
            })
            .collect(),
    ))
}

pub async fn list_invitations(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<InviteResponse>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "settings", "read")?;
    let rows = store_list_invitations(&state.pool, context.household.id)
        .await
        .map_err(map_store_error)?;
    Ok(Json(
        rows.into_iter()
            .map(|row| invite_response(row, String::new()))
            .collect(),
    ))
}

pub async fn create_invitation(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<InvitePayload>,
) -> Result<Json<InviteResponse>, ApiError> {
    let email = payload.email.trim().to_ascii_lowercase();
    if email.len() > 320 || !email.contains('@') {
        return Err(ApiError(ApplicationError::Validation(
            "Invalid invitation email.".to_owned(),
        )));
    }
    if !matches!(payload.role.as_str(), "owner" | "contributor") {
        return Err(ApiError(ApplicationError::Validation(
            "Invalid invitation role.".to_owned(),
        )));
    }
    if !matches!(
        payload.relationship_kind.as_str(),
        "owner" | "spouse" | "member"
    ) {
        return Err(ApiError(ApplicationError::Validation(
            "Invalid invitation relationship.".to_owned(),
        )));
    }
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "settings", "write")?;
    let token = generate_opaque_token().map_err(map_auth_error)?;
    let token_hash = hash_opaque_token(&token);
    let expires_at = Utc::now() + Duration::days(14);
    let row = store_create_invitation(
        &state.pool,
        NewInvitation {
            household_id: context.household.id,
            invited_by_user_id: context.user.id,
            email,
            role: payload.role,
            relationship_kind: payload.relationship_kind,
            token_hash,
            expires_at,
        },
    )
    .await
    .map_err(map_store_error)?;
    Ok(Json(invite_response(row, token)))
}

fn invite_response(row: InviteRecord, token: String) -> InviteResponse {
    InviteResponse {
        id: row.id,
        email: row.email,
        role: row.role,
        relationship_kind: row.relationship_kind,
        token,
        accepted_at: row.accepted_at,
        created_at: row.created_at,
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct GroupQuery {
    kind: Option<String>,
    #[serde(default)]
    include_historic: bool,
}

pub async fn groups(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<GroupQuery>,
) -> Result<Json<Vec<EntryGroupResponse>>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    let today = local_date_at(&context.household.timezone, Utc::now()).map_err(|error| {
        tracing::error!(%error, "household timezone is invalid");
        ApiError(ApplicationError::Storage)
    })?;
    let rows = list_groups(
        &state.pool,
        context.household.id,
        query.kind,
        query.include_historic,
        today,
    )
    .await
    .map_err(map_store_error)?;
    rows.into_iter()
        .map(group_response)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

fn group_input(payload: EntryGroupPayload) -> Result<EntryGroupInput, ApiError> {
    let tracked_fields = serde_json::to_value(&payload.tracked_fields)
        .map_err(|_| ApiError(ApplicationError::Storage))?;
    Ok(EntryGroupInput {
        kind: payload.kind,
        name: payload.name.trim().to_owned(),
        group_type: payload.group_type,
        started_on: payload.started_on,
        ended_on: payload.ended_on,
        notes: payload.notes,
        metadata_payload: payload.metadata_payload,
        tracked_fields,
        sort_order: payload.sort_order,
    })
}

pub async fn create_group(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<EntryGroupPayload>,
) -> Result<Json<EntryGroupResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    if payload.kind == "contract" {
        return Err(ApiError(ApplicationError::Validation(
            "Standalone contracts are no longer supported; use property-owned utility contracts."
                .to_owned(),
        )));
    }
    validate_group(&payload)?;
    let input = group_input(payload)?;
    let row = store_create_group(&state.pool, context.household.id, input)
        .await
        .map_err(map_store_error)?;
    Ok(Json(group_response(row)?))
}

pub async fn update_group(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(group_id): Path<Uuid>,
    Json(payload): Json<EntryGroupPayload>,
) -> Result<Json<EntryGroupResponse>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "write")?;
    validate_group(&payload)?;
    let input = group_input(payload)?;
    let row = store_update_group(&state.pool, context.household.id, group_id, input)
        .await
        .map_err(map_store_error)?;
    Ok(Json(group_response(row)?))
}

pub async fn delete_group(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(group_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "records", "delete")?;
    store_delete_group(&state.pool, context.household.id, group_id)
        .await
        .map_err(map_store_error)?;
    Ok(Json(json!({ "ok": true })))
}

fn validate_group(payload: &EntryGroupPayload) -> Result<(), ApiError> {
    if payload.kind != "contract" {
        return Err(ApiError(ApplicationError::Validation(
            "Location and income source groups are no longer supported.".to_owned(),
        )));
    }
    if payload.name.trim().is_empty() {
        return Err(ApiError(ApplicationError::Validation(
            "Group name is required.".to_owned(),
        )));
    }
    if payload
        .ended_on
        .zip(payload.started_on)
        .is_some_and(|(end, start)| end < start)
    {
        return Err(ApiError(ApplicationError::Validation(
            "End date must not be before start date.".to_owned(),
        )));
    }
    Ok(())
}

fn group_response(row: GroupRecord) -> Result<EntryGroupResponse, ApiError> {
    let tracked_fields = serde_json::from_value::<Vec<TrackedField>>(row.tracked_fields)
        .map_err(|_| ApiError(ApplicationError::Storage))?;
    Ok(EntryGroupResponse {
        id: row.id,
        kind: row.kind,
        name: row.name,
        group_type: row.group_type,
        started_on: row.started_on,
        ended_on: row.ended_on,
        notes: row.notes,
        metadata_payload: row.metadata_payload,
        tracked_fields,
        sort_order: row.sort_order,
    })
}

fn map_store_error(error: HouseholdStoreError) -> ApiError {
    match error {
        HouseholdStoreError::ConflictMessage(detail) => {
            ApiError(ApplicationError::ConflictMessage(detail))
        }
        HouseholdStoreError::Conflict => ApiError(ApplicationError::Conflict),
        HouseholdStoreError::NotFound => ApiError(ApplicationError::NotFound),
        HouseholdStoreError::Database(error) => {
            tracing::error!(%error, "household database operation failed");
            ApiError(ApplicationError::Storage)
        }
    }
}
