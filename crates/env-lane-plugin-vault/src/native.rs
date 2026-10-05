//! Rust Vault operations exposed through the versioned plugin process.
use env_lane_core::{
    error::{Error, Result},
    paths::resolve_path,
};
use env_lane_vault::{
    config::Config as VaultConfig, crypto, history, push, restore, selection, store,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
pub struct Invocation {
    pub operation: String,
    pub request: Value,
}

fn required<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new("INVALID_NATIVE_REQUEST", format!("Missing {field}.")))
}
fn optional<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}
fn path(value: &Value, field: &str, base: &Path) -> Option<PathBuf> {
    optional(value, field).map(|value| resolve_path(base, Path::new(value)))
}

pub fn invoke(operation: &str, value: &Value) -> Result<Value> {
    if operation == "vault.loadConfig" {
        let file = PathBuf::from(required(value, "configFile")?);
        let raw = env_lane_core::config::read_native_config(&file)
            .map_err(|error| Error::new("VAULT_CONFIG_LOAD_FAILED", error.message))?;
        let disable = value
            .get("disableUnsafeWarning")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        return Ok(json!(env_lane_vault::config::resolve_raw(
            raw,
            file.parent().unwrap_or(Path::new(".")),
            disable,
        )?));
    }
    if operation == "vault.resolveConfig" {
        let raw = value
            .get("rawConfig")
            .cloned()
            .ok_or_else(|| Error::new("INVALID_NATIVE_REQUEST", "Missing rawConfig."))?;
        let base_dir = PathBuf::from(required(value, "baseDir")?);
        let disable = value
            .get("disableUnsafeWarning")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        return Ok(json!(env_lane_vault::config::resolve_raw(
            raw, &base_dir, disable
        )?));
    }
    let config: VaultConfig = serde_json::from_value(
        value
            .get("config")
            .cloned()
            .ok_or_else(|| Error::new("INVALID_NATIVE_REQUEST", "Missing Vault config."))?,
    )
    .map_err(|error| Error::new("VAULT_INVALID_CONFIG", error.to_string()))?;
    config.validate_resolved()?;
    if operation == "vault.validateConfig" {
        return Ok(json!({}));
    }
    let cwd = PathBuf::from(required(value, "cwd")?);
    let key = crypto::load_key(&resolve_path(&cwd, Path::new(required(value, "keyFile")?)))?;
    let sync_dir = path(value, "syncDir", &cwd);
    match operation {
        "vault.encryptEnvFiles" => {
            let frozen_documents: Option<Vec<push::FrozenDocument>> = value
                .get("frozenDocuments")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| Error::new("VAULT_INVALID_DECISION", error.to_string()))?;
            let decisions: Option<HashMap<String, push::PushDecision>> = value
                .get("pushDecisions")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| Error::new("VAULT_INVALID_DECISION", error.to_string()))?;
            let mut options = push::Options::new(&cwd);
            options.sync_dir = sync_dir.as_deref();
            options.dry_run = value
                .get("dryRun")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            options.ignore_corrupt_records = value
                .get("ignoreCorruptRecords")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            options.skip_missing_files = optional(value, "missingFiles") == Some("skip");
            options.conflict_strategy = conflict_strategy(value);
            options.external_lock = value
                .get("skipOperationLock")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            options.capture_preview = value
                .get("capturePushPreview")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            options.frozen_documents = frozen_documents.as_deref();
            options.decisions = decisions.as_ref();
            Ok(json!(push::execute(&config, &key, &options)?))
        }
        "vault.buildRestorePlan" => {
            let mut options = restore::Options::new(&cwd);
            options.sync_dir = sync_dir.as_deref();
            options.ignore_corrupt_records = value
                .get("ignoreCorruptRecords")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            options.external_lock = value
                .get("skipOperationLock")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok(json!(restore::build(&config, &key, &options)?))
        }
        "vault.applyRestorePlan" => {
            let submitted: restore::Plan = serde_json::from_value(
                value
                    .get("plan")
                    .cloned()
                    .ok_or_else(|| Error::new("INVALID_NATIVE_REQUEST", "Missing plan."))?,
            )
            .map_err(|error| Error::new("VAULT_INVALID_PLAN_FILE", error.to_string()))?;
            let mut options = restore::ApplyOptions::new(&cwd);
            options.read.sync_dir = sync_dir.as_deref();
            options.read.ignore_corrupt_records = value
                .get("ignoreCorruptRecords")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            options.auto_approve = value
                .get("autoApprove")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            options.external_lock = value
                .get("skipOperationLock")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            options.approve_deletes = value.get("approveDeletes").and_then(Value::as_bool);
            options.decisions = value
                .get("decisions")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| Error::new("VAULT_INVALID_DECISION", error.to_string()))?;
            options.conflict_strategy = conflict_strategy(value);
            Ok(json!(restore::apply(&config, &key, &submitted, &options)?))
        }
        "vault.pruneVaultHistory" | "vault.sanitizeVaultHistory" => {
            let store = store::read(
                &config.store_path,
                &key,
                &store::Scope {
                    base_dir: &config.base_dir,
                    invocation_cwd: &cwd,
                    managed_files: &config.env_files,
                    auto_remap_paths: config.auto_remap_paths,
                },
                &store::ReadOptions {
                    allow_missing: false,
                    ignore_corrupt_records: value
                        .get("ignoreCorruptRecords")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                },
            )?;
            if operation == "vault.pruneVaultHistory" {
                let file = path(value, "filePath", &config.base_dir);
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as f64;
                let older_than = value
                    .get("olderThanDays")
                    .and_then(Value::as_f64)
                    .map(|days| now - days * 86_400_000.0);
                let options = history::PruneOptions {
                    file: file.as_deref(),
                    key: optional(value, "key"),
                    keep_recent: value
                        .get("keepRecent")
                        .and_then(Value::as_u64)
                        .map(|value| value as usize),
                    older_than,
                    preserve_latest: value
                        .get("preserveLatest")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                };
                let plan = history::prune(&config.store_path, &store, &options)?;
                let summary = plan.rewrite.summary();
                assert_digest(value, &summary.store_digest, "prune")?;
                let applied = rewrite(&plan.rewrite, value, "history prune")?;
                Ok(
                    json!({"storePath":summary.store_path,"storeDigest":summary.store_digest,
                    "rawRecords":store.raw_records,"parsedRecords":store.parsed_records,
                    "failedRecords":store.failed_records,"aliasedRecords":store.aliased_records,
                    "groups":plan.groups,"removedRecords":summary.removed_records,
                    "keptRecords":summary.kept_records,"applied":applied}),
                )
            } else {
                if value.get("excluded").and_then(Value::as_bool) != Some(true) {
                    return Err(Error::new(
                        "VAULT_SANITIZE_SCOPE_REQUIRED",
                        "Vault sanitize requires --excluded so the removal scope is explicit.",
                    ));
                }
                let exclusions = selection::Exclusions::new(&config)?;
                let plan = history::sanitize(
                    &config.store_path,
                    &config.base_dir,
                    &store,
                    |file, key| exclusions.excluded(file, key),
                )?;
                let summary = plan.rewrite.summary();
                assert_digest(value, &summary.store_digest, "sanitize")?;
                let applied = rewrite(&plan.rewrite, value, "sanitize")?;
                Ok(
                    json!({"storePath":summary.store_path,"storeDigest":summary.store_digest,
                    "removedRecords":summary.removed_records,"keptRecords":summary.kept_records,
                    "affectedEntries":plan.affected_entries,"applied":applied}),
                )
            }
        }
        _ => Err(Error::new(
            "INVALID_NATIVE_OPERATION",
            format!("Unknown operation: {operation}"),
        )),
    }
}
fn assert_digest(request: &Value, actual: &str, operation: &str) -> Result<()> {
    if optional(request, "expectedStoreDigest").is_some_and(|expected| expected != actual) {
        return Err(Error::new(
            "VAULT_STORE_CHANGED",
            format!(
                "The Vault store changed after the {operation} preview. Preview the operation again."
            ),
        ));
    }
    Ok(())
}
fn rewrite(plan: &history::RewritePlan, request: &Value, operation: &str) -> Result<bool> {
    if plan.summary().removed_records == 0
        || request.get("dryRun").and_then(Value::as_bool) == Some(true)
    {
        return Ok(false);
    }
    if request.get("autoApprove").and_then(Value::as_bool) != Some(true) {
        let mut error = Error::new(
            "VAULT_CONFIRMATION_REQUIRED",
            format!("Vault {operation} requires explicit approval."),
        );
        error.details =
            Some(json!({"hint":"Pass autoApprove: true in the API or --yes in the CLI."}));
        return Err(error);
    }
    plan.apply()
}
fn conflict_strategy(value: &Value) -> push::ConflictStrategy {
    match optional(value, "conflictStrategy") {
        Some("keep-local") => push::ConflictStrategy::KeepLocal,
        Some("take-vault") => push::ConflictStrategy::TakeVault,
        _ => push::ConflictStrategy::Abort,
    }
}
