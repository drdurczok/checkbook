use thiserror::Error;

use checkbook_domain::DomainError;

#[derive(Debug, Error)]
pub enum ApplicationError {
    #[error("{0}")]
    Validation(String),
    #[error("authentication required")]
    Unauthenticated,
    #[error("permission denied")]
    Forbidden,
    #[error("resource not found")]
    NotFound,
    #[error("resource conflict")]
    Conflict,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    NotFoundMessage(String),
    #[error("{0}")]
    ConflictMessage(String),
    #[error("domain error: {0}")]
    Domain(#[from] DomainError),
    #[error("storage error")]
    Storage,
}
