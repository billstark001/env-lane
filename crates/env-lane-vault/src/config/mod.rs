//! Native config discovery and path ownership; no executable config evaluation.
mod schema;
use env_lane_core::{
    config::{LoadedConfig, read_native_config},
    error::{Error, Result},
    paths::resolve_path,
    text::trim,
};
use indexmap::IndexSet;
pub use schema::{Config, Exclude, Redaction, Restore, Reveal, SortTarget};
use schema::{RawConfig, invalid};
use std::path::{Path, PathBuf};

pub fn load(main: &LoadedConfig, explicit: Option<&Path>) -> Result<Config> {
    let requested = match explicit {
        Some(path) => resolve_path(&main.invocation_cwd, path),
        None => resolve_path(
            &main.project_root,
            Path::new(&main.config.vault.config_file),
        ),
    };
    let file = discover(&requested)?;
    let raw = read_native_config(&file).map_err(|error| {
        Error::new(
            "VAULT_CONFIG_LOAD_FAILED",
            format!("Failed to load Vault config: {}", error.message),
        )
    })?;
    let raw: RawConfig = serde_json::from_value(raw).map_err(|error| invalid(error.to_string()))?;
    raw.validate()?;
    let base_dir = file.parent().unwrap_or(&main.project_root).to_owned();
    let output_dir = resolve_path(&base_dir, Path::new(&raw.output_dir));
    let store_path = resolve_path(&output_dir, Path::new(&raw.output_file));
    let env_files: IndexSet<_> = raw
        .env_files
        .iter()
        .map(|file| resolve_path(&base_dir, Path::new(file)))
        .collect();
    if env_files.contains(&store_path) {
        return Err(Error::new(
            "VAULT_STORE_OVERLAP",
            "The vault store file must not overlap with any env file.",
        ));
    }
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
    Ok(Config {
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
        disable_unsafe_warning: raw
            .disable_unsafe_warning
            .unwrap_or(main.config.vault.disable_unsafe_warning),
    })
}

fn discover(requested: &Path) -> Result<PathBuf> {
    if requested.is_file() {
        return Ok(requested.to_owned());
    }
    if requested.extension().is_none() {
        for extension in ["json", "yaml", "yml"] {
            let candidate = requested.with_extension(extension);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        if ["ts", "js", "mjs", "cjs", "mts", "cts"]
            .iter()
            .any(|extension| requested.with_extension(extension).is_file())
        {
            return Err(Error::new(
                "VAULT_CONFIG_COMPILATION_REQUIRED",
                "Executable Vault config requires the external configuration compiler or migration to JSON/YAML.",
            ));
        }
    }
    Err(Error::new(
        "VAULT_CONFIG_NOT_FOUND",
        format!("Vault config does not exist: {}", requested.display()),
    ))
}
