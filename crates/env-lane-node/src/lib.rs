//! Node-API transport. Vault behavior is supplied by an optional native plugin.
use env_lane_core::{
    check,
    config::{self, LoadedConfig},
    document::{self, Patch, PatchOptions, TextDocument},
    error::{Error, Result},
    paths::resolve_path,
    policy,
    resolve::{Context, Environment, Options},
    sort, workspace,
};
use env_lane_plugin_api::{Capability, Manifest, PluginError, process::Session};
use napi_derive::napi;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn required<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new("INVALID_NATIVE_REQUEST", format!("Missing {field}.")))
}
fn optional<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}
fn path(value: &Value, field: &str, base: &Path) -> Option<PathBuf> {
    optional(value, field).map(|value| resolve_path(base, Path::new(value)))
}
fn load_core(value: &Value) -> Result<LoadedConfig> {
    let cwd = PathBuf::from(required(value, "cwd")?);
    let Some(config) = value.get("config") else {
        return config::load(&cwd, path(value, "configFile", &cwd).as_deref());
    };
    let root = PathBuf::from(required(config, "rootDir")?);
    // A resolved JS config already contains defaults and has passed the public
    // c12/Zod validation. The raw-config validator rejects empty defaults that
    // are legal in this resolved form (for example defaultTarget: "").
    let parsed: config::Config = serde_json::from_value(config.clone())
        .map_err(|error| Error::new("CONFIG_LOAD_FAILED", error.to_string()))?;
    let config_file = path(value, "configFile", &cwd);
    let config_dir = config_file
        .as_ref()
        .and_then(|file| file.parent())
        .unwrap_or(&root)
        .to_path_buf();
    Ok(LoadedConfig {
        config: parsed,
        invocation_cwd: cwd,
        project_root: root,
        config_file,
        config_dir,
    })
}
fn core_document(operation: &str, value: &Value) -> Result<Value> {
    match operation {
        "core.envDocument.create" => Ok(json!(TextDocument::parse(required(value, "content")?))),
        "core.envDocument.parseLine" => {
            Ok(json!(document::parse_line(required(value, "line")?, 1)))
        }
        "core.envDocument.parse" => {
            let parsed = document::Document::parse(required(value, "content")?);
            Ok(json!({
                "document": parsed.document,
                "parsedLines": parsed.parsed_lines,
                "currentEntries": parsed.current_map.into_iter().collect::<Vec<_>>(),
                "occurrenceEntries": parsed.occurrences_map.into_iter().collect::<Vec<_>>(),
                "invalidLineCount": parsed.invalid_line_count,
                "shadowedEntryCount": parsed.shadowed_entry_count,
            }))
        }
        "core.envDocument.render" => {
            let text: TextDocument = serde_json::from_value(
                value
                    .get("document")
                    .cloned()
                    .ok_or_else(|| Error::new("INVALID_NATIVE_REQUEST", "Missing document."))?,
            )
            .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))?;
            let lines: Vec<String> = serde_json::from_value(
                value
                    .get("lines")
                    .cloned()
                    .ok_or_else(|| Error::new("INVALID_NATIVE_REQUEST", "Missing lines."))?,
            )
            .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))?;
            let eol = value
                .get("eol")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))?
                .unwrap_or_default();
            Ok(json!(
                text.render(
                    &lines,
                    value
                        .get("preserveBOM")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    eol,
                )
            ))
        }
        "core.envDocument.formatValue" => {
            Ok(json!(document::format_value(required(value, "value")?)?))
        }
        "core.envDocument.patch" => {
            let patches: Vec<Patch> = serde_json::from_value(
                value
                    .get("patches")
                    .cloned()
                    .ok_or_else(|| Error::new("INVALID_NATIVE_REQUEST", "Missing patches."))?,
            )
            .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))?;
            let options: PatchOptions =
                serde_json::from_value(value.get("options").cloned().unwrap_or_else(|| json!({})))
                    .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))?;
            Ok(json!(document::patch(
                required(value, "content")?,
                &patches,
                &options,
            )?))
        }
        _ => Err(Error::new(
            "INVALID_NATIVE_OPERATION",
            format!("Unknown operation: {operation}"),
        )),
    }
}
fn core(operation: &str, value: &Value) -> Result<Value> {
    if operation.starts_with("core.envDocument.") {
        return Ok(json!({"value":core_document(operation, value)?,"diagnostics":[]}));
    }
    if operation == "core.sortEnvFile" {
        let cwd = PathBuf::from(required(value, "cwd")?);
        let file = resolve_path(&cwd, Path::new(required(value, "file")?));
        let template = resolve_path(&cwd, Path::new(required(value, "template")?));
        let options: sort::SortOptions =
            serde_json::from_value(value.get("options").cloned().unwrap_or_else(|| json!({})))
                .map_err(|error| Error::new("INVALID_SORT_OPTIONS", error.to_string()))?;
        return Ok(json!({"value":sort::sort_file(&file, &template, &options)?,"diagnostics":[]}));
    }
    let loaded = load_core(value)?;
    if operation == "core.listEnvFilesForTarget" {
        let target: workspace::Package = serde_json::from_value(
            value
                .get("targetPackage")
                .cloned()
                .ok_or_else(|| Error::new("INVALID_NATIVE_REQUEST", "Missing targetPackage."))?,
        )
        .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))?;
        let environment: Environment = value
            .get("processEnv")
            .cloned()
            .map(|value| serde_json::from_value(value).unwrap_or_default())
            .unwrap_or_default();
        let mut diagnostics = Vec::new();
        let build = match optional(value, "resolvedBuild") {
            Some(build) => build.to_owned(),
            None => env_lane_core::resolve::select_build(
                optional(value, "build"),
                &loaded.config.selector,
                &environment,
                &mut diagnostics,
            )?,
        };
        let context = Context {
            loaded: &loaded,
            packages: &[],
            process_env: &environment,
        };
        return Ok(json!({
            "value":context.files_for_target(
                &target,
                &build,
                value.get("requireOverride").and_then(Value::as_bool)
            ),
            "diagnostics":diagnostics
        }));
    }
    let packages: Vec<workspace::Package> = match value.get("packages") {
        Some(packages) => serde_json::from_value(packages.clone())
            .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))?,
        None => workspace::list_packages(&loaded)?,
    };
    let environment: Environment = value
        .get("processEnv")
        .cloned()
        .map(|value| serde_json::from_value(value).unwrap_or_default())
        .unwrap_or_default();
    let context = Context {
        loaded: &loaded,
        packages: &packages,
        process_env: &environment,
    };
    let mut diagnostics = Vec::new();
    let options = Options {
        target: optional(value, "target"),
        build: optional(value, "build"),
        include_process_env: value.get("includeProcessEnv").and_then(Value::as_bool),
        require_override: value.get("requireOverride").and_then(Value::as_bool),
    };
    let result = match operation {
        "core.listWorkspacePackages" => json!(packages),
        "core.resolveTargetPackage" => json!(workspace::resolve_target(
            &packages,
            options.target,
            &loaded.config.workspace.default_target,
            value
                .get("inferFromCwd")
                .and_then(Value::as_bool)
                .unwrap_or(true)
                .then_some(loaded.invocation_cwd.as_path())
        )?),
        "core.listEnvFiles" => json!(context.files(&options, &mut diagnostics)?),
        "core.resolveInjectedEnv" => json!(context.resolve(&options, &mut diagnostics)?),
        "core.checkDotenvSelector" => json!(check::check_selector(
            &context,
            &check::CheckOptions {
                target: options.target,
                build: options.build,
                require_override: options.require_override,
            },
            &mut diagnostics
        )?),
        "core.runEnvCheck" => json!(policy::run_check(
            &context,
            required(value, "name")?,
            options.build,
            &mut diagnostics
        )?),
        "core.runEnvSync" => json!(policy::run_sync(
            &context,
            required(value, "name")?,
            &policy::SyncOptions {
                build: options.build,
                dry_run: value
                    .get("dryRun")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            },
            &mut diagnostics
        )?),
        "core.sortEnvFilesFromConfig" => json!(sort::sort_configured(
            &loaded,
            &packages,
            optional(value, "key"),
            optional(value, "envSuffix"),
            &sort::ConfiguredOptions {
                create: value.get("create").and_then(Value::as_bool),
                check: value.get("check").and_then(Value::as_bool).unwrap_or(false),
                preserve_bom: value.get("preserveBOM").and_then(Value::as_bool),
                eol: value
                    .get("eol")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| Error::new("INVALID_SORT_OPTIONS", error.to_string()))?,
            }
        )?),
        _ => {
            return Err(Error::new(
                "INVALID_NATIVE_OPERATION",
                format!("Unknown operation: {operation}"),
            ));
        }
    };
    Ok(json!({"value":result,"diagnostics":diagnostics}))
}
fn plugin_error(error: PluginError) -> Error {
    Error {
        code: error.code,
        message: error.message,
        details: error.details,
    }
}

fn vault(operation: &str, value: &Value) -> Result<Value> {
    let executable = PathBuf::from(required(value, "pluginExecutable")?);
    let manifest = Manifest {
        id: "vault".into(),
        executable,
        capabilities: vec![
            Capability::Command {
                name: "vault".into(),
            },
            Capability::NativeApi {
                namespace: "vault".into(),
            },
        ],
    };
    let mut session = Session::start(&manifest).map_err(plugin_error)?;
    let result: Value = session
        .call_typed(
            "native.invoke",
            &json!({"operation":operation,"request":value}),
        )
        .map_err(plugin_error)?;
    session.finish().map_err(plugin_error)?;
    Ok(result)
}

/// A transport envelope carries stable error codes and data without forcing
/// application objects through duplicate Node-API schemas.
#[napi]
pub fn invoke(operation: String, request: String) -> String {
    let result = serde_json::from_str::<Value>(&request)
        .map_err(|error| Error::new("INVALID_NATIVE_REQUEST", error.to_string()))
        .and_then(|value| {
            if operation.starts_with("core.") {
                core(&operation, &value)
            } else {
                vault(&operation, &value)
            }
        });
    match result {
        Ok(value) => json!({"ok":true,"result":value}).to_string(),
        Err(error) => json!({"ok":false,"error":error}).to_string(),
    }
}
