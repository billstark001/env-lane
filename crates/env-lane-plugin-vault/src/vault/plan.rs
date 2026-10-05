//! Restore plan selection, approvals, rendering, and exit policy.
use super::options::invalid;
use env_lane_cli::output::Output;
use env_lane_core::error::Result;
use env_lane_vault::{
    push::ConflictStrategy,
    restore::{self, Action, Decision, DecisionChoice, Plan},
    selection,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};

#[derive(Serialize, Deserialize)]
pub(super) struct ApprovalDocument {
    pub(super) plan: Plan,
    pub(super) decisions: Vec<Decision>,
}

pub(super) fn validate_approval_document(document: &ApprovalDocument) -> Result<()> {
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
pub(super) fn selected(plan: &Plan, filter: &selection::PreparedFilter) -> Result<Plan> {
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
pub(super) fn action_name(action: Action) -> &'static str {
    match action {
        Action::Add => "add",
        Action::Modify => "modify",
        Action::Delete => "delete",
        Action::Identical => "identical",
        Action::Conflict => "conflict",
    }
}
pub(super) fn decisions(
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
pub(super) fn unresolved(
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
pub(super) fn render_plan(plan: &Plan, output: &Output) -> Result<()> {
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
pub(super) fn plan_exit(plan: &Plan, fail_on: Option<&str>) -> i32 {
    match fail_on {
        Some("change") if plan.summary.files_with_changes > 0 => 2,
        Some("conflict") if plan.summary.conflict > 0 => 2,
        Some("warning") if plan.failed_records > 0 || !plan.unmanaged_store_files.is_empty() => 2,
        _ => 0,
    }
}

/// Apply checks count only entries whose explicit decisions were kept. A
/// prompt or approval document can skip an entry that matched CLI filters.
pub(super) fn decisions_exit(plan: &Plan, decisions: &[Decision], fail_on: Option<&str>) -> i32 {
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
pub(super) fn read_options<'a>(cwd: &'a Path, sync: Option<&'a Path>) -> restore::Options<'a> {
    let mut options = restore::Options::new(cwd);
    options.sync_dir = sync;
    options
}
