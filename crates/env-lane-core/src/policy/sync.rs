use super::{
    source::load_source,
    transform::{interpolate, transform},
};
use crate::{
    config::Sync,
    document::{Patch, PatchOptions, Update},
    error::{Diagnostic, Error, Result},
    paths::resolve_path,
    resolve::{Context, select_build},
    storage::patch_file,
    text::trim,
    workspace::resolve_target,
};
use indexmap::IndexMap;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Default)]
pub struct SyncOptions<'a> {
    pub build: Option<&'a str>,
    pub dry_run: bool,
}
#[derive(Debug, Serialize)]
pub struct MappingResult {
    pub from: String,
    pub to: String,
    pub value: String,
    pub skipped: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncWrite {
    pub changed: bool,
    pub file_path: PathBuf,
    pub written_keys: Vec<String>,
    pub removed_duplicate_keys: Vec<String>,
    pub restored_commented_keys: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub sync: String,
    pub build: String,
    pub target_file: PathBuf,
    pub changed: bool,
    pub dry_run: bool,
    pub mappings: Vec<MappingResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write: Option<SyncWrite>,
}

pub fn run_sync(
    context: &Context<'_>,
    name: &str,
    options: &SyncOptions<'_>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<SyncResult> {
    let config = &context.loaded.config;
    let sync = config
        .sync
        .as_ref()
        .and_then(|syncs| syncs.get(name))
        .ok_or_else(|| Error::new("UNKNOWN_ENV_SYNC", format!("Unknown env sync '{name}'.")))?;
    let build = select_build(
        options.build,
        &config.selector,
        context.process_env,
        diagnostics,
    )?;
    let source = load_source(context, "from", &sync.from, &build, diagnostics)?;
    let target_file = target_file(context, sync, &build, diagnostics)?;
    let mut values = IndexMap::new();
    let mappings = sync
        .mappings
        .iter()
        .map(|mapping| {
            let value = transform(
                source.get(&mapping.from).map(String::as_str).unwrap_or(""),
                mapping.transform.as_ref(),
            );
            let skipped = trim(&value).is_empty();
            if !skipped {
                values.insert(mapping.to.clone(), value.clone());
            }
            MappingResult {
                from: mapping.from.clone(),
                to: mapping.to.clone(),
                value,
                skipped,
            }
        })
        .collect();
    let mut result = SyncResult {
        sync: name.into(),
        build,
        target_file,
        changed: false,
        dry_run: options.dry_run,
        mappings,
        write: None,
    };
    // Preview reports mapping intent without opening the destination or creating
    // directories. This also preserves the legacy dry-run changed=false contract.
    if options.dry_run {
        return Ok(result);
    }
    let patches = values
        .into_iter()
        .map(|(key, value)| Patch::Set { key, value })
        .collect::<Vec<_>>();
    let written = patch_file(
        &result.target_file,
        &patches,
        &PatchOptions {
            update: Update::Last,
            match_commented: true,
            remove_duplicate_entries: true,
            ..Default::default()
        },
    )?;
    result.changed = written.changed;
    result.write = Some(SyncWrite {
        changed: written.changed,
        file_path: result.target_file.clone(),
        written_keys: written.written_keys,
        removed_duplicate_keys: written.removed_duplicate_keys,
        restored_commented_keys: written.restored_commented_keys,
    });
    Ok(result)
}

fn target_file(
    context: &Context<'_>,
    sync: &Sync,
    build: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<PathBuf> {
    let variant = crate::variants::normalize_variant(
        sync.to.variant.as_deref(),
        build,
        false,
        "sync target variant",
    )?;
    if let Some(file) = &sync.to.source.file {
        return Ok(resolve_path(
            &context.loaded.project_root,
            Path::new(&interpolate(file, &variant)),
        ));
    }
    let target = sync.to.source.target.as_deref().ok_or_else(|| {
        Error::new(
            "INVALID_ENV_SYNC_TARGET",
            "Sync target must include target or file.",
        )
    })?;
    let package = resolve_target(
        context.packages,
        Some(target),
        &context.loaded.config.workspace.default_target,
        Some(&context.loaded.project_root),
    )?;
    if variant.is_empty() {
        return Ok(package.dir.join(".env"));
    }
    // A variant selected for a target is a build selection too and must honor its
    // validation policy, whereas explicit file patterns do not need target lookup.
    let variant = select_build(
        Some(&variant),
        &context.loaded.config.selector,
        context.process_env,
        diagnostics,
    )?;
    let files = context.files_for_target(package, &variant, None);
    Ok(files
        .into_iter()
        .find(|file| file.order > 0)
        .map(|file| file.path)
        .unwrap_or_else(|| package.dir.join(format!(".env.{variant}"))))
}
