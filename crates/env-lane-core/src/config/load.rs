//! Locate native configuration and resolve each path against its owning root.
use super::{Config, invalid, parse_yaml};
use crate::{
    error::{Error, Result},
    paths::{find_root, resolve_path},
};
use serde_json::Value;
use std::path::{Path, PathBuf};

const NATIVE_EXTENSIONS: &[&str] = &["json", "yaml", "yml"];
const EXTERNAL_EXTENSIONS: &[&str] = &[
    "ts", "js", "mjs", "cjs", "mts", "cts", "jsonc", "json5", "toml",
];

/// Keep origin information alongside the schema. Cache placement must never
/// change the meaning of paths owned by the original configuration.
#[derive(Debug)]
pub struct LoadedConfig {
    pub config: Config,
    pub invocation_cwd: PathBuf,
    pub project_root: PathBuf,
    pub config_file: Option<PathBuf>,
    pub config_dir: PathBuf,
}

pub fn load(cwd: &Path, explicit: Option<&Path>) -> Result<LoadedConfig> {
    let process_cwd = std::env::current_dir().map_err(|error| invalid(error.to_string()))?;
    let invocation_cwd = resolve_path(&process_cwd, cwd);
    let project_root = find_root(&invocation_cwd);
    let config_file = match explicit {
        Some(path) => Some(resolve_path(&invocation_cwd, path)),
        None => discover_config(&project_root)?,
    };
    let raw = match &config_file {
        Some(path) => read_native_config(path)?,
        None => serde_json::json!({}),
    };
    let mut config = Config::from_value(raw.clone())?;
    resolve_workspace_globs(&mut config, &raw, &project_root)?;
    resolve_sort_directories(&mut config, &project_root);
    let config_dir = config_file
        .as_ref()
        .and_then(|path| path.parent())
        .unwrap_or(&project_root)
        .to_owned();

    Ok(LoadedConfig {
        config,
        invocation_cwd,
        project_root,
        config_file,
        config_dir,
    })
}

fn discover_config(project_root: &Path) -> Result<Option<PathBuf>> {
    if let Some(file) = find_config_with_extension(project_root, NATIVE_EXTENSIONS) {
        return Ok(Some(file));
    }
    if find_config_with_extension(project_root, EXTERNAL_EXTENSIONS).is_some() {
        return Err(compilation_required());
    }
    Ok(None)
}

fn find_config_with_extension(root: &Path, extensions: &[&str]) -> Option<PathBuf> {
    extensions
        .iter()
        .map(|extension| root.join(format!("env-lane.config.{extension}")))
        .find(|path| path.is_file())
}

pub fn read_native_config(path: &Path) -> Result<Value> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !NATIVE_EXTENSIONS.contains(&extension) {
        return Err(compilation_required());
    }
    let content = std::fs::read_to_string(path).map_err(|error| invalid(error.to_string()))?;
    match extension {
        "json" => serde_json::from_str(content.strip_prefix('\u{feff}').unwrap_or(&content))
            .map_err(|error| invalid(error.to_string())),
        _ => parse_yaml(&content),
    }
}

fn compilation_required() -> Error {
    Error::new(
        "CONFIG_COMPILATION_REQUIRED",
        "Executable config requires external compilation. Run env-lane-config compile or migrate to JSON/YAML.",
    )
}

fn resolve_workspace_globs(config: &mut Config, raw: &Value, root: &Path) -> Result<()> {
    // Explicit [] skips pnpm discovery but still selects the built-in fallback.
    if raw.pointer("/workspace/packageGlobs").is_none() {
        config.workspace.package_globs = read_workspace_globs(root)?;
    }
    if config.workspace.package_globs.is_empty() {
        config.workspace.package_globs = vec!["packages/*".into(), "apps/*".into()];
    }
    Ok(())
}

fn read_workspace_globs(root: &Path) -> Result<Vec<String>> {
    let file = root.join("pnpm-workspace.yaml");
    if !file.is_file() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(file).map_err(|error| invalid(error.to_string()))?;
    let value = parse_yaml(&content)?;
    let Some(packages) = value["packages"].as_array() else {
        return Ok(Vec::new());
    };
    Ok(packages
        .iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect())
}

fn resolve_sort_directories(config: &mut Config, root: &Path) {
    let Some(targets) = &mut config.sort else {
        return;
    };
    for target in targets.values_mut() {
        if let Some(base_dir) = &target.base_dir {
            // Sort baseDir is explicitly root-relative in the frozen contract,
            // including when --config names a file in a different directory.
            target.base_dir = Some(resolve_path(root, base_dir));
        }
    }
}
