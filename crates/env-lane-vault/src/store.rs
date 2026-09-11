//! Authenticated store reading and latest-record selection.
pub mod persistence;
use crate::{
    crypto::{self, VaultKey},
    record::{self, Record},
};
use env_lane_core::{
    error::{Error, Result},
    paths::{relative_path, resolve_path},
    text::trim,
};
use indexmap::IndexMap;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub struct Scope<'a> {
    pub base_dir: &'a Path,
    pub invocation_cwd: &'a Path,
    pub managed_files: &'a [PathBuf],
    pub auto_remap_paths: bool,
}
#[derive(Default)]
pub struct ReadOptions {
    pub allow_missing: bool,
    pub ignore_corrupt_records: bool,
}
pub struct RecordLine {
    pub encrypted_line: String,
    pub line_index: usize,
    pub record: Record,
    pub group_file_path: PathBuf,
}
pub struct Store {
    pub records: Vec<RecordLine>,
    pub state: IndexMap<PathBuf, IndexMap<String, Record>>,
    pub failed_records: usize,
    pub parsed_records: usize,
    pub raw_records: usize,
    pub aliased_records: usize,
    pub raw_lines: Vec<String>,
}

pub fn read(
    path: &Path,
    key: &VaultKey,
    scope: &Scope<'_>,
    options: &ReadOptions,
) -> Result<Store> {
    let raw_lines = read_lines(path, options.allow_missing)?;
    let mut store = Store {
        raw_records: raw_lines.len(),
        raw_lines,
        records: Vec::new(),
        state: IndexMap::new(),
        failed_records: 0,
        parsed_records: 0,
        aliased_records: 0,
    };
    for (order, line) in store.raw_lines.iter().enumerate() {
        let decoded = crypto::decrypt_record(key, line).and_then(|plaintext| {
            record::decode(&plaintext, scope.base_dir, scope.invocation_cwd, order)
        });
        match decoded {
            Err(_) => store.failed_records += 1,
            Ok(record) => {
                let group_file_path = remap_file(&record.file, scope);
                if group_file_path != record.file {
                    store.aliased_records += 1;
                }
                store.records.push(RecordLine {
                    encrypted_line: line.clone(),
                    line_index: order,
                    record,
                    group_file_path,
                });
                store.parsed_records += 1;
            }
        }
    }
    validate_readable(path, &store, options)?;
    for line in &store.records {
        let records = store.state.entry(line.group_file_path.clone()).or_default();
        let replace = records.get(&line.record.key).is_none_or(|current| {
            line.record.timestamp > current.timestamp
                || (line.record.timestamp == current.timestamp && line.record.order > current.order)
        });
        if replace {
            let mut record = line.record.clone();
            record.file = line.group_file_path.clone();
            records.insert(record.key.clone(), record);
        }
    }
    Ok(store)
}

pub fn read_lines(path: &Path, allow_missing: bool) -> Result<Vec<String>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing => {
            return Ok(Vec::new());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::new(
                "VAULT_STORE_NOT_FOUND",
                format!("Store file does not exist: {}", path.display()),
            ));
        }
        Err(error) => {
            return Err(Error::new(
                "VAULT_STORE_READ_FAILED",
                format!("Cannot read store {}: {error}", path.display()),
            ));
        }
    };
    Ok(String::from_utf8_lossy(&bytes)
        .split('\n')
        .map(trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

fn remap_file(file: &Path, scope: &Scope<'_>) -> PathBuf {
    let file = resolve_path(scope.invocation_cwd, file);
    if !scope.auto_remap_paths || scope.managed_files.contains(&file) {
        return file;
    }
    let portable = file.to_string_lossy().replace('\\', "/");
    let mut best = None;
    for managed in scope.managed_files {
        let relative = relative_path(scope.base_dir, managed);
        if relative.is_empty() || relative.starts_with("..") {
            continue;
        }
        if (portable == relative || portable.ends_with(&format!("/{relative}")))
            && best
                .as_ref()
                .is_none_or(|(_, length)| relative.len() > *length)
        {
            best = Some((managed, relative.len()));
        }
    }
    best.map_or(file, |(managed, _)| managed.clone())
}
fn validate_readable(path: &Path, store: &Store, options: &ReadOptions) -> Result<()> {
    if store.raw_records > 0 && store.parsed_records == 0 {
        return Err(Error::new(
            "VAULT_NO_READABLE_RECORDS",
            format!(
                "No readable vault records found in {}. Check the key file.",
                path.display()
            ),
        ));
    }
    if store.failed_records > 0 && !options.ignore_corrupt_records {
        return Err(Error::new(
            "VAULT_CORRUPT_STORE",
            format!(
                "Vault store contains {} unreadable record(s) in {}. Refusing to continue from partial state; pass ignoreCorruptRecords only after inspecting the store.",
                store.failed_records,
                path.display()
            ),
        ));
    }
    Ok(())
}
