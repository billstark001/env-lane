//! Read a precompiled JavaScript configuration without executing Node or source code.
use crate::error::{Error, Result};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dependency {
    file: PathBuf,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    format_version: u32,
    bridge_version: String,
    kind: String,
    source: PathBuf,
    project_root: PathBuf,
    config_dir: PathBuf,
    cacheable: bool,
    dependencies: Vec<Dependency>,
    config: Value,
}

fn digest(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

fn compile_required(kind: &str, reason: &str) -> Error {
    let code = if kind == "vault" {
        "VAULT_CONFIG_COMPILATION_REQUIRED"
    } else {
        "CONFIG_COMPILATION_REQUIRED"
    };
    Error::new(
        code,
        format!(
            "{reason}. Run env-lane-config compile --kind {kind}, or migrate to a native declarative format."
        ),
    )
}

pub(super) fn load(root: &Path, source: &Path, kind: &str) -> Result<Value> {
    let name = format!(
        "{kind}-{}.json",
        digest(source.to_string_lossy().as_bytes())
    );
    let file = root.join(".env-lane-cache").join(name);
    let bytes = std::fs::read(&file)
        .map_err(|_| compile_required(kind, "Executable config has no compiled cache"))?;
    let envelope: Envelope = serde_json::from_slice(&bytes)
        .map_err(|_| compile_required(kind, "Executable config cache is invalid"))?;
    if envelope.format_version != 1
        || envelope.bridge_version != env!("CARGO_PKG_VERSION")
        || envelope.kind != kind
        || envelope.source != source
        || envelope.project_root != root
        || envelope.config_dir != source.parent().unwrap_or(root)
        || envelope.dependencies.is_empty()
    {
        return Err(compile_required(
            kind,
            "Executable config cache is incompatible",
        ));
    }
    if !envelope.cacheable {
        let variable = if kind == "vault" {
            "ENV_LANE_VAULT_CONFIG_CACHE"
        } else {
            "ENV_LANE_MAIN_CONFIG_CACHE"
        };
        if std::env::var_os(variable).is_none_or(|value| value != file.as_os_str()) {
            return Err(compile_required(
                kind,
                "Dynamic executable config requires a fresh compatibility runner invocation",
            ));
        }
    }
    for dependency in envelope.dependencies {
        let current = std::fs::read(&dependency.file)
            .map_err(|_| compile_required(kind, "Executable config source is missing"))?;
        if digest(&current) != dependency.sha256 {
            return Err(compile_required(kind, "Executable config cache is stale"));
        }
    }
    Ok(envelope.config)
}
