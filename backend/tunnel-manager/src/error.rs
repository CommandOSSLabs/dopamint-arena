//! `ApiError` wire shape + a single response-builder helper. The JSON body matches
//! the `{ "error": { "code", "message" } }` envelope in ADR-0002.

use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ApiError {
    pub error: ApiErrorBody,
}

#[derive(Debug, Serialize)]
pub struct ApiErrorBody {
    pub code: String,
    pub message: String,
}

impl ApiError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            error: ApiErrorBody {
                code: code.to_owned(),
                message: message.to_owned(),
            },
        }
    }

    /// Build a `(StatusCode, Json<ApiError>)` response tuple.
    pub fn resp(status: StatusCode, code: &str, message: &str) -> (StatusCode, Json<ApiError>) {
        (status, Json(ApiError::new(code, message)))
    }
}
