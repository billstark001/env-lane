use super::transform::interpolate;
use crate::{
    config::ValueSource,
    error::{Diagnostic, Error, Result},
    paths::resolve_path,
    resolve::{Context, Environment, Options, ValueOrigin},
    storage::load_document,
};
use std::path::Path;

pub(super) fn load_source(
    context: &Context<'_>,
    name: &str,
    source: &ValueSource,
    build: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Environment> {
    if let Some(file) = &source.file {
        let path = resolve_path(
            &context.loaded.project_root,
            Path::new(&interpolate(file, build)),
        );
        let document = load_document(&path)?;
        // File sources are literal document reads. includeProcessEnv only affects
        // target sources, whose values pass through the complete resolver.
        return Ok(document
            .parsed
            .current_map
            .into_iter()
            .map(|(key, entry)| (key, entry.effective_value))
            .collect());
    }
    let target = source.target.as_deref().ok_or_else(|| {
        Error::new(
            "INVALID_ENV_SOURCE",
            format!("Source '{name}' must include target or file."),
        )
    })?;
    let include_process = source.include_process_env.unwrap_or(false);
    let resolved = context.resolve(
        &Options {
            target: Some(target),
            build: Some(build),
            include_process_env: Some(include_process),
            require_override: None,
        },
        diagnostics,
    )?;
    Ok(resolved
        .values
        .into_iter()
        .filter(|(key, _)| {
            include_process || matches!(resolved.sources.get(key), Some(ValueOrigin::Dotenv { .. }))
        })
        .collect())
}
