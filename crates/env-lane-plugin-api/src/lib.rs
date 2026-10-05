//! Versioned plugin messages. The domain model is independent of the wire codec.
pub mod codec;
pub mod process;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

pub const PROTOCOL_VERSION: u32 = 1;

pub fn new_run_id() -> std::io::Result<String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub executable: PathBuf,
    pub capabilities: Vec<Capability>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Capability {
    Command { name: String },
    NativeApi { namespace: String },
    DocumentFilter,
    EnvSource,
    EnvGenerate,
    FilePlan,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub token: String,
    pub protocol: u32,
    pub plugin_id: String,
    pub capabilities: Vec<Capability>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Request {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Response {
    pub jsonrpc: String,
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<PluginError>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PluginError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandInvocation {
    pub common: Value,
    pub operation: Value,
    #[serde(default)]
    pub arguments: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub exit_code: i32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFilterInput {
    pub run_id: String,
    pub file_id: String,
    pub target: String,
    pub build: String,
    pub content: String,
    pub lookup: Vec<LookupValue>,
    pub settings: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupValue {
    pub key: String,
    pub present: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFilterResult {
    pub disabled_lines: Vec<LineRange>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueRequest {
    pub run_id: String,
    pub target: String,
    pub build: String,
    pub keys: Vec<String>,
    pub group: Option<String>,
    pub settings: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidedValue {
    pub key: String,
    pub value: String,
    pub sensitive: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueResult {
    pub values: Vec<ProvidedValue>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePlanRequest {
    pub run_id: String,
    pub group: String,
    pub files: Vec<PathBuf>,
    pub settings: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedPatch {
    pub file: PathBuf,
    pub expected_sha256: String,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePlanResult {
    pub patches: Vec<PlannedPatch>,
}

pub trait Handler {
    fn invoke(
        &mut self,
        method: &str,
        params: &serde_json::value::RawValue,
    ) -> Result<Value, PluginError>;
}
