//! Native Vault push: compare effective dotenv values with authenticated store state.
use crate::{
    config::Config,
    crypto::{self, VaultKey},
    record::{Change, Record, Version},
    selection,
    store::{self, ReadOptions, Scope},
    sync::Context,
};
use env_lane_core::{
    error::{Error, Result},
    storage,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

#[derive(Clone, Copy, Default)]
pub enum ConflictStrategy {
    #[default]
    Abort,
    KeepLocal,
    TakeVault,
}

pub struct Options<'a> {
    pub invocation_cwd: &'a Path,
    pub sync_dir: Option<&'a Path>,
    pub dry_run: bool,
    pub ignore_corrupt_records: bool,
    pub skip_missing_files: bool,
    pub conflict_strategy: ConflictStrategy,
    pub selection: Option<&'a selection::PreparedFilter>,
    pub external_lock: bool,
    pub capture_preview: bool,
    pub frozen_documents: Option<&'a [FrozenDocument]>,
    pub decisions: Option<&'a HashMap<String, PushDecision>>,
}
impl<'a> Options<'a> {
    pub fn new(invocation_cwd: &'a Path) -> Self {
        Self {
            invocation_cwd,
            sync_dir: None,
            dry_run: false,
            ignore_corrupt_records: false,
            skip_missing_files: false,
            conflict_strategy: ConflictStrategy::Abort,
            selection: None,
            external_lock: false,
            capture_preview: false,
            frozen_documents: None,
            decisions: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenDocument {
    pub file_path: PathBuf,
    pub exists: bool,
    pub content: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushDecision {
    pub selected: bool,
    pub conflict_choice: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushCandidate {
    pub entry_id: String,
    pub file_path: PathBuf,
    pub key: String,
    pub action: &'static str,
    pub occurrence_count: usize,
    pub conflict: bool,
    pub vault_action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_reason: Option<&'static str>,
    pub preview: CandidatePreview,
}

#[derive(Serialize)]
pub struct CandidatePreview {
    pub current: &'static str,
    pub vault: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CandidateIdentity<'a> {
    direction: &'static str,
    file_path: &'a Path,
    key: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    op: Option<&'static str>,
}

fn candidate(
    vault_key: &VaultKey,
    file: &Path,
    name: &str,
    value: Option<&str>,
    conflict: Option<crate::sync::Conflict>,
    vault_action: &'static str,
) -> Result<PushCandidate> {
    let identity = CandidateIdentity {
        direction: "encrypt",
        file_path: file,
        key: name,
        value,
        op: if value.is_none() {
            Some("delete")
        } else {
            None
        },
    };
    let bytes = serde_json::to_vec(&identity)
        .map_err(|error| Error::new("VAULT_INVALID_DECISION", error.to_string()))?;
    Ok(PushCandidate {
        entry_id: crypto::vault_digest(vault_key, &bytes),
        file_path: file.to_path_buf(),
        key: name.to_owned(),
        action: if conflict.is_some() {
            "conflict"
        } else {
            vault_action
        },
        occurrence_count: usize::from(value.is_some()),
        conflict: conflict.is_some(),
        vault_action,
        conflict_reason: conflict.map(|reason| reason.reason()),
        preview: CandidatePreview {
            current: if value.is_some() {
                "<redacted>"
            } else {
                "<missing>"
            },
            vault: if vault_action == "add" {
                "<missing>"
            } else {
                "<redacted>"
            },
        },
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSummary {
    pub action: &'static str,
    pub file_path: String,
    pub key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSummary {
    pub applied: bool,
    pub dry_run: bool,
    pub store_path: PathBuf,
    pub set_records_written: usize,
    pub delete_records_written: usize,
    pub skipped_unchanged: usize,
    pub local_only_entries_skipped: usize,
    pub missing_files_skipped: usize,
    pub missing_files_treated_as_empty: usize,
    pub invalid_lines_ignored: usize,
    pub shadowed_entries_ignored: usize,
    pub selection_skipped: usize,
    pub raw_records: usize,
    pub parsed_records: usize,
    pub failed_records: usize,
    pub aliased_records: usize,
    pub conflicts: usize,
    pub conflicts_kept_local: usize,
    pub conflicts_took_vault: usize,
    pub changes: Vec<ChangeSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_state_path: Option<PathBuf>,
    pub sync_state_migrated_from_version_0: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<PushCandidate>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frozen_documents: Option<Vec<FrozenDocument>>,
}

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}

fn record_value(record: &Record) -> Option<&str> {
    match &record.change {
        Change::Set(value) => Some(value),
        Change::Delete => None,
    }
}

fn choice(strategy: ConflictStrategy, file: &Path, key: &str) -> Result<bool> {
    match strategy {
        ConflictStrategy::KeepLocal => Ok(true),
        ConflictStrategy::TakeVault => Ok(false),
        ConflictStrategy::Abort => {
            let mut error = Error::new(
                "VAULT_CONFLICT_DECISION_REQUIRED",
                "Vault conflict resolution requires a decision map, resolveConflict callback, or an explicit non-interactive strategy.",
            );
            error.details = Some(serde_json::json!({"filePath":file,"key":key}));
            Err(error)
        }
    }
}

fn scrub_sync(
    config: &Config,
    exclusions: &selection::Exclusions<'_>,
    context: &mut Context,
) -> Result<()> {
    let mut failure = None;
    context.retain(|entry| {
        let file = config.base_dir.join(&entry.file_path);
        match exclusions.excluded(&file, &entry.key) {
            Ok(excluded) => !excluded,
            Err(error) => {
                failure = Some(error);
                true
            }
        }
    });
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(())
}

pub fn execute(config: &Config, key: &VaultKey, options: &Options<'_>) -> Result<ResultSummary> {
    let _guard = if options.dry_run || options.external_lock {
        None
    } else {
        Some(store::persistence::operation_lock(&config.store_path)?)
    };
    let exclusions = selection::Exclusions::new(config)?;
    let mut sync = options
        .sync_dir
        .map(|dir| Context::load(dir, key))
        .transpose()?;
    if let Some(context) = &mut sync {
        scrub_sync(config, &exclusions, context)?;
    }
    let store = store::read(
        &config.store_path,
        key,
        &Scope {
            base_dir: &config.base_dir,
            invocation_cwd: options.invocation_cwd,
            managed_files: &config.env_files,
            auto_remap_paths: config.auto_remap_paths,
        },
        &ReadOptions {
            allow_missing: true,
            ignore_corrupt_records: options.ignore_corrupt_records,
        },
    )?;
    exclusions.assert_clean(&store)?;
    let mut pending = Vec::new();
    let mut summary = ResultSummary {
        applied: false,
        dry_run: options.dry_run,
        store_path: config.store_path.clone(),
        set_records_written: 0,
        delete_records_written: 0,
        skipped_unchanged: 0,
        local_only_entries_skipped: 0,
        missing_files_skipped: 0,
        missing_files_treated_as_empty: 0,
        invalid_lines_ignored: 0,
        shadowed_entries_ignored: 0,
        selection_skipped: 0,
        raw_records: store.raw_records,
        parsed_records: store.parsed_records,
        failed_records: store.failed_records,
        aliased_records: store.aliased_records,
        conflicts: 0,
        conflicts_kept_local: 0,
        conflicts_took_vault: 0,
        changes: Vec::new(),
        sync_state_path: options
            .sync_dir
            .map(|dir| dir.join("vault-sync-state.json")),
        sync_state_migrated_from_version_0: sync
            .as_ref()
            .is_some_and(|context| context.migrated_from_version_0),
        candidates: options.capture_preview.then(Vec::new),
        frozen_documents: options.capture_preview.then(Vec::new),
    };
    let frozen_documents = options.frozen_documents.map(|documents| {
        let mut by_path = HashMap::with_capacity(documents.len());
        for document in documents {
            // Keep the first snapshot when a caller supplies duplicate paths.
            by_path
                .entry(document.file_path.as_path())
                .or_insert(document);
        }
        by_path
    });
    for file in &config.env_files {
        let loaded = if let Some(frozen) = &frozen_documents {
            let document = frozen.get(file.as_path()).ok_or_else(|| {
                Error::new(
                    "VAULT_INVALID_DECISION",
                    format!("Missing frozen document: {}", file.display()),
                )
            })?;
            storage::LoadedDocument {
                exists: document.exists,
                content: document.content.clone(),
                parsed: env_lane_core::document::Document::parse(&document.content),
            }
        } else {
            storage::load_document(file)?
        };
        if let Some(documents) = &mut summary.frozen_documents {
            documents.push(FrozenDocument {
                file_path: file.clone(),
                exists: loaded.exists,
                content: loaded.content.clone(),
            });
        }
        if !loaded.exists && options.skip_missing_files {
            summary.missing_files_skipped += 1;
            continue;
        }
        if !loaded.exists {
            summary.missing_files_treated_as_empty += 1;
        }
        let document = loaded.parsed;
        summary.invalid_lines_ignored += document.invalid_line_count;
        summary.shadowed_entries_ignored += document.shadowed_entry_count;
        let previous = store.state.get(file);
        for (name, value) in &document.current_map {
            if exclusions.excluded(file, name)? {
                summary.local_only_entries_skipped += 1;
                continue;
            }
            let old = previous.and_then(|entries| entries.get(name));
            if old.and_then(record_value) == Some(value.effective_value.as_str()) {
                summary.skipped_unchanged += 1;
                if let (Some(context), Some(record)) = (&mut sync, old) {
                    context.update(&config.base_dir, record, now())?;
                }
                continue;
            }
            let conflict = if let (Some(context), Some(record)) = (&sync, old) {
                context.conflict(
                    &config.base_dir,
                    file,
                    name,
                    Some(&value.effective_value),
                    record_value(record),
                )
            } else {
                None
            };
            let vault_action = if old.and_then(record_value).is_some() {
                "modify"
            } else {
                "add"
            };
            let action = if conflict.is_some() {
                "conflict"
            } else {
                vault_action
            };
            let candidate = if options.capture_preview || options.decisions.is_some() {
                Some(candidate(
                    key,
                    file,
                    name,
                    Some(&value.effective_value),
                    conflict,
                    vault_action,
                )?)
            } else {
                None
            };
            let decision = options.decisions.and_then(|decisions| {
                candidate
                    .as_ref()
                    .and_then(|candidate| decisions.get(&candidate.entry_id))
            });
            if let (Some(candidates), Some(candidate)) = (&mut summary.candidates, candidate) {
                candidates.push(candidate);
            }
            if options.decisions.is_some() && decision.is_none() {
                return Err(Error::new(
                    "VAULT_INVALID_DECISION",
                    "Missing push decision.",
                ));
            }
            if decision.is_some_and(|decision| !decision.selected) {
                summary.selection_skipped += 1;
                continue;
            }
            if let Some(filter) = options.selection
                && !filter.selected(file, name, action)?
            {
                summary.selection_skipped += 1;
                continue;
            }
            if conflict.is_some() {
                summary.conflicts += 1;
                let keep_local =
                    match decision.and_then(|decision| decision.conflict_choice.as_deref()) {
                        Some("keep-local") => true,
                        Some("take-vault") => false,
                        Some(_) => {
                            return Err(Error::new(
                                "VAULT_INVALID_DECISION",
                                "Unknown push conflict choice.",
                            ));
                        }
                        None => choice(options.conflict_strategy, file, name)?,
                    };
                if !keep_local {
                    summary.conflicts_took_vault += 1;
                    continue;
                }
                summary.conflicts_kept_local += 1;
            }
            let record = Record {
                version: Version::Effective,
                file: file.clone(),
                key: name.clone(),
                timestamp: now(),
                change: Change::Set(Zeroizing::new(value.effective_value.clone())),
                order: 0,
            };
            if let Some(context) = &mut sync {
                context.update(&config.base_dir, &record, now())?;
            }
            summary.changes.push(ChangeSummary {
                action: if old.and_then(record_value).is_some() {
                    "update"
                } else {
                    "set"
                },
                file_path: file.to_string_lossy().replace('\\', "/"),
                key: name.clone(),
            });
            summary.set_records_written += 1;
            pending.push(record);
        }
        if config.track_deletions {
            for (name, old) in previous.into_iter().flat_map(|entries| entries.iter()) {
                if record_value(old).is_none()
                    || document.current_map.contains_key(name)
                    || exclusions.excluded(file, name)?
                {
                    continue;
                }
                let conflict = if let Some(context) = &sync {
                    context.conflict(&config.base_dir, file, name, None, record_value(old))
                } else {
                    None
                };
                let candidate = if options.capture_preview || options.decisions.is_some() {
                    Some(candidate(key, file, name, None, conflict, "delete")?)
                } else {
                    None
                };
                let decision = options.decisions.and_then(|decisions| {
                    candidate
                        .as_ref()
                        .and_then(|candidate| decisions.get(&candidate.entry_id))
                });
                if let (Some(candidates), Some(candidate)) = (&mut summary.candidates, candidate) {
                    candidates.push(candidate);
                }
                if options.decisions.is_some() && decision.is_none() {
                    return Err(Error::new(
                        "VAULT_INVALID_DECISION",
                        "Missing push decision.",
                    ));
                }
                if decision.is_some_and(|decision| !decision.selected) {
                    summary.selection_skipped += 1;
                    continue;
                }
                if let Some(filter) = options.selection
                    && (!filter.selected(
                        file,
                        name,
                        if conflict.is_some() {
                            "conflict"
                        } else {
                            "delete"
                        },
                    )? || !filter.approve_deletes)
                {
                    summary.selection_skipped += 1;
                    continue;
                }
                if conflict.is_some() {
                    summary.conflicts += 1;
                    let keep_local =
                        match decision.and_then(|decision| decision.conflict_choice.as_deref()) {
                            Some("keep-local") => true,
                            Some("take-vault") => false,
                            Some(_) => {
                                return Err(Error::new(
                                    "VAULT_INVALID_DECISION",
                                    "Unknown push conflict choice.",
                                ));
                            }
                            None => choice(options.conflict_strategy, file, name)?,
                        };
                    if !keep_local {
                        summary.conflicts_took_vault += 1;
                        continue;
                    }
                    summary.conflicts_kept_local += 1;
                }
                let record = Record {
                    version: Version::Effective,
                    file: file.clone(),
                    key: name.clone(),
                    timestamp: now(),
                    change: Change::Delete,
                    order: 0,
                };
                if let Some(context) = &mut sync {
                    context.update(&config.base_dir, &record, now())?;
                }
                summary.changes.push(ChangeSummary {
                    action: "delete",
                    file_path: file.to_string_lossy().replace('\\', "/"),
                    key: name.clone(),
                });
                summary.delete_records_written += 1;
                pending.push(record);
            }
        }
        for (name, old) in previous.into_iter().flat_map(|entries| entries.iter()) {
            if record_value(old).is_none()
                && !document.current_map.contains_key(name)
                && let Some(context) = &mut sync
            {
                context.update(&config.base_dir, old, now())?;
            }
        }
    }
    if !options.dry_run {
        store::persistence::append(&config.store_path, &config.base_dir, key, &pending)?;
        if let Some(context) = &sync {
            context.save()?;
        }
        summary.applied = !pending.is_empty();
    }
    Ok(summary)
}
