//! Validate file-variant names before interpolating them into paths.
use crate::{
    error::{Error, Result},
    text::trim,
};

pub fn normalize_variant(
    value: Option<&str>,
    fallback: &str,
    allow_all: bool,
    field: &str,
) -> Result<String> {
    let original = value.unwrap_or(fallback);
    let normalized = trim(original);
    if normalized.is_empty() {
        return Ok(fallback.into());
    }
    if allow_all && normalized == "all" {
        return Ok(normalized.into());
    }
    if !normalized.as_bytes()[0].is_ascii_alphanumeric()
        || !normalized
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(Error::new(
            "INVALID_ENV_VARIANT",
            format!(
                "Invalid {field} '{original}'. Use values like production, staging, or default."
            ),
        ));
    }
    Ok(normalized.into())
}
