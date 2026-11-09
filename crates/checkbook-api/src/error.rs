use axum::{Json, response::IntoResponse};
use checkbook_application::ApplicationError;
use http::StatusCode;
use serde::Serialize;

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ErrorBody {
    pub detail: String,
}

pub struct ApiError(pub ApplicationError);

pub(crate) fn expense_source_validation(error: &sqlx::Error) -> Option<ApiError> {
    let database = error.as_database_error()?;
    let detail = match database.message() {
        "Properties with identical names cannot share an expense category"
        | "Expense category name is already linked to another property"
        | "Expense category name already exists; choose a distinct property name"
        | "Loans and projects with identical names cannot share an expense group"
        | "Expense group name is already linked to another source"
        | "Expense group name already exists; choose a distinct source name"
        | "Linked property has no expense category"
        | "A source-linked group must belong to a property category or Uncategorized"
        | "Delete the linked property instead of its expense category"
        | "Delete the linked loan or project instead of its expense group" => database.message(),
        _ if database.code().as_deref() == Some("23505") => match database.constraint() {
            Some("expense_groups_household_id_normalized_name_key") => {
                "An expense category with this name already exists."
            }
            Some("categories_root_unique") => "An expense group with this name already exists.",
            _ => return None,
        },
        _ => return None,
    };
    Some(ApiError(ApplicationError::Validation(detail.to_owned())))
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, detail) = match self.0 {
            ApplicationError::Validation(detail) => (StatusCode::UNPROCESSABLE_ENTITY, detail),
            ApplicationError::Unauthenticated => (
                StatusCode::UNAUTHORIZED,
                "Authentication required.".to_owned(),
            ),
            ApplicationError::Forbidden => (StatusCode::FORBIDDEN, "Permission denied.".to_owned()),
            ApplicationError::NotFound => (StatusCode::NOT_FOUND, "Resource not found.".to_owned()),
            ApplicationError::Conflict => (StatusCode::CONFLICT, "Resource conflict.".to_owned()),
            ApplicationError::BadRequest(detail) => (StatusCode::BAD_REQUEST, detail),
            ApplicationError::NotFoundMessage(detail) => (StatusCode::NOT_FOUND, detail),
            ApplicationError::ConflictMessage(detail) => (StatusCode::CONFLICT, detail),
            ApplicationError::Domain(error) => {
                (StatusCode::UNPROCESSABLE_ENTITY, error.to_string())
            }
            ApplicationError::Storage => {
                crate::metrics::observe_storage_error();
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error.".to_owned(),
                )
            }
        };
        (status, Json(ErrorBody { detail })).into_response()
    }
}
