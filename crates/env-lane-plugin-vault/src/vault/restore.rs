//! Plan, decrypt, and apply Vault records.
use super::{options::*, plan::*};
use crate::arguments::VaultOperation;
use crate::vault_prompt;
use env_lane_cli::{arguments::Common, output::Output};
use env_lane_core::{
    error::{Error, Result},
    paths::resolve_path,
    resolve::Context,
    storage,
};
use env_lane_vault::{config::Redaction, push::ConflictStrategy, restore};

pub(super) fn execute(
    operation: &VaultOperation,
    cli_common: &Common,
    context: &Context<'_>,
    output: &Output,
) -> Result<i32> {
    let cwd = &context.loaded.invocation_cwd;
    match operation {
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
                if cli_common.non_interactive {
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
        _ => unreachable!("Vault dispatch"),
    }
}
