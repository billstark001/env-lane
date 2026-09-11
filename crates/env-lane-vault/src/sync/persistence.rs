//! Merge only changes made since loading, under the state-file lock. Concurrent
//! operations on unrelated entries must not overwrite each other's baselines.
use super::{Context, Entry};
use crate::lock;
use env_lane_core::{
    error::{Error, Result},
    storage,
};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;
use std::{fs, path::Path};

pub(super) struct Loaded {
    pub entries: IndexMap<String, Entry>,
    pub legacy: bool,
}

pub(super) fn read(path: &Path) -> Result<Loaded> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Loaded {
                entries: IndexMap::new(),
                legacy: false,
            });
        }
        Err(error) => {
            return Err(Error::new(
                "VAULT_SYNC_STATE_READ_FAILED",
                format!("Cannot read sync state {}: {error}", path.display()),
            ));
        }
    };
    let text = String::from_utf8_lossy(&bytes);
    let raw: Value = serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text))
        .map_err(|_| invalid(path, "VAULT_INVALID_SYNC_STATE"))?;
    let raw = raw
        .as_object()
        .ok_or_else(|| invalid(path, "VAULT_INVALID_SYNC_STATE"))?;
    let entries = raw
        .get("entries")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid(path, "VAULT_UNSUPPORTED_SYNC_STATE"))?;
    let version = raw.get("version").and_then(Value::as_f64);
    // Unsalted legacy hashes cannot establish a safe keyed baseline. Recognize
    // that persisted format only to discard it and build fresh v1 fingerprints.
    let legacy = !raw.contains_key("version")
        || version == Some(0.0)
        || (version == Some(1.0)
            && !raw.contains_key("fingerprint")
            && entries.values().all(|entry| {
                entry.get("valueHash").is_some() && entry.get("valueFingerprint").is_none()
            }));
    if legacy {
        return Ok(Loaded {
            entries: IndexMap::new(),
            legacy: true,
        });
    }
    if version != Some(1.0) || raw.get("fingerprint").and_then(Value::as_str) != Some("hmac-sha256")
    {
        return Err(invalid(path, "VAULT_UNSUPPORTED_SYNC_STATE"));
    }
    let entries = serde_json::from_value(Value::Object(entries.clone()))
        .map_err(|_| invalid(path, "VAULT_INVALID_SYNC_STATE"))?;
    Ok(Loaded {
        entries,
        legacy: false,
    })
}

pub(super) fn save(context: &Context) -> Result<()> {
    let _guard = lock::acquire(&context.state_path, &Default::default())?;
    let mut latest = match read(&context.state_path) {
        Ok(latest) if !latest.legacy || context.migrated_from_version_0 => latest.entries,
        Ok(_) => return Err(changed(&context.state_path)),
        Err(error) if error.code == "VAULT_UNSUPPORTED_SYNC_STATE" => {
            if context.migrated_from_version_0 {
                IndexMap::new()
            } else {
                return Err(changed(&context.state_path));
            }
        }
        Err(error) => return Err(error),
    };
    for id in context.initial_entries.keys() {
        if !context.entries.contains_key(id) {
            latest.shift_remove(id);
        }
    }
    for (id, entry) in &context.entries {
        if context.initial_entries.get(id) != Some(entry) {
            latest.insert(id.clone(), entry.clone());
        }
    }
    #[derive(Serialize)]
    struct State<'a> {
        version: u8,
        fingerprint: &'static str,
        entries: &'a IndexMap<String, Entry>,
    }
    let state = State {
        version: 1,
        fingerprint: "hmac-sha256",
        entries: &latest,
    };
    let content = serde_json::to_string_pretty(&state)
        .map_err(|_| invalid(&context.state_path, "VAULT_INVALID_SYNC_STATE"))?;
    storage::write_atomically(&context.state_path, &format!("{content}\n"))
}
fn invalid(path: &Path, code: &'static str) -> Error {
    let label = if code == "VAULT_UNSUPPORTED_SYNC_STATE" {
        "Unsupported"
    } else {
        "Invalid"
    };
    Error::new(
        code,
        format!("{label} vault sync state file: {}", path.display()),
    )
}
fn changed(path: &Path) -> Error {
    Error::new(
        "VAULT_SYNC_STATE_CHANGED",
        format!(
            "Vault sync state changed to an unsupported format: {}",
            path.display()
        ),
    )
}
