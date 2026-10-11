//! Sorting output is separate from the shared file-plan implementation.
use crate::{arguments::SortOptions as SortArguments, output::Output};
use env_lane_core::{document::Eol, error::Result, paths::resolve_path, resolve::Context, sort};
use std::path::Path;
pub(super) fn file(
    context: &Context<'_>,
    env_file: &Path,
    template_file: &Path,
    options: &SortArguments,
    output: &Output,
) -> Result<i32> {
    output.require_text_or_json("Sort commands do not support --format dotenv.")?;
    let defaults = context
        .loaded
        .config
        .sort
        .as_ref()
        .and_then(|targets| targets.get(&context.loaded.config.selector.sort_defaults_key));
    let result = sort::sort_file(
        &resolve_path(&context.loaded.invocation_cwd, env_file),
        &resolve_path(&context.loaded.invocation_cwd, template_file),
        &sort::SortOptions {
            create: if options.create {
                true
            } else if options.no_create {
                false
            } else {
                defaults.and_then(|target| target.create).unwrap_or(false)
            },
            sync_dir: options
                .sync_dir
                .as_ref()
                .map(|directory| resolve_path(&context.loaded.invocation_cwd, directory))
                .or_else(|| {
                    defaults
                        .and_then(|target| target.sync_dir.as_ref())
                        .map(|directory| resolve_path(&context.loaded.project_root, directory))
                })
                .or_else(|| Some(context.loaded.project_root.join(".env-lane-cache"))),
            check: options.check,
            preserve_bom: !options.no_preserve_bom,
            eol: parse_eol(options).unwrap_or_default(),
            unlisted_variables_comment: defaults
                .and_then(|target| target.unlisted_variables_comment.clone())
                .unwrap_or_default(),
        },
    )?;
    if output.is_json() {
        output.json(&result)?;
    } else if options.check {
        output.line(format!(
            "{} {}",
            if result.status == sort::Status::Missing {
                "Skipped missing"
            } else if result.changed || !result.conflicts.is_empty() {
                "Sort drift found in"
            } else {
                "Sort check passed for"
            },
            env_file.display()
        ))?;
    } else {
        output.line(format!(
            "{} {}",
            if result.status == sort::Status::Missing {
                "Skipped missing"
            } else if result.applied {
                "Sorted"
            } else {
                "No changes for"
            },
            env_file.display()
        ))?;
        if result.applied {
            output.line(format!("  Moved: {}", result.summary.moved_count))?;
            output.line(format!(
                "  Inserted commented: {}",
                result.summary.inserted_commented_count
            ))?;
        }
    }
    if !output.is_json() {
        render_operations(&result, &context.loaded.project_root, output)?;
    }
    Ok(i32::from(
        options.check && (result.changed || !result.conflicts.is_empty()),
    ))
}
pub(super) fn configured(
    context: &Context<'_>,
    key: Option<&str>,
    env_suffix: Option<&str>,
    options: &SortArguments,
    output: &Output,
) -> Result<i32> {
    output.require_text_or_json("Sort commands do not support --format dotenv.")?;
    let result = sort::sort_configured(
        context.loaded,
        context.packages,
        key,
        env_suffix,
        &sort::ConfiguredOptions {
            create: if options.create {
                Some(true)
            } else if options.no_create {
                Some(false)
            } else {
                None
            },
            sync_dir: options.sync_dir.clone(),
            check: options.check,
            preserve_bom: Some(!options.no_preserve_bom),
            eol: parse_eol(options),
        },
    )?;
    if output.is_json() {
        output.json(&result)?;
    } else {
        if options.check {
            output.line(
                if result.changed || result.results.iter().any(|file| !file.conflicts.is_empty()) {
                    "Sort drift found."
                } else {
                    "Sort check passed."
                },
            )?;
        } else {
            output.line(format!("Sort applied: {}", result.applied))?;
        }
        output.line(format!(
            "Sort checked: {} · missing: {} · unchanged: {}",
            result.count, result.missing_count, result.unchanged_count
        ))?;
        for file in &result.results {
            let status = match file.status {
                sort::Status::Missing => "MISSING",
                sort::Status::Conflict => "CONFLICT",
                sort::Status::Unchanged => "UNCHANGED",
                sort::Status::Changed => "DRIFT",
                sort::Status::Applied => "SORTED",
            };
            output.line(format!(
                "{status} {}",
                env_lane_core::presentation::inline(&env_lane_core::paths::relative_path(
                    &context.loaded.project_root,
                    &file.file_path
                ))
            ))?;
            render_operations(file, &context.loaded.project_root, output)?;
        }
    }
    Ok(i32::from(
        options.check
            && (result.changed || result.results.iter().any(|file| !file.conflicts.is_empty())),
    ))
}
fn parse_eol(options: &SortArguments) -> Option<Eol> {
    // Keep permissive CLI strings outside the typed document API. Unknown values
    // retain the existing line endings, just like an explicit `auto` selection.
    options.eol.as_deref().map(|value| match value {
        "lf" => Eol::Lf,
        "crlf" => Eol::Crlf,
        _ => Eol::Auto,
    })
}

fn render_operations(result: &sort::SortResult, root: &Path, output: &Output) -> Result<()> {
    let changes = result
        .operations
        .iter()
        .filter(|operation| {
            result.changed || matches!(operation.action, sort::Action::ConflictKeptLocal)
        })
        .map(|operation| {
            (
                operation.key.clone(),
                match operation.action {
                    sort::Action::Move => "moved",
                    sort::Action::InsertCommented => "inserted commented",
                    sort::Action::AppendExtra => "unlisted",
                    sort::Action::AppendDuplicate => "duplicate appended",
                    sort::Action::GroupDuplicate => "duplicates grouped",
                    sort::Action::DefaultUpdated => "default updated",
                    sort::Action::CommentUpdated => "comment updated",
                    sort::Action::ConflictKeptLocal => "conflict kept-local",
                }
                .to_owned(),
            )
        })
        .collect::<Vec<_>>();
    output.variable_changes(&result.file_path, root, &changes)?;
    for conflict in &result.conflicts {
        output.line(format!(
            "  Conflict: {} ({}) — kept local",
            env_lane_core::presentation::inline(&conflict.key),
            conflict.field
        ))?;
    }
    Ok(())
}
