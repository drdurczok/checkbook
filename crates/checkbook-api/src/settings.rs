use axum::{Json, extract::State, http::HeaderMap};
use checkbook_application::ApplicationError;
use checkbook_postgres::{
    auth::authenticate,
    settings::{HouseholdSettingsPatch, update_household_settings},
};

use crate::{
    ApiState,
    auth::{authenticated, bearer_token, map_auth_error, require_permission},
    dto::{HouseholdSettingsPayload, SettingsUpdateRequest},
    error::ApiError,
};

pub async fn get(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<HouseholdSettingsPayload>, ApiError> {
    let token = bearer_token(&headers)?;
    let context = authenticate(&state.pool, token)
        .await
        .map_err(map_auth_error)?;
    require_permission(&context, "settings", "read")?;
    Ok(Json(settings_response(&context)))
}

pub async fn update(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<SettingsUpdateRequest>,
) -> Result<Json<HouseholdSettingsPayload>, ApiError> {
    validate(&payload)?;
    let context = authenticated(&state, &headers).await?;
    require_permission(&context, "settings", "write")?;
    update_household_settings(
        &state.pool,
        context.household.id,
        HouseholdSettingsPatch {
            privacy_mode: payload.privacy_mode,
            allow_cross_member_visibility: payload.allow_cross_member_visibility,
            projection_baseline_window_months: payload.projection_baseline_window_months,
            projection_horizon_months: payload.projection_horizon_months,
            savings_allocation_strategy: payload.savings_allocation_strategy,
            role_permissions: payload.role_permissions,
            actor_user_id: context.user.id,
        },
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, "settings update failed");
        ApiError(ApplicationError::Storage)
    })?;
    let token = bearer_token(&headers)?;
    let updated = authenticate(&state.pool, token)
        .await
        .map_err(map_auth_error)?;
    Ok(Json(settings_response(&updated)))
}

fn settings_response(
    context: &checkbook_postgres::auth::SessionContext,
) -> HouseholdSettingsPayload {
    HouseholdSettingsPayload {
        id: context.settings.id,
        privacy_mode: context.settings.privacy_mode.clone(),
        allow_cross_member_visibility: context.settings.allow_cross_member_visibility,
        projection_baseline_window_months: context.settings.projection_baseline_window_months,
        projection_horizon_months: context.settings.projection_horizon_months,
        savings_allocation_strategy: context.settings.savings_allocation_strategy.clone(),
        role_permissions: context.role_permissions.clone(),
    }
}

fn validate(payload: &SettingsUpdateRequest) -> Result<(), ApiError> {
    if payload
        .projection_baseline_window_months
        .is_some_and(|months| !(1..=24).contains(&months))
        || payload
            .projection_horizon_months
            .is_some_and(|months| !(3..=60).contains(&months))
    {
        return Err(ApiError(ApplicationError::Validation(
            "Projection settings are outside the supported range.".to_owned(),
        )));
    }
    Ok(())
}
