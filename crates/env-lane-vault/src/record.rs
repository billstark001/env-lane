//! Decode durable record versions into a single effective-value model.
use env_lane_core::{
    document::{LineKind, parse_line},
    error::{Error, Result},
    paths::{relative_path, resolve_path},
    text::trim,
};
use serde_json::Value;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

// u64::MAX rounds up to 2^64 as f64. Use the exclusive bound before casting,
// otherwise the boundary timestamp silently becomes a different integer.
const U64_EXCLUSIVE_BOUND: f64 = 18_446_744_073_709_551_616.0;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Version {
    Legacy,
    Effective,
}
#[derive(Clone)]
pub enum Change {
    Set(Zeroizing<String>),
    Delete,
}
#[derive(Clone)]
pub struct Record {
    pub version: Version,
    pub file: PathBuf,
    pub key: String,
    pub timestamp: f64,
    pub change: Change,
    pub order: usize,
}

pub fn decode(plaintext: &str, base: &Path, invocation_cwd: &Path, order: usize) -> Result<Record> {
    let raw: Value =
        serde_json::from_str(plaintext).map_err(|_| invalid("Store record is not valid JSON."))?;
    let raw = raw
        .as_object()
        .ok_or_else(|| invalid("Store record must be a JSON object."))?;
    let version = match raw.get("version") {
        None => Version::Legacy,
        Some(value) if value.as_f64() == Some(0.0) => Version::Legacy,
        Some(value) if value.as_f64() == Some(1.0) => Version::Effective,
        _ => return Err(invalid("Store record has unsupported schema version.")),
    };
    let file = raw
        .get("f")
        .and_then(Value::as_str)
        .filter(|value| !trim(value).is_empty())
        .ok_or_else(|| invalid("Store record is missing file path."))?;
    let key = raw
        .get("k")
        .and_then(Value::as_str)
        .filter(|value| !trim(value).is_empty())
        .ok_or_else(|| invalid("Store record is missing key name."))?;
    let timestamp = raw
        .get("t")
        .and_then(timestamp)
        .filter(|time| time.is_finite() && *time >= 0.0)
        .ok_or_else(|| invalid("Store record has invalid timestamp."))?;
    let change = match raw.get("op").and_then(Value::as_str) {
        None if !raw.contains_key("op") => set_value(raw.get("v"), key, version)?,
        Some("set") => set_value(raw.get("v"), key, version)?,
        Some("delete") => Change::Delete,
        _ => return Err(invalid("Unsupported record operation.")),
    };
    let file = match version {
        Version::Legacy => resolve_path(invocation_cwd, Path::new(file)),
        Version::Effective => resolve_record_path(base, file)?,
    };
    Ok(Record {
        version,
        file,
        key: key.into(),
        timestamp,
        change,
        order,
    })
}

pub fn encode(record: &Record, base: &Path) -> Result<Zeroizing<String>> {
    if !record.timestamp.is_finite() || record.timestamp < 0.0 {
        return Err(invalid("Store record has invalid timestamp."));
    }
    if trim(&record.key).is_empty() {
        return Err(invalid("Store record is missing key name."));
    }
    let file = encode_record_path(base, &record.file)?;
    let mut raw = serde_json::Map::new();
    // New writes always use effective values and portable schema-v1 paths.
    raw.insert("version".into(), Value::from(1));
    raw.insert("f".into(), Value::from(file));
    raw.insert("k".into(), Value::from(record.key.clone()));
    raw.insert(
        "t".into(),
        if record.timestamp.fract() == 0.0
            && record.timestamp >= 0.0
            && record.timestamp < U64_EXCLUSIVE_BOUND
        {
            Value::from(record.timestamp as u64)
        } else {
            Value::from(record.timestamp)
        },
    );
    match &record.change {
        Change::Set(value) => {
            raw.insert("op".into(), Value::from("set"));
            raw.insert("v".into(), Value::from(value.to_string()));
        }
        Change::Delete => {
            raw.insert("op".into(), Value::from("delete"));
        }
    }
    serde_json::to_string(&raw)
        .map(Zeroizing::new)
        .map_err(|_| invalid("Cannot serialize vault record."))
}

pub fn resolve_record_path(base: &Path, stored: &str) -> Result<PathBuf> {
    validate_portable(stored)?;
    Ok(resolve_path(base, Path::new(stored)))
}
pub fn encode_record_path(base: &Path, file: &Path) -> Result<String> {
    let relative = relative_path(base, file);
    let relative = if relative.is_empty() {
        ".".to_owned()
    } else {
        relative
    };
    validate_portable(&relative)?;
    Ok(relative)
}
fn validate_portable(path: &str) -> Result<()> {
    if path.is_empty() || path.contains('\0') {
        return Err(invalid("Vault record has an invalid file path."));
    }
    let bytes = path.as_bytes();
    if path.starts_with('/')
        || path.contains('\\')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
    {
        return Err(invalid(
            "Vault version 1 record file paths must be portable relative paths.",
        ));
    }
    Ok(())
}
fn set_value(value: Option<&Value>, key: &str, version: Version) -> Result<Change> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Set record is missing string value."))?;
    let effective = if version == Version::Legacy {
        let line = parse_line(&format!("{key}={value}"), 0);
        let LineKind::Entry(entry) = line.kind else {
            return Err(invalid("Version 0 record contains an invalid raw value."));
        };
        entry.effective_value
    } else {
        value.to_owned()
    };
    Ok(Change::Set(Zeroizing::new(effective)))
}

// Persisted v0 records may contain a numeric string. Coercion is isolated to
// wire decoding; application code always receives a finite non-negative number.
fn timestamp(value: &Value) -> Option<f64> {
    match value {
        Value::Number(value) => value.as_f64(),
        Value::Null => Some(0.0),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        Value::String(value) if trim(value).is_empty() => Some(0.0),
        Value::String(value) => numeric_string(trim(value)),
        Value::Array(values) if values.is_empty() => Some(0.0),
        // Number([x]) coerces through Array#toString. A single nested array
        // repeats that coercion; multiple items produce a comma and are NaN.
        Value::Array(values) if values.len() == 1 => match &values[0] {
            Value::String(_) | Value::Number(_) | Value::Null | Value::Array(_) => {
                timestamp(&values[0])
            }
            _ => None,
        },
        _ => None,
    }
}

/// JavaScript's `Number(string)` accepts unsigned radix prefixes in legacy
/// timestamps. Keep that coercion at the record boundary; new records write
/// numeric timestamps.
fn numeric_string(value: &str) -> Option<f64> {
    let radix = [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ]
    .into_iter()
    .find_map(|(prefix, radix)| value.strip_prefix(prefix).map(|digits| (digits, radix)));
    if let Some((digits, radix)) = radix {
        if digits.is_empty() {
            return None;
        }
        return digits.chars().try_fold(0.0, |number, digit| {
            digit
                .to_digit(radix)
                .map(|value| number * f64::from(radix) + f64::from(value))
        });
    }
    value.parse().ok()
}
fn invalid(message: &str) -> Error {
    Error::new("VAULT_INVALID_RECORD", message)
}
