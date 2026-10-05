//! Encrypt and push Vault records.
use super::options::*;
use crate::arguments::VaultOperation;
use env_lane_cli::output::Output;
use env_lane_core::{error::Result, resolve::Context};
use env_lane_vault::push;

pub(super) fn execute(
    operation: &VaultOperation,
    context: &Context<'_>,
    output: &Output,
) -> Result<i32> {
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
        _ => unreachable!("Vault dispatch"),
    }
}
