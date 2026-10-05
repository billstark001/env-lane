//! Template-guided sorting plans are pure. File creation and check-only behavior
//! are applied after the plan is complete, through the shared storage boundary.
mod comments;
mod configured;
pub use configured::{ConfiguredOptions, ConfiguredResult, sort_configured};
mod layout;
mod plan;

use crate::{
    document::Eol,
    error::{Error, Result},
    storage::{load_document, write_if_changed},
};
pub use plan::{Plan, build_plan};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SortOptions {
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
            create: true,
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
            }
        }
        summary
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SortResult {
    pub applied: bool,
    pub changed: bool,
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
        file_path: file.into(),
        template_file_path: template.into(),
        operations: Vec::new(),
        summary: Summary::default(),
    };
    if !options.create && !file.exists() {
        return Ok(result);
    }
    if !template.exists() {
        return Err(Error::new(
            "SORT_TEMPLATE_NOT_FOUND",
            format!("Template env file does not exist: {}", template.display()),
        ));
    }
    let current = load_document(file)?;
    let template = load_document(template)?;
    let plan = build_plan(
        current.exists.then_some(current.content.as_str()),
        &template.content,
        options,
    );
    result.changed = plan.changed;
    result.operations = plan.operations;
    result.summary = plan.summary;
    if plan.changed && !options.check {
        result.applied = write_if_changed(file, &plan.next_content)?;
    }
    Ok(result)
}
