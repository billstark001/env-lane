//! Template-guided sorting plans are pure. File creation and check-only behavior
//! are applied after the plan is complete, through the shared storage boundary.
mod comments;
mod configured;
pub use configured::{ConfiguredOptions, ConfiguredResult, sort_configured};
mod layout;
mod plan;
mod state;
pub use state::Conflict;

use crate::{
    document::Eol,
    error::{Error, Result},
    storage::{load_document, write_atomically, write_if_changed},
};
pub use plan::{Plan, build_plan};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SortOptions {
    pub sync_dir: Option<PathBuf>,
    pub create: bool,
    pub check: bool,
    #[serde(rename = "preserveBOM")]
    pub preserve_bom: bool,
    pub eol: Eol,
    pub unlisted_variables_comment: String,
}
impl Default for SortOptions {
    fn default() -> Self {
        Self {
            sync_dir: None,
            create: false,
            check: false,
            preserve_bom: true,
            eol: Eol::Auto,
            unlisted_variables_comment: String::new(),
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Move,
    InsertCommented,
    AppendExtra,
    AppendDuplicate,
    GroupDuplicate,
    DefaultUpdated,
    CommentUpdated,
    ConflictKeptLocal,
}
#[derive(Debug, Serialize)]
pub struct Operation {
    pub action: Action,
    pub key: String,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub moved_count: usize,
    pub inserted_commented_count: usize,
    pub appended_extra_count: usize,
    pub appended_duplicate_count: usize,
    pub grouped_duplicate_count: usize,
}
impl Summary {
    fn from_operations(operations: &[Operation]) -> Self {
        let mut summary = Self::default();
        for operation in operations {
            match operation.action {
                Action::Move => summary.moved_count += 1,
                Action::InsertCommented => summary.inserted_commented_count += 1,
                Action::AppendExtra => summary.appended_extra_count += 1,
                Action::AppendDuplicate => summary.appended_duplicate_count += 1,
                Action::GroupDuplicate => summary.grouped_duplicate_count += 1,
                Action::DefaultUpdated | Action::CommentUpdated | Action::ConflictKeptLocal => {}
            }
        }
        summary
    }
}
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Missing,
    Unchanged,
    Conflict,
    Changed,
    Applied,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SortResult {
    pub applied: bool,
    pub changed: bool,
    pub status: Status,
    pub conflicts: Vec<Conflict>,
    pub file_path: PathBuf,
    pub template_file_path: PathBuf,
    pub operations: Vec<Operation>,
    #[serde(flatten)]
    pub summary: Summary,
}
pub fn sort_file(file: &Path, template: &Path, options: &SortOptions) -> Result<SortResult> {
    let mut result = SortResult {
        applied: false,
        changed: false,
        status: Status::Unchanged,
        conflicts: Vec::new(),
        file_path: file.into(),
        template_file_path: template.into(),
        operations: Vec::new(),
        summary: Summary::default(),
    };
    if !options.create && !file.exists() {
        result.status = Status::Missing;
        return Ok(result);
    }
    if !template.exists() {
        return Err(Error::new(
            "SORT_TEMPLATE_NOT_FOUND",
            format!("Template env file does not exist: {}", template.display()),
        ));
    }
    let directory = options.sync_dir.clone().unwrap_or_else(|| {
        crate::paths::find_root(file.parent().unwrap_or(Path::new("."))).join(".env-lane-cache")
    });
    let mut state = state::Store::load(&directory, file, template, options.check)?;
    let current = load_document(file)?;
    let template = load_document(template)?;
    let reconciled = state.reconcile(&current.content, &template.content, current.exists)?;
    let mut plan = plan::build_synced_plan(
        current.exists.then_some(reconciled.content.as_str()),
        &reconciled.template,
        options,
        reconciled.established,
    );
    plan.changed = !current.exists || current.content != plan.next_content;
    plan.operations.extend(reconciled.operations);
    result.conflicts = reconciled.conflicts;
    result.changed = plan.changed;
    result.operations = plan.operations;
    result.summary = plan.summary;
    if plan.changed && !options.check {
        result.applied = if current.exists {
            write_if_changed(file, &plan.next_content)?
        } else {
            write_atomically(file, &plan.next_content)?;
            true
        };
    }
    result.status = if !result.conflicts.is_empty() {
        Status::Conflict
    } else if result.applied {
        Status::Applied
    } else if result.changed {
        Status::Changed
    } else {
        Status::Unchanged
    };
    if !options.check {
        state.save()?;
    }
    Ok(result)
}
