//! Vault store maintenance commands.
use super::options::*;
use crate::arguments::VaultOperation;
use env_lane_cli::{arguments::Common, output::Output};
use env_lane_core::{error::Result, paths::resolve_path, resolve::Context};
use env_lane_vault::{history, selection};
use std::time::{SystemTime, UNIX_EPOCH};

const MILLIS_PER_DAY: f64 = 86_400_000.0;

pub(super) fn execute(
    operation: &VaultOperation,
    cli_common: &Common,
    context: &Context<'_>,
    output: &Output,
) -> Result<i32> {
    let cwd = &context.loaded.invocation_cwd;
    match operation {
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
                        cli_common.non_interactive,
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
                        cli_common.non_interactive,
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
        _ => unreachable!("Vault dispatch"),
    }
}
