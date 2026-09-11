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
    let result = sort::sort_file(
        &resolve_path(&context.loaded.invocation_cwd, env_file),
        &resolve_path(&context.loaded.invocation_cwd, template_file),
        &sort::SortOptions {
            check: options.check,
            preserve_bom: !options.no_preserve_bom,
            eol: parse_eol(options).unwrap_or_default(),
            ..Default::default()
        },
    )?;
    if output.is_json() {
        output.json(&result)?;
    } else if options.check {
        output.line(format!(
            "{} {}",
            if result.changed {
                "Sort drift found in"
            } else {
                "Sort check passed for"
            },
            env_file.display()
        ))?;
    } else {
        output.line(format!(
            "{} {}",
            if result.applied {
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
    Ok(i32::from(options.check && result.changed))
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
            check: options.check,
            preserve_bom: Some(!options.no_preserve_bom),
            eol: parse_eol(options),
            ..Default::default()
        },
    )?;
    if output.is_json() {
        output.json(&result)?;
    } else {
        if options.check {
            output.line(if result.changed {
                "Sort drift found."
            } else {
                "Sort check passed."
            })?;
        } else {
            output.line(format!("Sort applied: {}", result.applied))?;
        }
        for file in result.results {
            let status = if options.check {
                if file.changed { "DRIFT  " } else { "OK     " }
            } else if file.applied {
                "SORTED "
            } else {
                "SKIPPED"
            };
            output.line(format!("{status} {}", file.file_path.display()))?;
        }
    }
    Ok(i32::from(options.check && result.changed))
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
