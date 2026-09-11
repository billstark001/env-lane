//! Sync presentation redacts only the returned view, after application work.
use crate::output::Output;
use env_lane_core::{
    error::{Diagnostic, Result},
    policy,
    redaction::{self, Options as RedactionOptions},
    resolve::Context,
};
pub(super) fn execute(
    context: &Context<'_>,
    name: &str,
    build: Option<&str>,
    dry_run: bool,
    show_secrets: bool,
    output: &Output,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<i32> {
    output.require_text_or_json("The sync command does not support --format dotenv.")?;
    let mut result = policy::run_sync(
        context,
        name,
        &policy::SyncOptions { build, dry_run },
        diagnostics,
    )?;
    if output.is_json() {
        let options = RedactionOptions {
            show_secrets,
            ..Default::default()
        };
        for mapping in &mut result.mappings {
            mapping.value = redaction::redact(&mapping.to, &mapping.value, &options).to_owned();
        }
        output.json(&result)?;
    } else {
        output.line(format!(
            "{} {} -> {}",
            if result.dry_run {
                "Would sync"
            } else {
                "Synced"
            },
            result.sync,
            result.target_file.display()
        ))?;
        for mapping in result.mappings {
            output.line(format!(
                "  {} {} -> {}",
                if mapping.skipped {
                    "skipped"
                } else {
                    "mapped "
                },
                mapping.from,
                mapping.to
            ))?;
        }
        if !result.dry_run {
            output.line(format!("  Changed: {}", result.changed))?;
        }
    }
    Ok(0)
}
