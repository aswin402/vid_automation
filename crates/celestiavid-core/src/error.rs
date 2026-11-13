use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Error)]
#[error("[{error_code}] {message}")]
pub struct AppError {
    pub error_code: String,
    pub message: String,
    #[serde(skip)]
    pub status_code: u16,
    #[serde(skip)]
    pub internal_detail: Option<String>,
}

impl AppError {
    pub fn new(
        error_code: impl Into<String>,
        message: impl Into<String>,
        status_code: u16,
    ) -> Self {
        Self {
            error_code: error_code.into(),
            message: message.into(),
            status_code,
            internal_detail: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.internal_detail = Some(detail.into());
        self
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("NOT_FOUND", message, 404)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new("FORBIDDEN", message, 403)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new("BAD_REQUEST", message, 400)
    }

    pub fn validation(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, message, 400)
    }

    pub fn internal(code: impl Into<String>, message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(code, message, 500).with_detail(detail)
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        Self::internal("DATABASE_ERROR", "Local project database error occurred.", err.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        Self::internal("IO_ERROR", "Local file I/O operation failed.", err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        Self::validation("JSON_ERROR", format!("Invalid JSON payload: {err}"))
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let body = serde_json::json!({
            "error_code": self.error_code,
            "message": self.message,
        });
        (status, Json(body)).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
