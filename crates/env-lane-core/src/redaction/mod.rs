//! Secret detection shared by CLI presentation and Vault previews.
mod patterns;
use crate::text::trim;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use patterns::*;
use regex::Regex;
use std::{collections::HashMap, sync::LazyLock};
use url::Url;

pub struct Options {
    pub show_secrets: bool,
    pub redaction_text: String,
    pub detect_values: bool,
    pub min_redaction_length: usize,
    pub min_entropy_length: usize,
    pub entropy_threshold: f64,
    pub min_character_classes: usize,
    pub allow_keys: Vec<Regex>,
    pub deny_keys: Vec<Regex>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            show_secrets: false,
            redaction_text: "<redacted>".into(),
            detect_values: true,
            min_redaction_length: 8,
            min_entropy_length: 40,
            entropy_threshold: 4.0,
            min_character_classes: 3,
            allow_keys: Vec::new(),
            deny_keys: Vec::new(),
        }
    }
}

pub fn redact<'a>(key: &str, value: &'a str, options: &'a Options) -> &'a str {
    if should_redact(key, value, options) {
        &options.redaction_text
    } else {
        value
    }
}

pub fn should_redact(key: &str, value: &str, options: &Options) -> bool {
    !options.show_secrets
        && utf16_len(trim(value)) >= options.min_redaction_length
        && (is_secret_key(key, options)
            || (options.detect_values && is_secret_value(value, options)))
}

pub fn is_secret_key(key: &str, options: &Options) -> bool {
    let key = trim(key);
    if key.is_empty() {
        return false;
    }
    if matches_any(&options.deny_keys, key) {
        return true;
    }
    if matches_any(&options.allow_keys, key) {
        return false;
    }
    let key = normalize_key(key);
    if key.is_empty() || matches_any(&SAFE_KEY_PATTERNS, &key) {
        return false;
    }
    SENSITIVE_KEY_PHRASE_RE.is_match(&key)
        || COMPACT_SENSITIVE_KEY_RE.is_match(&key.replace('_', ""))
        || key == "key"
        || key
            .split('_')
            .any(|token| SENSITIVE_KEY_TOKENS.contains(&token))
}

pub fn is_secret_value(value: &str, options: &Options) -> bool {
    let value = trim(value);
    if value.is_empty() || is_safe_value(value) {
        return false;
    }
    if is_jwt(value) || is_paseto(value) || matches_any(&SECRET_VALUE_PATTERNS, value) {
        return true;
    }
    if has_url_credentials(value) || has_inline_assignment(value, options) {
        return true;
    }
    match Url::parse(value) {
        Ok(url) => {
            let url_options = Options {
                min_entropy_length: 16,
                entropy_threshold: 3.5,
                min_character_classes: 2,
                ..Default::default()
            };
            url.path()
                .split('/')
                .any(|part| is_high_entropy(part, &url_options))
                || url
                    .query_pairs()
                    .any(|(_, part)| is_high_entropy(&part, &url_options))
        }
        Err(_) => is_high_entropy(value, options),
    }
}

pub fn is_jwt(value: &str) -> bool {
    let value = trim(value);
    if !JWT_RE.is_match(value) {
        return false;
    }
    let mut parts = value.split('.');
    let decode = |part: &str| -> Option<serde_json::Value> {
        let bytes = URL_SAFE_NO_PAD.decode(part).ok()?;
        serde_json::from_slice(&bytes).ok()
    };
    let header = parts.next().and_then(decode);
    let payload = parts.next().and_then(decode);
    header
        .as_ref()
        .and_then(|value| value.get("alg"))
        .is_some_and(|alg| alg.is_string())
        && payload.is_some_and(|value| value.is_object() || value.is_array())
}

pub fn is_paseto(value: &str) -> bool {
    PASETO_RE.is_match(trim(value))
}

pub fn is_high_entropy(value: &str, options: &Options) -> bool {
    let value = trim(value);
    if is_safe_value(value)
        || utf16_len(value) < options.min_entropy_length
        || value.chars().any(crate::text::is_whitespace)
    {
        return false;
    }
    static IDENTIFIERS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"^[0-9]+$",
            r"(?i)^[a-z][a-z0-9-]{0,31}(?:,[a-z][a-z0-9-]{0,31})+$",
            r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            r"(?i)^[0-9a-f]{32,128}$",
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("identifier expression"))
        .collect()
    });
    if matches_any(&IDENTIFIERS, value) {
        return false;
    }
    let classes = [
        value.chars().any(|c| c.is_ascii_lowercase()),
        value.chars().any(|c| c.is_ascii_uppercase()),
        value.chars().any(|c| c.is_ascii_digit()),
        value.chars().any(|c| !c.is_ascii_alphanumeric()),
    ];
    if classes.into_iter().filter(|present| *present).count() < options.min_character_classes {
        return false;
    }
    let mut frequencies = HashMap::new();
    for character in value.chars() {
        *frequencies.entry(character).or_insert(0_usize) += 1;
    }
    let length = utf16_len(value) as f64;
    let entropy: f64 = frequencies
        .values()
        .map(|count| {
            let probability = *count as f64 / length;
            -probability * probability.log2()
        })
        .sum();
    entropy >= options.entropy_threshold
}

fn has_url_credentials(value: &str) -> bool {
    match Url::parse(value) {
        Ok(url) => {
            !url.username().is_empty()
                || url.password().is_some_and(|value| !value.is_empty())
                || url.query_pairs().any(|(key, value)| {
                    CREDENTIAL_QUERY_KEY_RE.is_match(&key) && utf16_len(trim(&value)) >= 8
                })
        }
        Err(_) => {
            static FALLBACK: LazyLock<Vec<Regex>> = LazyLock::new(|| {
                [
                r"://[^/@\s]+:[^/@\s]+@",
                r"(?i)[?&](?:_?token|access_?token|id_?token|refresh_?token|api_?key|key|secret|password|passwd|pwd|signature|sig|client_secret)=[^&\s]{8,}",
            ].into_iter().map(patterns::compile).collect()
            });
            matches_any(&FALLBACK, value)
        }
    }
}

fn has_inline_assignment(value: &str, options: &Options) -> bool {
    INLINE_KV_RE.captures_iter(value).any(|capture| {
        is_secret_key(&capture[1], options) || matches_any(&SECRET_VALUE_PATTERNS, &capture[2])
    })
}

fn is_safe_value(value: &str) -> bool {
    if matches_any(&SAFE_VALUE_PATTERNS, value) {
        return true;
    }
    let Some(rest) = value.strip_prefix("-----BEGIN ") else {
        return false;
    };
    let Some((label, body)) = rest.split_once("-----") else {
        return false;
    };
    (label == "PUBLIC KEY"
        || label.strip_suffix(" PUBLIC KEY").is_some_and(|prefix| {
            !prefix.is_empty()
                && prefix
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        }))
        && body
            .strip_suffix(&format!("-----END {label}-----"))
            .is_some_and(|body| !body.is_empty())
}

fn normalize_key(key: &str) -> String {
    static CAMEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])").unwrap());
    static ACRONYM: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"([A-Z]+)([A-Z][a-z])").unwrap());
    static SEPARATORS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9]+").unwrap());
    let key = CAMEL.replace_all(key, "${1}_${2}");
    let key = ACRONYM.replace_all(&key, "${1}_${2}").to_lowercase();
    SEPARATORS
        .replace_all(&key, "_")
        .trim_matches('_')
        .to_owned()
}
fn matches_any(patterns: &[Regex], value: &str) -> bool {
    patterns.iter().any(|pattern| pattern.is_match(value))
}
fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}
