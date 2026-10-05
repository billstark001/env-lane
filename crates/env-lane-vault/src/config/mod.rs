//! Native config discovery and path ownership; no executable config evaluation.
mod schema;
use env_lane_core::{
    config::{EXECUTABLE_EXTENSIONS, LoadedConfig, NATIVE_EXTENSIONS, read_config},
    error::{Error, Result},
    paths::resolve_path,
    text::trim,
};
use indexmap::IndexSet;
pub use schema::{Config, Exclude, Redaction, Restore, Reveal, SortTarget};
use schema::{RawConfig, invalid};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub fn load(main: &LoadedConfig, explicit: Option<&Path>) -> Result<Config> {
    let registration = main.config.plugins.get("vault").ok_or_else(|| {
        Error::new(
            "PLUGIN_DISABLED",
            "Vault plugin is not enabled in the main config.",
        )
    })?;
    if !registration.enabled {
        return Err(Error::new(
            "PLUGIN_DISABLED",
            "Vault plugin is not enabled in the main config.",
        ));
    }
    let requested = match explicit {
        Some(path) => resolve_path(&main.invocation_cwd, path),
        None => resolve_path(
            &main.project_root,
            Path::new(
                registration
                    .config_file("vault")
                    .expect("built-in config file"),
            ),
        ),
    };
    let file = discover(&requested)?;
    let raw = read_config(&file, &main.project_root, "vault").map_err(|error| {
        if error.code == "CONFIG_COMPILATION_REQUIRED" {
            error
        } else {
            Error::new(
                "VAULT_CONFIG_LOAD_FAILED",
                format!("Failed to load Vault config: {}", error.message),
            )
        }
    })?;
    resolve_raw(
        raw,
        file.parent().unwrap_or(&main.project_root),
        registration.disable_unsafe_warning,
    )
}

/// Canonicalize a plugin config supplied by a JS/TS source evaluator.
pub fn resolve_raw(raw: Value, base_dir: &Path, disable_unsafe_warning: bool) -> Result<Config> {
    let raw: RawConfig = serde_json::from_value(raw).map_err(|error| invalid(error.to_string()))?;
    raw.validate()?;
    let base_dir = base_dir.to_owned();
    let output_dir = resolve_path(&base_dir, Path::new(&raw.output_dir));
    let store_path = resolve_path(&output_dir, Path::new(&raw.output_file));
    let env_files: IndexSet<_> = raw
        .env_files
        .iter()
        .map(|file| resolve_path(&base_dir, Path::new(file)))
        .collect();
    let exclude = raw
        .exclude
        .into_iter()
        .map(|rule| Exclude {
            files: rule
                .files
                .iter()
                .map(|value| trim(value).to_owned())
                .collect(),
            keys: rule
                .keys
                .iter()
                .map(|value| trim(value).to_owned())
                .collect(),
        })
        .collect();
    let config = Config {
        base_dir,
        env_files: env_files.into_iter().collect(),
        output_dir,
        store_path,
        output_file: raw.output_file,
        track_deletions: raw.track_deletions,
        auto_remap_paths: raw.auto_remap_paths,
        allow_unmanaged: raw.allow_unmanaged,
        restore: raw.restore,
        exclude,
        sort: raw.sort,
        disable_unsafe_warning: raw.disable_unsafe_warning.unwrap_or(disable_unsafe_warning),
    };
    config.validate_resolved()?;
    Ok(config)
}

fn discover(requested: &Path) -> Result<PathBuf> {
    if requested.is_file() {
        return Ok(requested.to_owned());
    }
    let extension = requested.extension().and_then(|value| value.to_str());
    let supported = NATIVE_EXTENSIONS.iter().chain(EXECUTABLE_EXTENSIONS);
    if extension.is_none_or(|value| !supported.clone().any(|known| *known == value))
        && let Some(candidate) = supported
            .map(|extension| PathBuf::from(format!("{}.{extension}", requested.display())))
            .find(|candidate| candidate.is_file())
    {
        return Ok(candidate);
    }
    Err(Error::new(
        "VAULT_CONFIG_NOT_FOUND",
        format!("Vault config does not exist: {}", requested.display()),
    ))
}
