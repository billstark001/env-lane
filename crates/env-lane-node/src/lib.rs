//! Node-API transport. Application behavior stays in Rust Core and Vault.
use env_lane_core::{
    check,
    config::{self, LoadedConfig},
    document::{self, Patch, PatchOptions, TextDocument},
    error::{Error, Result},
    paths::resolve_path,
    policy,
    resolve::{Context, Environment, Options},
    sort, workspace,
};
use env_lane_vault::{
    config::Config as VaultConfig, crypto, history, push, restore, selection, store,
};
use napi_derive::napi;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

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
fn load_core(value: &Value) -> Result<LoadedConfig> {
    let cwd = PathBuf::from(required(value, "cwd")?);
    let Some(config) = value.get("config") else {
        return config::load(&cwd, path(value, "configFile", &cwd).as_deref());
    };
    let root = PathBuf::from(required(config, "rootDir")?);
    // A resolved JS config already contains defaults and has passed the public
    // c12/Zod validation. The raw-config validator rejects empty defaults that
    // are legal in this resolved form (for example defaultTarget: "").
    let parsed: config::Config = serde_json::from_value(config.clone())
        .map_err(|error| Error::new("CONFIG_LOAD_FAILED", error.to_string()))?;
    let config_file = path(value, "configFile", &cwd);
    let config_dir = config_file
        .as_ref()
        .and_then(|file| file.parent())
        .unwrap_or(&root)
        .to_path_buf();
    Ok(LoadedConfig {
        config: parsed,
        invocation_cwd: cwd,
        project_root: root,
        config_file,
        config_dir,
    })
}
fn core_document(operation: &str, value: &Value) -> Result<Value> {
    match operation {
        "core.envDocument.create" => Ok(json!(TextDocument::parse(required(value, "content")?))),
        "core.envDocument.parseLine" => {
            Ok(json!(document::parse_line(required(value, "line")?, 1)))
        }
        "core.envDocument.parse" => {
            let parsed = document::Document::parse(required(value, "content")?);
            Ok(json!({
                "document": parsed.document,
                "parsedLines": parsed.parsed_lines,
                "currentEntries": parsed.current_map.into_iter().collect::<Vec<_>>(),
                "occurrenceEntries": parsed.occurrences_map.into_iter().collect::<Vec<_>>(),
                "invalidLineCount": parsed.invalid_line_count,
                "shadowedEntryCount": parsed.shadowed_entry_count,
            }))
        }
        "core.envDocument.render" => {
            let text: TextDocument = serde_json::from_value(
                value
                    .get("document")
                    .cloned()
                    .ok_or_else(|| Error::new("INVALID_NATIVE_REQUEST", "Missing document."))?,
            )
            .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))?;
            let lines: Vec<String> = serde_json::from_value(
                value
                    .get("lines")
                    .cloned()
                    .ok_or_else(|| Error::new("INVALID_NATIVE_REQUEST", "Missing lines."))?,
            )
            .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))?;
            let eol = value
                .get("eol")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))?
                .unwrap_or_default();
            Ok(json!(
                text.render(
                    &lines,
                    value
                        .get("preserveBOM")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    eol,
                )
            ))
        }
        "core.envDocument.formatValue" => {
            Ok(json!(document::format_value(required(value, "value")?)?))
        }
        "core.envDocument.patch" => {
            let patches: Vec<Patch> = serde_json::from_value(
                value
                    .get("patches")
                    .cloned()
                    .ok_or_else(|| Error::new("INVALID_NATIVE_REQUEST", "Missing patches."))?,
            )
            .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))?;
            let options: PatchOptions =
                serde_json::from_value(value.get("options").cloned().unwrap_or_else(|| json!({})))
                    .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))?;
            Ok(json!(document::patch(
                required(value, "content")?,
                &patches,
                &options,
            )?))
        }
        _ => Err(Error::new(
            "INVALID_NATIVE_OPERATION",
            format!("Unknown operation: {operation}"),
        )),
    }
}
fn core(operation: &str, value: &Value) -> Result<Value> {
    if operation.starts_with("core.envDocument.") {
        return Ok(json!({"value":core_document(operation, value)?,"diagnostics":[]}));
    }
    if operation == "core.sortEnvFile" {
        let cwd = PathBuf::from(required(value, "cwd")?);
        let file = resolve_path(&cwd, Path::new(required(value, "file")?));
        let template = resolve_path(&cwd, Path::new(required(value, "template")?));
        let options: sort::SortOptions =
            serde_json::from_value(value.get("options").cloned().unwrap_or_else(|| json!({})))
                .map_err(|error| Error::new("INVALID_SORT_OPTIONS", error.to_string()))?;
        return Ok(json!({"value":sort::sort_file(&file, &template, &options)?,"diagnostics":[]}));
    }
    let loaded = load_core(value)?;
    if operation == "core.listEnvFilesForTarget" {
        let target: workspace::Package = serde_json::from_value(
            value
                .get("targetPackage")
                .cloned()
                .ok_or_else(|| Error::new("INVALID_NATIVE_REQUEST", "Missing targetPackage."))?,
        )
        .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))?;
        let environment: Environment = value
            .get("processEnv")
            .cloned()
            .map(|value| serde_json::from_value(value).unwrap_or_default())
            .unwrap_or_default();
        let mut diagnostics = Vec::new();
        let build = match optional(value, "resolvedBuild") {
            Some(build) => build.to_owned(),
            None => env_lane_core::resolve::select_build(
                optional(value, "build"),
                &loaded.config.selector,
                &environment,
                &mut diagnostics,
            )?,
        };
        let context = Context {
            loaded: &loaded,
            packages: &[],
            process_env: &environment,
        };
        return Ok(json!({
            "value":context.files_for_target(
                &target,
                &build,
                value.get("requireOverride").and_then(Value::as_bool)
            ),
            "diagnostics":diagnostics
        }));
    }
    let packages: Vec<workspace::Package> = match value.get("packages") {
        Some(packages) => serde_json::from_value(packages.clone())
            .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))?,
        None => workspace::list_packages(&loaded)?,
    };
    let environment: Environment = value
        .get("processEnv")
        .cloned()
        .map(|value| serde_json::from_value(value).unwrap_or_default())
        .unwrap_or_default();
    let context = Context {
        loaded: &loaded,
        packages: &packages,
        process_env: &environment,
    };
    let mut diagnostics = Vec::new();
    let options = Options {
        target: optional(value, "target"),
        build: optional(value, "build"),
        include_process_env: value.get("includeProcessEnv").and_then(Value::as_bool),
        require_override: value.get("requireOverride").and_then(Value::as_bool),
    };
    let result = match operation {
        "core.listWorkspacePackages" => json!(packages),
        "core.resolveTargetPackage" => json!(workspace::resolve_target(
            &packages,
            options.target,
            &loaded.config.workspace.default_target,
            value
                .get("inferFromCwd")
                .and_then(Value::as_bool)
                .unwrap_or(true)
                .then_some(loaded.invocation_cwd.as_path())
        )?),
        "core.listEnvFiles" => json!(context.files(&options, &mut diagnostics)?),
        "core.resolveInjectedEnv" => json!(context.resolve(&options, &mut diagnostics)?),
        "core.checkDotenvSelector" => json!(check::check_selector(
            &context,
            &check::CheckOptions {
                target: options.target,
                build: options.build,
                require_override: options.require_override,
            },
            &mut diagnostics
        )?),
        "core.runEnvCheck" => json!(policy::run_check(
            &context,
            required(value, "name")?,
            options.build,
            &mut diagnostics
        )?),
        "core.runEnvSync" => json!(policy::run_sync(
            &context,
            required(value, "name")?,
            &policy::SyncOptions {
                build: options.build,
                dry_run: value
                    .get("dryRun")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            },
            &mut diagnostics
        )?),
        "core.sortEnvFilesFromConfig" => json!(sort::sort_configured(
            &loaded,
            &packages,
            optional(value, "key"),
            optional(value, "envSuffix"),
            &sort::ConfiguredOptions {
                create: value.get("create").and_then(Value::as_bool),
                check: value.get("check").and_then(Value::as_bool).unwrap_or(false),
                preserve_bom: value.get("preserveBOM").and_then(Value::as_bool),
                eol: value
                    .get("eol")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| Error::new("INVALID_SORT_OPTIONS", error.to_string()))?,
            }
        )?),
        _ => {
            return Err(Error::new(
                "INVALID_NATIVE_OPERATION",
                format!("Unknown operation: {operation}"),
            ));
        }
    };
    Ok(json!({"value":result,"diagnostics":diagnostics}))
}
fn vault(operation: &str, value: &Value) -> Result<Value> {
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

/// A transport envelope carries stable error codes and data without forcing
/// application objects through duplicate Node-API schemas.
#[napi]
pub fn invoke(operation: String, request: String) -> String {
    let result = serde_json::from_str::<Value>(&request)
        .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))
        .and_then(|value| {
            if operation.starts_with("core.") {
                core(&operation, &value)
            } else {
                vault(&operation, &value)
            }
        });
    match result {
        Ok(value) => json!({"ok":true,"result":value}).to_string(),
        Err(error) => json!({"ok":false,"error":error}).to_string(),
    }
}
