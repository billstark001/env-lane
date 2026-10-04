//! Native Vault command presentation and filesystem option resolution.
use crate::{
    arguments::{Cli, VaultCommon, VaultOperation, VaultSelection},
    commands::vault_prompt,
    output::Output,
};
use env_lane_core::{
    error::{Error, Result},
    paths::resolve_path,
    resolve::Context,
    storage,
};
use env_lane_vault::{
    config::{self, Config, Redaction, Reveal},
    crypto, history,
    push::{self, ConflictStrategy},
    restore::{self, Action, Decision, DecisionChoice, Plan},
    selection,
    store::{self, ReadOptions, Scope},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MILLIS_PER_DAY: f64 = 86_400_000.0;

#[derive(Serialize, Deserialize)]
struct ApprovalDocument {
    plan: Plan,
    decisions: Vec<Decision>,
}

fn validate_approval_document(document: &ApprovalDocument) -> Result<()> {
    let expected: HashSet<_> = document
        .plan
        .files
        .iter()
        .flat_map(|file| &file.entries)
        .filter(|entry| entry.action != Action::Identical)
        .map(|entry| entry.entry_id.as_str())
        .collect();
    let actual: HashSet<_> = document
        .decisions
        .iter()
        .map(|decision| decision.entry_id.as_str())
        .collect();
    if actual.len() != document.decisions.len() || actual != expected {
        return Err(invalid(
            "VAULT_INVALID_PLAN_FILE",
            "Invalid Vault approval document.",
        ));
    }
    Ok(())
}

fn invalid(code: &'static str, message: &'static str) -> Error {
    Error::new(code, message)
}
fn strategy(raw: Option<&str>) -> Result<ConflictStrategy> {
    match raw.unwrap_or("abort") {
        "abort" => Ok(ConflictStrategy::Abort),
        "keep-local" => Ok(ConflictStrategy::KeepLocal),
        "take-vault" => Ok(ConflictStrategy::TakeVault),
        _ => Err(invalid(
            "VAULT_INVALID_CONFLICT_STRATEGY",
            "--conflicts must be one of: abort, keep-local, take-vault",
        )),
    }
}
fn fail_on(raw: Option<&str>) -> Result<Option<&str>> {
    match raw {
        None | Some("change" | "conflict" | "warning") => Ok(raw),
        _ => Err(invalid(
            "VAULT_INVALID_FAIL_ON",
            "--fail-on must be conflict, change, or warning.",
        )),
    }
}
fn filter(options: &VaultSelection) -> Result<selection::PreparedFilter> {
    let filter = selection::Filter {
        file: options.file.clone(),
        key: options.key.clone(),
        include: options.include.clone(),
        exclude: options.exclude.clone(),
        only: options.only.clone(),
        approve_deletes: !options.no_approve_deletes,
    };
    filter.compile()
}
fn operation_config(
    context: &Context<'_>,
    explicit: Option<&Path>,
    common: Option<&VaultCommon>,
) -> Result<Config> {
    let mut config = config::load(context.loaded, explicit)?;
    if let Some(common) = common {
        if common.no_auto_remap {
            config.auto_remap_paths = false;
        }
        if common.allow_unmanaged {
            config.allow_unmanaged = true;
        }
        if let Some(value) = &common.redaction {
            config.restore.redaction = match value.as_str() {
                "full" => Redaction::Full,
                "partial" => Redaction::Partial,
                "none" => Redaction::None,
                _ => {
                    return Err(invalid(
                        "VAULT_INVALID_REDACTION",
                        "--redaction must be one of: full, partial, none",
                    ));
                }
            };
        }
        if common.no_reveal {
            config.restore.reveal = None;
        }
        if let Some(value) = &common.reveal {
            let (start, end) = value.split_once(':').ok_or_else(|| invalid("VAULT_INVALID_REVEAL", "--reveal must use start:end counts between 0 and 64, for example: --reveal 4:4"))?;
            let (start, end) = (start.parse::<u8>(), end.parse::<u8>());
            config.restore.reveal = match (start, end) {
                (Ok(start), Ok(end)) if start <= 64 && end <= 64 => Some(Reveal { start, end }),
                _ => {
                    return Err(invalid(
                        "VAULT_INVALID_REVEAL",
                        "--reveal must use start:end counts between 0 and 64, for example: --reveal 4:4",
                    ));
                }
            };
        }
    }
    Ok(config)
}
fn sync_path(cwd: &Path, common: &VaultCommon) -> Option<PathBuf> {
    common.sync_dir.as_ref().map(|path| resolve_path(cwd, path))
}
fn key(cwd: &Path, file: &Path) -> Result<crypto::VaultKey> {
    crypto::load_key(&resolve_path(cwd, file))
}
fn warning(config: &Config, output: &Output) -> Result<()> {
    if !config.disable_unsafe_warning && !output.is_json() {
        writeln!(
            io::stderr().lock(),
            "[env-lane] warning VAULT_UNSAFE: Development Vault is not a production secret manager."
        )
        .map_err(|error| Error::new("OUTPUT_FAILED", error.to_string()))?;
    }
    Ok(())
}
fn selected(plan: &Plan, filter: &selection::PreparedFilter) -> Result<Plan> {
    let mut plan = plan.clone();
    for file in &mut plan.files {
        let mut entries = Vec::new();
        for entry in file.entries.drain(..) {
            if filter.selected(&entry.file_path, &entry.key, action_name(entry.action))? {
                entries.push(entry);
            }
        }
        file.entries = entries;
        file.changed = file
            .entries
            .iter()
            .any(|entry| entry.action != Action::Identical);
    }
    plan.files.retain(|file| !file.entries.is_empty());
    let mut summary = restore::Summary::default();
    for file in &plan.files {
        if file.changed {
            summary.files_with_changes += 1;
        }
        for entry in &file.entries {
            match entry.action {
                Action::Add => summary.add += 1,
                Action::Modify => summary.modify += 1,
                Action::Delete => summary.delete += 1,
                Action::Identical => summary.identical += 1,
                Action::Conflict => summary.conflict += 1,
            }
        }
    }
    plan.summary = summary;
    Ok(plan)
}
fn action_name(action: Action) -> &'static str {
    match action {
        Action::Add => "add",
        Action::Modify => "modify",
        Action::Delete => "delete",
        Action::Identical => "identical",
        Action::Conflict => "conflict",
    }
}
fn decisions(
    plan: &Plan,
    filter: &selection::PreparedFilter,
    strategy: ConflictStrategy,
) -> Result<Vec<Decision>> {
    plan.files
        .iter()
        .flat_map(|file| &file.entries)
        .filter(|entry| entry.action != Action::Identical)
        .map(|entry| {
            let selected =
                filter.selected(&entry.file_path, &entry.key, action_name(entry.action))?;
            let choice = if !selected || (entry.action == Action::Delete && !filter.approve_deletes)
            {
                DecisionChoice::Skip
            } else if entry.action == Action::Conflict {
                match strategy {
                    ConflictStrategy::Abort => DecisionChoice::Skip,
                    ConflictStrategy::KeepLocal => DecisionChoice::KeepLocal,
                    ConflictStrategy::TakeVault => DecisionChoice::ApplyVault,
                }
            } else {
                DecisionChoice::ApplyVault
            };
            Ok(Decision {
                entry_id: entry.entry_id.clone(),
                decision: choice,
            })
        })
        .collect()
}
fn unresolved(
    plan: &Plan,
    decisions: &[Decision],
    filter: &selection::PreparedFilter,
) -> Result<bool> {
    let skipped: HashSet<_> = decisions
        .iter()
        .filter(|decision| matches!(decision.decision, DecisionChoice::Skip))
        .map(|decision| decision.entry_id.as_str())
        .collect();
    for entry in plan.files.iter().flat_map(|file| &file.entries) {
        if entry.action == Action::Conflict
            && filter.selected(&entry.file_path, &entry.key, "conflict")?
            && skipped.contains(entry.entry_id.as_str())
        {
            return Ok(true);
        }
    }
    Ok(false)
}
fn render_plan(plan: &Plan, output: &Output) -> Result<()> {
    if output.is_json() {
        return output.json(plan);
    }
    output.line(format!("Restore plan for {}:", plan.store_path.display()))?;
    for file in &plan.files {
        if !file.changed {
            continue;
        }
        output.line(format!("# {}", file.file_path.display()))?;
        for entry in &file.entries {
            if entry.action == Action::Identical {
                continue;
            }
            output.line(format!(
                "  {:<10} {}: {} -> {}",
                action_name(entry.action),
                entry.key,
                entry.preview.current,
                entry.preview.vault
            ))?;
        }
    }
    output.line(format!(
        "Summary: {} files to change, {} conflicts.",
        plan.summary.files_with_changes, plan.summary.conflict
    ))
}
fn plan_exit(plan: &Plan, fail_on: Option<&str>) -> i32 {
    match fail_on {
        Some("change") if plan.summary.files_with_changes > 0 => 2,
        Some("conflict") if plan.summary.conflict > 0 => 2,
        Some("warning") if plan.failed_records > 0 || !plan.unmanaged_store_files.is_empty() => 2,
        _ => 0,
    }
}

/// Apply checks count only entries whose explicit decisions were kept. A
/// prompt or approval document can skip an entry that matched CLI filters.
fn decisions_exit(plan: &Plan, decisions: &[Decision], fail_on: Option<&str>) -> i32 {
    let selected: HashSet<_> = decisions
        .iter()
        .filter(|decision| !matches!(decision.decision, DecisionChoice::Skip))
        .map(|decision| decision.entry_id.as_str())
        .collect();
    match fail_on {
        Some("change")
            if plan
                .files
                .iter()
                .flat_map(|file| &file.entries)
                .any(|entry| {
                    entry.action != Action::Identical && selected.contains(entry.entry_id.as_str())
                }) =>
        {
            2
        }
        Some("conflict")
            if plan
                .files
                .iter()
                .flat_map(|file| &file.entries)
                .any(|entry| {
                    entry.action == Action::Conflict && selected.contains(entry.entry_id.as_str())
                }) =>
        {
            2
        }
        Some("warning") if plan.failed_records > 0 || !plan.unmanaged_store_files.is_empty() => 2,
        _ => 0,
    }
}
fn read_options<'a>(cwd: &'a Path, sync: Option<&'a Path>) -> restore::Options<'a> {
    let mut options = restore::Options::new(cwd);
    options.sync_dir = sync;
    options
}
fn prompt(message: &str, non_interactive: bool) -> Result<bool> {
    if non_interactive || !io::stdin().is_terminal() {
        return Err(invalid(
            "VAULT_CONFIRMATION_REQUIRED",
            "Vault operation requires --yes.",
        ));
    }
    write!(io::stderr().lock(), "{message} [y/N] ")
        .map_err(|error| Error::new("OUTPUT_FAILED", error.to_string()))?;
    io::stderr()
        .flush()
        .map_err(|error| Error::new("OUTPUT_FAILED", error.to_string()))?;
    let mut answer = String::new();
    io::stdin()
        .read_line(&mut answer)
        .map_err(|error| Error::new("INPUT_FAILED", error.to_string()))?;
    Ok(matches!(answer.trim(), "y" | "Y" | "yes" | "YES"))
}
fn read_store(config: &Config, key: &crypto::VaultKey, cwd: &Path) -> Result<store::Store> {
    store::read(
        &config.store_path,
        key,
        &Scope {
            base_dir: &config.base_dir,
            invocation_cwd: cwd,
            managed_files: &config.env_files,
            auto_remap_paths: config.auto_remap_paths,
        },
        &ReadOptions::default(),
    )
}

pub fn execute(
    operation: &VaultOperation,
    cli: &Cli,
    context: &Context<'_>,
    output: &Output,
) -> Result<i32> {
    output.require_text_or_json("Vault commands do not support --format dotenv.")?;
    let cwd = &context.loaded.invocation_cwd;
    match operation {
        VaultOperation::Encrypt {
            key_file,
            common,
            selection,
            dry_run,
            missing_files,
            conflicts,
        } => {
            let fail = fail_on(selection.fail_on.as_deref())?;
            let config = operation_config(context, common.vault_config.as_deref(), Some(common))?;
            warning(&config, output)?;
            let key = key(cwd, key_file)?;
            let sync = sync_path(cwd, common);
            let filter = filter(selection)?;
            let mut options = push::Options::new(cwd);
            options.dry_run = *dry_run;
            options.sync_dir = sync.as_deref();
            options.selection = Some(&filter);
            options.conflict_strategy = strategy(conflicts.as_deref())?;
            options.skip_missing_files = match missing_files.as_deref().unwrap_or("delete") {
                "skip" => true,
                "delete" => false,
                _ => {
                    return Err(invalid(
                        "VAULT_INVALID_MISSING_FILE_STRATEGY",
                        "--missing-files must be one of: delete, skip",
                    ));
                }
            };
            let result = push::execute(&config, &key, &options)?;
            if output.is_json() {
                output.json(&result)?;
            } else {
                output.line(format!(
                    "{} {}",
                    if *dry_run {
                        "Would encrypt records to"
                    } else {
                        "Encrypted records to"
                    },
                    result.store_path.display()
                ))?;
                output.line(format!("  Set: {}", result.set_records_written))?;
                output.line(format!("  Delete: {}", result.delete_records_written))?;
                output.line(format!("  Skipped unchanged: {}", result.skipped_unchanged))?;
                output.line(format!(
                    "  Skipped by selection: {}",
                    result.selection_skipped
                ))?;
                if result.missing_files_treated_as_empty > 0 {
                    output.line(format!(
                        "  Missing files treated as empty: {}",
                        result.missing_files_treated_as_empty
                    ))?;
                }
                if result.conflicts > 0 {
                    output.line(format!("  Conflicts: {}", result.conflicts))?;
                }
            }
            Ok(match fail {
                Some("conflict") if result.conflicts > 0 => 2,
                Some("change") if !result.changes.is_empty() => 2,
                Some("warning")
                    if result.failed_records > 0
                        || result.invalid_lines_ignored > 0
                        || result.missing_files_skipped > 0
                        || result.shadowed_entries_ignored > 0 =>
                {
                    2
                }
                _ => 0,
            })
        }
        VaultOperation::Plan {
            key_file,
            common,
            selection,
            output: destination,
        } => {
            let fail = fail_on(selection.fail_on.as_deref())?;
            let config = operation_config(context, common.vault_config.as_deref(), Some(common))?;
            warning(&config, output)?;
            let key = key(cwd, key_file)?;
            let sync = sync_path(cwd, common);
            let plan = restore::build(&config, &key, &read_options(cwd, sync.as_deref()))?;
            let filter = filter(selection)?;
            if let Some(destination) = destination {
                let document = ApprovalDocument {
                    decisions: decisions(&plan, &filter, ConflictStrategy::Abort)?,
                    plan: plan.clone(),
                };
                storage::write_atomically(
                    &resolve_path(cwd, destination),
                    &format!(
                        "{}\n",
                        serde_json::to_string_pretty(&document)
                            .map_err(|error| Error::new("OUTPUT_FAILED", error.to_string()))?
                    ),
                )?;
            }
            let plan = selected(&plan, &filter)?;
            render_plan(&plan, output)?;
            Ok(plan_exit(&plan, fail))
        }
        VaultOperation::Decrypt {
            key_file,
            common,
            selection,
            dry_run,
            yes,
            conflicts,
            prompt_loop,
            no_prompt_loop,
        } => {
            let fail = fail_on(selection.fail_on.as_deref())?;
            let config = operation_config(context, common.vault_config.as_deref(), Some(common))?;
            warning(&config, output)?;
            let key = key(cwd, key_file)?;
            let sync = sync_path(cwd, common);
            let plan = restore::build(&config, &key, &read_options(cwd, sync.as_deref()))?;
            let filter = filter(selection)?;
            if *dry_run {
                let selected = selected(&plan, &filter)?;
                render_plan(&selected, output)?;
                return Ok(plan_exit(&selected, fail));
            }
            let strategy = strategy(conflicts.as_deref())?;
            let decisions = if *yes {
                let decisions = decisions(&plan, &filter, strategy)?;
                if unresolved(&plan, &decisions, &filter)? {
                    return Err(invalid(
                        "VAULT_CONFLICT_DECISION_REQUIRED",
                        "Selected conflicts require --conflicts keep-local or --conflicts take-vault.",
                    ));
                }
                decisions
            } else {
                if cli.common.non_interactive {
                    return Err(invalid(
                        "VAULT_CONFIRMATION_REQUIRED",
                        "Applying the Vault plan requires explicit approval.",
                    ));
                }
                let loop_navigation =
                    (*prompt_loop || config.restore.prompt_loop) && !no_prompt_loop;
                let redaction = match config.restore.redaction {
                    Redaction::Full => "full",
                    Redaction::Partial => "partial",
                    Redaction::None => "none",
                };
                vault_prompt::choose(
                    &plan,
                    &filter,
                    loop_navigation,
                    redaction,
                    config
                        .restore
                        .reveal
                        .map(|reveal| (reveal.start, reveal.end)),
                )?
            };
            let mut options = restore::ApplyOptions::new(cwd);
            options.read.sync_dir = sync.as_deref();
            options.auto_approve = true;
            options.decisions = Some(decisions);
            let result = restore::apply(&config, &key, &plan, &options)?;
            if output.is_json() {
                output.json(&result)?;
            } else {
                output.line(format!(
                    "Decrypted {} files from {}",
                    result.files_written,
                    result.plan.store_path.display()
                ))?;
                output.line(format!("  Applied entries: {}", result.applied_entries))?;
                output.line(format!("  Skipped entries: {}", result.skipped_entries))?;
            }
            Ok(decisions_exit(&result.plan, &result.decisions, fail))
        }
        VaultOperation::Apply {
            key_file,
            common,
            plan,
            yes,
            fail_on: fail_on_value,
        } => {
            let fail = fail_on(fail_on_value.as_deref())?;
            if !yes {
                return Err(invalid(
                    "VAULT_CONFIRMATION_REQUIRED",
                    "Applying the Vault plan requires explicit approval.",
                ));
            }
            let config = operation_config(context, common.vault_config.as_deref(), Some(common))?;
            warning(&config, output)?;
            let key = key(cwd, key_file)?;
            let path = resolve_path(cwd, plan);
            let document: ApprovalDocument =
                serde_json::from_str(&storage::read_text(&path).map_err(|_| {
                    invalid(
                        "VAULT_INVALID_PLAN_FILE",
                        "Invalid Vault approval document.",
                    )
                })?)
                .map_err(|_| {
                    invalid(
                        "VAULT_INVALID_PLAN_FILE",
                        "Invalid Vault approval document.",
                    )
                })?;
            validate_approval_document(&document)?;
            let sync = sync_path(cwd, common);
            let mut options = restore::ApplyOptions::new(cwd);
            options.read.sync_dir = sync.as_deref();
            options.auto_approve = true;
            options.decisions = Some(document.decisions);
            let result = restore::apply(&config, &key, &document.plan, &options)?;
            if output.is_json() {
                output.json(&result)?;
            } else {
                output.line(format!(
                    "Applied {} entries to {} files.",
                    result.applied_entries, result.files_written
                ))?;
            }
            Ok(decisions_exit(&result.plan, &result.decisions, fail))
        }
        VaultOperation::Sanitize {
            key_file,
            vault_config,
            excluded,
            dry_run,
            yes,
        } => {
            if !excluded {
                return Err(invalid(
                    "VAULT_INVALID_SANITIZE_OPTIONS",
                    "Vault sanitize requires --excluded.",
                ));
            }
            let config = operation_config(context, vault_config.as_deref(), None)?;
            warning(&config, output)?;
            let key = key(cwd, key_file)?;
            let store = read_store(&config, &key, cwd)?;
            let exclusions = selection::Exclusions::new(&config)?;
            let plan =
                history::sanitize(&config.store_path, &config.base_dir, &store, |file, key| {
                    exclusions.excluded(file, key)
                })?;
            let apply = !dry_run
                && (*yes
                    || prompt(
                        &format!(
                            "Remove {} record(s) from {}?",
                            plan.rewrite.summary().removed_records,
                            config.store_path.display()
                        ),
                        cli.common.non_interactive,
                    )?);
            let applied = if apply { plan.rewrite.apply()? } else { false };
            let result = serde_json::json!({ "storePath": plan.rewrite.summary().store_path, "storeDigest": plan.rewrite.summary().store_digest, "removedRecords": plan.rewrite.summary().removed_records, "keptRecords": plan.rewrite.summary().kept_records, "affectedEntries": plan.affected_entries, "applied": applied });
            if output.is_json() {
                output.json(&result)?;
            } else {
                output.line(format!(
                    "{} {} records from {}",
                    if applied {
                        "Sanitized"
                    } else {
                        "Would sanitize"
                    },
                    plan.rewrite.summary().removed_records,
                    config.store_path.display()
                ))?;
            }
            Ok(0)
        }
        VaultOperation::Prune {
            key_file,
            vault_config,
            file,
            key: key_name,
            older_than_days,
            keep_recent,
            no_preserve_latest,
            dry_run,
            yes,
        } => {
            if keep_recent.is_none() && older_than_days.is_none() {
                return Err(invalid(
                    "VAULT_INVALID_PRUNE_OPTIONS",
                    "History prune requires --keep-recent or --older-than-days.",
                ));
            }
            if *keep_recent == Some(0) {
                return Err(invalid(
                    "VAULT_INVALID_PRUNE_OPTIONS",
                    "keepRecent must be a positive integer.",
                ));
            }
            if older_than_days.is_some_and(|days| {
                !days.is_finite() || days < 0.0 || days > f64::MAX / MILLIS_PER_DAY
            }) {
                return Err(invalid(
                    "VAULT_INVALID_PRUNE_OPTIONS",
                    "olderThanDays must be a non-negative number within the supported range.",
                ));
            }
            let config = operation_config(context, vault_config.as_deref(), None)?;
            warning(&config, output)?;
            let key = key(cwd, key_file)?;
            let store = read_store(&config, &key, cwd)?;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as f64;
            let file = file.as_ref().map(|file| resolve_path(cwd, file));
            let options = history::PruneOptions {
                file: file.as_deref(),
                key: key_name.as_deref(),
                keep_recent: *keep_recent,
                older_than: older_than_days.map(|days| now - days * MILLIS_PER_DAY),
                preserve_latest: !no_preserve_latest,
            };
            let plan = history::prune(&config.store_path, &store, &options)?;
            let apply = !dry_run
                && (*yes
                    || prompt(
                        &format!(
                            "Remove {} record(s) from {}?",
                            plan.rewrite.summary().removed_records,
                            config.store_path.display()
                        ),
                        cli.common.non_interactive,
                    )?);
            let applied = if apply { plan.rewrite.apply()? } else { false };
            let result = serde_json::json!({ "storePath": plan.rewrite.summary().store_path, "storeDigest": plan.rewrite.summary().store_digest, "removedRecords": plan.rewrite.summary().removed_records, "keptRecords": plan.rewrite.summary().kept_records, "groups": plan.groups, "applied": applied });
            if output.is_json() {
                output.json(&result)?;
            } else {
                output.line(format!(
                    "{} {} records from {}",
                    if applied { "Pruned" } else { "Would prune" },
                    plan.rewrite.summary().removed_records,
                    config.store_path.display()
                ))?;
            }
            Ok(0)
        }
    }
}
