use crate::{config::Transform, text::trim};

pub(super) fn transform(value: &str, operation: Option<&Transform>) -> String {
    let Some(operation) = operation else {
        return value.to_owned();
    };
    let trimmed = trim(value);
    match operation {
        Transform::Trim => trimmed.to_owned(),
        Transform::Lowercase => trimmed.to_lowercase(),
        Transform::Uppercase => trimmed.to_uppercase(),
        Transform::UrlBase => trimmed.trim_end_matches('/').to_owned(),
        Transform::UrlBaseSlash => {
            let base = trimmed.trim_end_matches('/');
            if base.is_empty() {
                String::new()
            } else {
                format!("{base}/")
            }
        }
    }
}

pub(super) fn interpolate(pattern: &str, build: &str) -> String {
    pattern
        .replace("{build}", build)
        .replace("{variant}", build)
}
