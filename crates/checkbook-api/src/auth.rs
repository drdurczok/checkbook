use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use checkbook_application::ApplicationError;
use checkbook_application::{AccessContext, allowed_scopes};
use checkbook_domain::{MembershipRole, RelationshipKind};
use checkbook_postgres::auth::{
    AuthStoreError, SessionContext, allow_auth_bootstrap_request, authenticate,
    create_development_session, create_identity_session, revoke_session,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{
    ApiState,
    dto::{
        HouseholdSettingsPayload, HouseholdSummary, MembershipSummary, SessionResponse, UserSummary,
    },
    error::{ApiError, ErrorBody},
};

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct DevAuthRequest {
    pub email: String,
    pub full_name: String,
    #[serde(default = "default_relationship")]
    pub relationship_kind: String,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct GoogleAuthRequest {
    pub credential: String,
}

fn default_relationship() -> String {
    "owner".to_owned()
}

pub async fn rate_limit_bootstrap(
    State(state): State<ApiState>,
    request: Request,
    next: Next,
) -> Response {
    let source = request
        .headers()
        .get("cf-connecting-ip")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("direct");
    let subject_hash = Sha256::digest(source.as_bytes()).to_vec();
    let allowed =
        match allow_auth_bootstrap_request(&state.pool, request.uri().path(), subject_hash).await {
            Ok(allowed) => allowed,
            Err(error) => {
                tracing::error!(%error, "authentication rate-limit storage failed");
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(ErrorBody {
                        detail: "Authentication service is temporarily unavailable.".to_owned(),
                    }),
                )
                    .into_response();
            }
        };
    if !allowed {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(ErrorBody {
                detail: "Too many authentication attempts.".to_owned(),
            }),
        )
            .into_response();
    }
    next.run(request).await
}

#[utoipa::path(
    post,
    path = "/api/auth/dev-login",
    request_body = DevAuthRequest,
    responses((status = 200, body = SessionResponse), (status = 403, body = ErrorBody))
)]
pub async fn dev_login(
    State(state): State<ApiState>,
    Json(payload): Json<DevAuthRequest>,
) -> Result<Json<SessionResponse>, ApiError> {
    if !state.dev_auth_enabled {
        return Err(ApiError(ApplicationError::Forbidden));
    }
    let context = create_development_session(
        &state.pool,
        &payload.email,
        &payload.full_name,
        &payload.relationship_kind,
        state.session_hours,
    )
    .await
    .map_err(map_auth_error)?;
    Ok(Json(session_response(
        &context,
        context.token.as_deref().unwrap_or(""),
    )))
}

pub async fn get_session(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<SessionResponse>, ApiError> {
    let token = bearer_token(&headers)?;
    let context = authenticate(&state.pool, token)
        .await
        .map_err(map_auth_error)?;
    Ok(Json(session_response(&context, token)))
}

pub async fn logout(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let token = bearer_token(&headers)?;
    let context = authenticate(&state.pool, token)
        .await
        .map_err(map_auth_error)?;
    revoke_session(&state.pool, context.session_id)
        .await
        .map_err(map_auth_error)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn cloudflare_session(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<SessionResponse>, (StatusCode, Json<ErrorBody>)> {
    let verifier = state.cloudflare.as_ref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorBody {
                detail: "Cloudflare Access JWT validation is not configured.".to_owned(),
            }),
        )
    })?;
    let assertion = headers
        .get("cf-access-jwt-assertion")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(ErrorBody {
                    detail: "Cloudflare Access assertion is required.".to_owned(),
                }),
            )
        })?;
    let claims = verifier.verify(assertion).await.map_err(|error| {
        let status = match error {
            crate::cloudflare::CloudflareError::KeysUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::UNAUTHORIZED,
        };
        (
            status,
            Json(ErrorBody {
                detail: error.to_string(),
            }),
        )
    })?;
    let full_name = if claims.name.trim().is_empty() {
        display_name_from_email(&claims.email)
    } else {
        claims.name
    };
    let context = create_identity_session(
        &state.pool,
        "cloudflare",
        &claims.sub,
        &claims.email,
        &full_name,
        "",
        "owner",
        state.session_hours,
    )
    .await
    .map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Internal server error.".to_owned(),
            }),
        )
    })?;
    Ok(Json(session_response(
        &context,
        context.token.as_deref().unwrap_or(""),
    )))
}

pub async fn google_login(
    State(state): State<ApiState>,
    Json(payload): Json<GoogleAuthRequest>,
) -> Result<Json<SessionResponse>, (StatusCode, Json<ErrorBody>)> {
    let verifier = state.google.as_ref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorBody {
                detail: "GOOGLE_CLIENT_ID is not configured.".to_owned(),
            }),
        )
    })?;
    if payload.credential.len() < 10 {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                detail: "Google token verification failed.".to_owned(),
            }),
        ));
    }
    let claims = verifier
        .verify(&payload.credential)
        .await
        .map_err(|error| {
            let status = match error {
                crate::google::GoogleError::KeysUnavailable => StatusCode::SERVICE_UNAVAILABLE,
                crate::google::GoogleError::NotConfigured
                | crate::google::GoogleError::InvalidCredential => StatusCode::UNAUTHORIZED,
            };
            (
                status,
                Json(ErrorBody {
                    detail: if status == StatusCode::SERVICE_UNAVAILABLE {
                        "Google signing keys are unavailable.".to_owned()
                    } else {
                        "Google token verification failed.".to_owned()
                    },
                }),
            )
        })?;
    let full_name = if claims.name.trim().is_empty() {
        display_name_from_email(&claims.email)
    } else {
        claims.name
    };
    let context = create_identity_session(
        &state.pool,
        "google",
        &claims.sub,
        &claims.email,
        &full_name,
        &claims.picture,
        "owner",
        state.session_hours,
    )
    .await
    .map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Internal server error.".to_owned(),
            }),
        )
    })?;
    Ok(Json(session_response(
        &context,
        context.token.as_deref().unwrap_or(""),
    )))
}

pub(crate) fn bearer_token(headers: &HeaderMap) -> Result<&str, ApiError> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| !token.is_empty())
        .ok_or(ApiError(ApplicationError::Unauthenticated))?;
    Ok(value)
}

pub(crate) fn map_auth_error(error: AuthStoreError) -> ApiError {
    match error {
        AuthStoreError::Unauthenticated => ApiError(ApplicationError::Unauthenticated),
        AuthStoreError::InvalidIdentity => ApiError(ApplicationError::Validation(
            "Invalid development identity.".to_owned(),
        )),
        AuthStoreError::Database(_) | AuthStoreError::Random => ApiError(ApplicationError::Storage),
    }
}

pub(crate) async fn authenticated(
    state: &ApiState,
    headers: &HeaderMap,
) -> Result<SessionContext, ApiError> {
    let token = bearer_token(headers)?;
    authenticate(&state.pool, token)
        .await
        .map_err(map_auth_error)
}

pub(crate) fn require_permission(
    context: &SessionContext,
    module: &str,
    action: &str,
) -> Result<(), ApiError> {
    if context
        .role_permissions
        .get(module)
        .and_then(|module| module.get(&context.membership.role))
        .and_then(|role| role.get(action))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        Ok(())
    } else {
        Err(ApiError(ApplicationError::Forbidden))
    }
}

pub(crate) fn allowed_scope_values(context: &SessionContext) -> Vec<String> {
    let role = match context.membership.role.as_str() {
        "owner" => MembershipRole::Owner,
        "contributor" => MembershipRole::Contributor,
        _ => return Vec::new(),
    };
    let relationship = match context.membership.relationship_kind.as_str() {
        "owner" => RelationshipKind::Owner,
        "spouse" => RelationshipKind::Spouse,
        "member" => RelationshipKind::Member,
        _ => return Vec::new(),
    };
    let mut scopes = allowed_scopes(AccessContext {
        role,
        relationship,
        allow_cross_member_visibility: context.settings.allow_cross_member_visibility,
    })
    .into_iter()
    .map(|scope| scope.as_api_str().to_owned())
    .collect::<Vec<_>>();
    scopes.sort();
    scopes
}

pub(crate) fn require_scope_access(context: &SessionContext, scope: &str) -> Result<(), ApiError> {
    if !matches!(scope, "self" | "spouse" | "joint") {
        return Err(ApiError(ApplicationError::Validation(
            "Invalid ownership scope.".to_owned(),
        )));
    }
    if allowed_scope_values(context)
        .iter()
        .any(|allowed| allowed == scope)
    {
        Ok(())
    } else {
        Err(ApiError(ApplicationError::Forbidden))
    }
}

pub(crate) fn session_response(context: &SessionContext, token: &str) -> SessionResponse {
    SessionResponse {
        token: token.to_owned(),
        expires_at: context.expires_at,
        user: UserSummary {
            id: context.user.id,
            email: context.user.email.clone(),
            full_name: context.user.full_name.clone(),
            picture_url: context.user.picture_url.clone(),
        },
        household: HouseholdSummary {
            id: context.household.id,
            name: context.household.name.clone(),
            base_currency: context.household.base_currency.clone(),
            timezone: context.household.timezone.clone(),
        },
        membership: MembershipSummary {
            id: context.membership.id,
            role: context.membership.role.clone(),
            relationship_kind: context.membership.relationship_kind.clone(),
        },
        settings: HouseholdSettingsPayload {
            id: context.settings.id,
            privacy_mode: context.settings.privacy_mode.clone(),
            allow_cross_member_visibility: context.settings.allow_cross_member_visibility,
            projection_baseline_window_months: context.settings.projection_baseline_window_months,
            projection_horizon_months: context.settings.projection_horizon_months,
            savings_allocation_strategy: context.settings.savings_allocation_strategy.clone(),
            role_permissions: context.role_permissions.clone(),
        },
    }
}

fn display_name_from_email(email: &str) -> String {
    email
        .split('@')
        .next()
        .unwrap_or(email)
        .split(['.', '_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut characters = part.chars();
            characters.next().map_or_else(String::new, |first| {
                first.to_uppercase().collect::<String>() + characters.as_str()
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}
