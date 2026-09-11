//! Canonical Vault configuration. Alternate JS field names are an outer adapter concern.
use env_lane_core::error::{Error, Result};
use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::path::PathBuf;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub base_dir: PathBuf,
    pub env_files: Vec<PathBuf>,
    pub output_dir: PathBuf,
    pub output_file: String,
    pub store_path: PathBuf,
    pub track_deletions: bool,
    pub auto_remap_paths: bool,
    pub allow_unmanaged: bool,
    pub restore: Restore,
    pub exclude: Vec<Exclude>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort: Option<IndexMap<String, SortTarget>>,
    pub disable_unsafe_warning: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawConfig {
    pub env_files: Vec<String>,
    #[serde(default = "output_dir")]
    pub output_dir: String,
    #[serde(default = "output_file")]
    pub output_file: String,
    #[serde(default = "enabled")]
    pub track_deletions: bool,
    #[serde(default = "enabled")]
    pub auto_remap_paths: bool,
    #[serde(default)]
    pub allow_unmanaged: bool,
    #[serde(default)]
    pub restore: Restore,
    #[serde(default)]
    pub exclude: Vec<Exclude>,
    #[serde(default, deserialize_with = "present")]
    pub sort: Option<IndexMap<String, SortTarget>>,
    #[serde(default, deserialize_with = "present")]
    pub disable_unsafe_warning: Option<bool>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Restore {
    pub redaction: Redaction,
    #[serde(deserialize_with = "read_reveal", serialize_with = "write_reveal")]
    pub reveal: Option<Reveal>,
    pub prompt_loop: bool,
}
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Redaction {
    #[default]
    Full,
    Partial,
    None,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(default)]
pub struct Reveal {
    pub start: u8,
    pub end: u8,
}
impl Default for Reveal {
    fn default() -> Self {
        Self { start: 4, end: 4 }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Exclude {
    pub files: Vec<String>,
    pub keys: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct SortTarget {
    pub file: String,
    pub template: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub files: Option<IndexMap<String, String>>,
}

// Optional means omitted, not null. Deserializing the inner type preserves that
// distinction without traversing arbitrary extension fields in the raw config.
fn present<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl RawConfig {
    pub(super) fn validate(&self) -> Result<()> {
        if self.env_files.iter().any(String::is_empty)
            || self.output_dir.is_empty()
            || self.output_file.is_empty()
        {
            return Err(invalid("Vault paths must be non-empty strings."));
        }
        for rule in &self.exclude {
            if rule.files.is_empty()
                || rule.keys.is_empty()
                || rule
                    .files
                    .iter()
                    .chain(&rule.keys)
                    .any(|value| env_lane_core::text::trim(value).is_empty())
            {
                return Err(invalid(
                    "Each exclude rule must contain non-empty files and keys patterns.",
                ));
            }
        }
        if let Some(reveal) = self.restore.reveal
            && (reveal.start > 64 || reveal.end > 64)
        {
            return Err(invalid(
                "restoreReveal start/end must be integers between 0 and 64.",
            ));
        }
        if let Some(sort) = &self.sort {
            for target in sort.values() {
                if target.file.is_empty()
                    || target.template.is_empty()
                    || target
                        .files
                        .as_ref()
                        .is_some_and(|files| files.values().any(String::is_empty))
                {
                    return Err(invalid(
                        "Sort file and template paths must be non-empty strings.",
                    ));
                }
            }
        }
        Ok(())
    }
}
fn read_reveal<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Reveal>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Input {
        Disabled(bool),
        Edges(Reveal),
    }
    match Input::deserialize(deserializer)? {
        Input::Disabled(false) => Ok(None),
        Input::Edges(edges) => Ok(Some(edges)),
        Input::Disabled(true) => Err(serde::de::Error::custom(
            "reveal must be false or start/end lengths",
        )),
    }
}
fn write_reveal<S: Serializer>(
    reveal: &Option<Reveal>,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    match reveal {
        None => serializer.serialize_bool(false),
        Some(reveal) => reveal.serialize(serializer),
    }
}
fn output_dir() -> String {
    ".env-lane-vault".into()
}
fn output_file() -> String {
    "store.dat".into()
}
fn enabled() -> bool {
    true
}
pub(super) fn invalid(message: impl Into<String>) -> Error {
    Error::new("VAULT_INVALID_CONFIG", message)
}
