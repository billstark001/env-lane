//! Resolve a plugin from its npm package metadata without executing package code.
use crate::{Capability, Manifest, PROTOCOL_VERSION, PluginError};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Package {
    name: String,
    env_lane_plugin: Metadata,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    protocol_version: u32,
    id: String,
    capabilities: Vec<Capability>,
    entry: Entry,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Entry {
    Node {
        path: PathBuf,
    },
    Native {
        platforms: BTreeMap<String, NativeEntry>,
    },
}

#[derive(Deserialize)]
struct NativeEntry {
    package: String,
    path: PathBuf,
}

fn fault(code: &str, message: impl Into<String>) -> PluginError {
    PluginError {
        code: code.into(),
        message: message.into(),
        details: None,
    }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['\\', '\0'])
        && name
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && (name.split('/').count() == 1 || (name.starts_with('@') && name.split('/').count() == 2))
}

fn package_file(base: &Path, name: &str) -> Option<PathBuf> {
    let node_modules = base.join("node_modules").join(name).join("package.json");
    if node_modules.is_file() {
        return Some(node_modules);
    }
    let standalone = base.join("plugins").join(name).join("package.json");
    if standalone.is_file() {
        return Some(standalone);
    }
    None
}

fn locate(name: &str, project_root: &Path, executable: &Path) -> Result<PathBuf, PluginError> {
    if !valid_name(name) {
        return Err(fault(
            "PLUGIN_PACKAGE_INVALID",
            "Invalid plugin package name.",
        ));
    }
    for base in project_root.ancestors().chain(executable.ancestors()) {
        if let Some(path) = package_file(base, name) {
            return Ok(path);
        }
    }
    if let Some(root) = std::env::var_os("ENV_LANE_PLUGIN_PACKAGE_ROOT")
        && let Some(path) = package_file(Path::new(&root), name)
    {
        return Ok(path);
    }
    Err(fault(
        "PLUGIN_NOT_INSTALLED",
        format!("Plugin package {name} is not installed."),
    ))
}

fn entry_path(package_file: &Path, relative: &Path) -> Result<PathBuf, PluginError> {
    if relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(fault(
            "PLUGIN_PACKAGE_INVALID",
            "Plugin entry must stay inside its package.",
        ));
    }
    let base = package_file
        .parent()
        .ok_or_else(|| fault("PLUGIN_PACKAGE_INVALID", "Invalid package location."))?;
    let path = base.join(relative);
    let canonical_base = base
        .canonicalize()
        .map_err(|error| fault("PLUGIN_PACKAGE_INVALID", error.to_string()))?;
    let canonical_path = path.canonicalize().map_err(|_| {
        fault(
            "PLUGIN_ENTRY_MISSING",
            format!("Plugin entry does not exist: {}", path.display()),
        )
    })?;
    if !canonical_path.starts_with(canonical_base) || !canonical_path.is_file() {
        return Err(fault(
            "PLUGIN_PACKAGE_INVALID",
            "Plugin entry must be a file inside its package.",
        ));
    }
    Ok(canonical_path)
}

fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        os => os,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        arch => arch,
    };
    if os == "linux" {
        format!(
            "{os}-{arch}-{}",
            if cfg!(target_env = "musl") {
                "musl"
            } else {
                "gnu"
            }
        )
    } else if os == "windows" {
        format!("win32-{arch}-msvc")
    } else {
        format!("{os}-{arch}")
    }
}

/// Resolve one enabled root-field registration. Package metadata is the only source
/// of runtime identity, entry, command names, and native API namespaces.
pub fn resolve(
    field: &str,
    package_name: &str,
    project_root: &Path,
    executable: &Path,
) -> Result<Manifest, PluginError> {
    let path = locate(package_name, project_root, executable)?;
    let bytes =
        fs::read(&path).map_err(|error| fault("PLUGIN_PACKAGE_INVALID", error.to_string()))?;
    let package: Package = serde_json::from_slice(&bytes)
        .map_err(|error| fault("PLUGIN_PACKAGE_INVALID", error.to_string()))?;
    if package.name != package_name
        || package.env_lane_plugin.protocol_version != PROTOCOL_VERSION
        || package.env_lane_plugin.id != field
        || package.env_lane_plugin.capabilities.is_empty()
    {
        return Err(fault(
            "PLUGIN_PACKAGE_INVALID",
            format!("Invalid envLanePlugin metadata in {}.", path.display()),
        ));
    }
    let metadata = package.env_lane_plugin;
    let (executable, arguments) = match metadata.entry {
        Entry::Node { path: relative } => (
            PathBuf::from("node"),
            vec![entry_path(&path, &relative)?.to_string_lossy().into_owned()],
        ),
        Entry::Native { platforms } => {
            let target = platform();
            let entry = platforms.get(&target).ok_or_else(|| {
                fault(
                    "PLUGIN_PLATFORM_UNSUPPORTED",
                    format!("Plugin {field} has no {target} entry."),
                )
            })?;
            let binary_package = locate(
                &entry.package,
                path.parent().unwrap_or(project_root),
                executable,
            )?;
            let binary = entry_path(&binary_package, &entry.path)?;
            (binary, Vec::new())
        }
    };
    Ok(Manifest {
        id: metadata.id,
        executable,
        arguments,
        capabilities: metadata.capabilities,
    })
}
