//! JSON/YAML data model and defaults; no discovery, I/O, or runtime execution.
use crate::document::Eol;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// Serde's Option normally accepts explicit null. These configuration fields allow
// omission only; deserializing T first keeps JSON and YAML validation consistent.
fn deserialize_optional<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub selector: Selector,
    pub workspace: Workspace,
    pub dotenv: Dotenv,
    pub vault: Vault,
    pub output: Output,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub sort: Option<IndexMap<String, SortTarget>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub checks: Option<IndexMap<String, Check>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub sync: Option<IndexMap<String, Sync>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Selector {
    pub env_key: String,
    pub default_build: String,
    pub builds: Vec<String>,
    pub build_validation: Validation,
    pub forbid_in_dotenv: bool,
}
impl Default for Selector {
    fn default() -> Self {
        Self {
            env_key: "ENV_BUILD".into(),
            default_build: "local".into(),
            builds: vec![],
            build_validation: Validation::Warn,
            forbid_in_dotenv: true,
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Validation {
    Off,
    Warn,
    Error,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Workspace {
    pub package_globs: Vec<String>,
    pub aliases: IndexMap<String, String>,
    pub default_target: String,
    pub include_root: bool,
}
impl Default for Workspace {
    fn default() -> Self {
        Self {
            package_globs: vec![],
            aliases: IndexMap::new(),
            default_target: String::new(),
            include_root: true,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Dotenv {
    pub order: Vec<String>,
    pub local_build_name: String,
    pub local_override_file: String,
    pub require_override: bool,
    pub include_process_env: bool,
    #[serde(rename = "preserveBOM")]
    pub preserve_bom: bool,
    pub eol: Eol,
}
impl Default for Dotenv {
    fn default() -> Self {
        Self {
            order: vec![".env".into(), ".env.{build}".into()],
            local_build_name: "local".into(),
            local_override_file: ".env.local".into(),
            require_override: false,
            include_process_env: true,
            preserve_bom: true,
            eol: Eol::Auto,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Vault {
    pub enabled: bool,
    pub disable_unsafe_warning: bool,
    pub config_file: String,
}
impl Default for Vault {
    fn default() -> Self {
        Self {
            enabled: false,
            disable_unsafe_warning: false,
            config_file: "env-lane.vault".into(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Output {
    pub format: OutputFormat,
    pub prefix: bool,
}
impl Default for Output {
    fn default() -> Self {
        Self {
            format: OutputFormat::Text,
            prefix: true,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Text,
    Json,
    Dotenv,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortTarget {
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub base_dir: Option<PathBuf>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub file: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub template: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub files: Option<IndexMap<String, String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub create: Option<bool>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub unlisted_variables_comment: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueSource {
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub target: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub file: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub include_process_env: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueTarget {
    #[serde(flatten)]
    pub source: ValueSource,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub variant: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Check {
    pub sources: IndexMap<String, ValueSource>,
    pub rules: Vec<Rule>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyRef {
    pub source: String,
    pub key: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Rule {
    #[serde(rename = "required")]
    Required {
        source: String,
        key: String,
        #[serde(flatten)]
        options: RuleOptions,
    },
    #[serde(rename = "requiredAny")]
    RequiredAny {
        source: String,
        keys: Vec<String>,
        #[serde(flatten)]
        options: RuleOptions,
    },
    #[serde(rename = "equals")]
    Equals {
        left: KeyRef,
        right: KeyRef,
        #[serde(
            default,
            deserialize_with = "deserialize_optional",
            skip_serializing_if = "Option::is_none"
        )]
        transform: Option<Transform>,
        #[serde(flatten)]
        options: RuleOptions,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleOptions {
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub label: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub severity: Option<Severity>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warn,
    Error,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Transform {
    Trim,
    Lowercase,
    Uppercase,
    UrlBase,
    UrlBaseSlash,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sync {
    pub from: ValueSource,
    pub to: ValueTarget,
    pub mappings: Vec<Mapping>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mapping {
    pub from: String,
    pub to: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub transform: Option<Transform>,
}
