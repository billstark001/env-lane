//! Serialized writes. Whole workflows acquire the operation lock first; individual
//! store replacements acquire the store lock second. Never reverse that order.
use crate::{
    crypto::{self, VaultKey},
    lock::{self, Lock},
    record::{self, Record},
};
use env_lane_core::{
    error::{Error, Result},
    storage,
};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn operation_lock(store_path: &Path) -> Result<Lock> {
    let mut target = store_path.as_os_str().to_owned();
    target.push(".operation");
    lock::acquire(&PathBuf::from(target), &lock::Options::default())
}

/// Encrypt before acquiring the lock so invalid input cannot create directories
/// or hold other writers up. Reading the existing prefix must happen under lock.
pub fn append(path: &Path, base_dir: &Path, key: &VaultKey, records: &[Record]) -> Result<()> {
    if records.is_empty() {
        return Ok(());
    }
    let lines = records
        .iter()
        .map(|record| crypto::encrypt_record(key, &record::encode(record, base_dir)?))
        .collect::<Result<Vec<_>>>()?;
    let _guard = lock::acquire(path, &lock::Options::default())?;
    let mut content = match fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(Error::new(
                "VAULT_STORE_READ_FAILED",
                format!("Cannot read store {}: {error}", path.display()),
            ));
        }
    };
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&lines.join("\n"));
    content.push('\n');
    storage::write_atomically(path, &content)
}

/// Compare the authenticated reader's snapshot under the write lock. A stale
/// preview cannot discard records appended after the preview was produced.
pub fn rewrite(path: &Path, expected_lines: &[String], next_lines: &[String]) -> Result<()> {
    let expected_digest = digest(expected_lines);
    let _guard = lock::acquire(path, &lock::Options::default())?;
    if digest(&super::read_lines(path, false)?) != expected_digest {
        let mut error = Error::new(
            "VAULT_STORE_CHANGED",
            "The Vault store changed while preparing the rewrite. Retry the operation.",
        );
        error.details = Some(serde_json::json!({"storePath":path}));
        return Err(error);
    }
    let mut content = next_lines.join("\n");
    if !next_lines.is_empty() {
        content.push('\n');
    }
    storage::write_atomically(path, &content)
}

pub fn digest(lines: &[String]) -> String {
    crypto::stable_hash(lines.join("\n").as_bytes())
}
