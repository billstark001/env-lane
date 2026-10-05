//! Optional Vault command provider. Terminal streams are inherited; control is RPC.
mod native;
mod vault;
mod vault_prompt;

use env_lane_cli::{
    arguments::{Common, VaultOperation},
    output::Output,
};
use env_lane_core::{
    config::{self, OutputFormat},
    error::{Error, Result},
    paths::resolve_path,
    resolve::{Context, Environment},
};
use env_lane_plugin_api::{
    Capability, CommandInvocation, CommandResult, Handler, Manifest, PluginError, process,
};
use serde_json::Value;

struct VaultHandler;

fn invoke_command(request: CommandInvocation) -> Result<i32> {
    let common: Common = serde_json::from_value(request.common)
        .map_err(|error| Error::new("PLUGIN_INVALID_REQUEST", error.to_string()))?;
    let operation: VaultOperation = serde_json::from_value(request.operation)
        .map_err(|error| Error::new("PLUGIN_INVALID_REQUEST", error.to_string()))?;
    let current = std::env::current_dir()
        .map_err(|error| Error::new("CWD_READ_FAILED", error.to_string()))?;
    let cwd = common
        .cwd
        .as_ref()
        .map_or(current.clone(), |cwd| resolve_path(&current, cwd));
    let loaded = config::load(&cwd, common.config.as_deref())?;
    let format = if common.json {
        OutputFormat::Json
    } else {
        match common.format.as_deref() {
            None => loaded.config.output.format.clone(),
            Some("text") => OutputFormat::Text,
            Some("json") => OutputFormat::Json,
            Some("dotenv") => OutputFormat::Dotenv,
            Some(_) => {
                return Err(Error::new(
                    "INVALID_OUTPUT_FORMAT",
                    "--format must be one of: text, json, dotenv",
                ));
            }
        }
    };
    let output = Output {
        format,
        prefix: !common.no_prefix && loaded.config.output.prefix,
    };
    let packages = [];
    let environment = Environment::new();
    let context = Context {
        loaded: &loaded,
        packages: &packages,
        process_env: &environment,
    };
    vault::execute(&operation, &common, &context, &output)
}

impl Handler for VaultHandler {
    fn invoke(
        &mut self,
        method: &str,
        params: &serde_json::value::RawValue,
    ) -> std::result::Result<Value, PluginError> {
        let result = match method {
            "command.invoke" => {
                let request: CommandInvocation =
                    serde_json::from_str(params.get()).map_err(|error| PluginError {
                        code: "PLUGIN_INVALID_REQUEST".into(),
                        message: error.to_string(),
                        details: None,
                    })?;
                invoke_command(request).and_then(|exit_code| {
                    serde_json::to_value(CommandResult { exit_code })
                        .map_err(|error| Error::new("PLUGIN_PROTOCOL_ERROR", error.to_string()))
                })
            }
            "native.invoke" => {
                let request: native::Invocation =
                    serde_json::from_str(params.get()).map_err(|error| PluginError {
                        code: "PLUGIN_INVALID_REQUEST".into(),
                        message: error.to_string(),
                        details: None,
                    })?;
                native::invoke(&request.operation, &request.request)
            }
            _ => {
                return Err(PluginError {
                    code: "PLUGIN_METHOD_NOT_FOUND".into(),
                    message: method.into(),
                    details: None,
                });
            }
        };
        result.map_err(|error| PluginError {
            code: error.code,
            message: error.message,
            details: error.details,
        })
    }
}

fn main() {
    let manifest = Manifest {
        id: "vault".into(),
        executable: std::env::current_exe().unwrap_or_default(),
        capabilities: vec![
            Capability::Command {
                name: "vault".into(),
            },
            Capability::NativeApi {
                namespace: "vault".into(),
            },
        ],
    };
    if let Err(error) = process::serve(&manifest, &mut VaultHandler) {
        eprintln!("[env-lane-plugin-vault] {}: {}", error.code, error.message);
        std::process::exit(1);
    }
}
