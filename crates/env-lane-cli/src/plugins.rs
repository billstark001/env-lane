//! Manifest discovery and command routing. The main CLI does not link plugin code.
use crate::{
    arguments::{Cli, VaultOperation},
    output::Output,
};
use env_lane_core::{
    config::PluginRegistration,
    error::{Error, Result},
    paths::resolve_path,
    resolve::{Context, Environment, FileRef, PluginHooks, PluginValue},
    workspace::Package,
};
use env_lane_plugin_api::{
    Capability, CommandInvocation, CommandResult, DocumentFilterInput, DocumentFilterResult,
    FilePlanRequest, FilePlanResult, LookupValue, Manifest, PluginError, ProvidedValue,
    ValueRequest, ValueResult, new_run_id, process::Session,
};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

fn error(error: PluginError) -> Error {
    Error {
        code: error.code,
        message: error.message,
        details: error.details,
    }
}

fn invoke(manifest: &Manifest, request: CommandInvocation) -> Result<i32> {
    let mut session = Session::start(manifest).map_err(error)?;
    let result: CommandResult = session
        .call_typed("command.invoke", &request)
        .map_err(error)?;
    session.finish().map_err(error)?;
    Ok(result.exit_code)
}

fn vault_binary(executable: &Path) -> PathBuf {
    let name = if cfg!(windows) {
        "env-lane-plugin-vault.exe"
    } else {
        "env-lane-plugin-vault"
    };
    let sibling = executable.with_file_name(name);
    if sibling.is_file() {
        return sibling;
    }
    for ancestor in executable.ancestors() {
        let modules = if ancestor
            .file_name()
            .is_some_and(|name| name == "node_modules")
        {
            ancestor.to_path_buf()
        } else {
            ancestor.join("node_modules")
        };
        let installed = modules.join("@env-lane/vault/dist").join(name);
        if installed.is_file() {
            return installed;
        }
    }
    sibling
}

pub fn execute_vault(operation: &VaultOperation, cli: &Cli, _output: &Output) -> Result<i32> {
    let executable = std::env::current_exe()
        .map_err(|error| Error::new("PLUGIN_START_FAILED", error.to_string()))?;
    let binary = vault_binary(&executable);
    if !binary.is_file() {
        return Err(Error::new(
            "VAULT_NOT_INSTALLED",
            "Vault commands require the native Vault plugin executable.",
        ));
    }
    let manifest = Manifest {
        id: "vault".into(),
        executable: binary,
        capabilities: vec![
            Capability::Command {
                name: "vault".into(),
            },
            Capability::NativeApi {
                namespace: "vault".into(),
            },
        ],
    };
    invoke(
        &manifest,
        CommandInvocation {
            common: serde_json::to_value(&cli.common)
                .map_err(|error| Error::new("PLUGIN_PROTOCOL_ERROR", error.to_string()))?,
            operation: serde_json::to_value(operation)
                .map_err(|error| Error::new("PLUGIN_PROTOCOL_ERROR", error.to_string()))?,
            arguments: Vec::new(),
        },
    )
}

pub fn manifests(root: &Path, plugins: &[PluginRegistration]) -> Result<Vec<Manifest>> {
    let mut manifests = Vec::with_capacity(plugins.len());
    let mut commands = HashSet::new();
    for plugin in plugins {
        let path = resolve_path(root, &plugin.manifest);
        let bytes = fs::read(&path)
            .map_err(|error| Error::new("PLUGIN_MANIFEST_FAILED", error.to_string()))?;
        let mut manifest: Manifest = serde_json::from_slice(&bytes)
            .map_err(|error| Error::new("PLUGIN_MANIFEST_FAILED", error.to_string()))?;
        if manifest.id.is_empty()
            || manifest.capabilities.is_empty()
            || manifest.executable.as_os_str().is_empty()
        {
            return Err(Error::new(
                "PLUGIN_MANIFEST_FAILED",
                format!("Invalid plugin manifest: {}", path.display()),
            ));
        }
        manifest.executable = resolve_path(path.parent().unwrap_or(root), &manifest.executable);
        if manifests
            .iter()
            .any(|existing: &Manifest| existing.id == manifest.id)
        {
            return Err(Error::new(
                "PLUGIN_MANIFEST_FAILED",
                format!("Duplicate plugin id: {}", manifest.id),
            ));
        }
        for capability in &manifest.capabilities {
            if let Capability::Command { name } = capability
                && (name.is_empty() || !commands.insert(name.clone()) || name == "vault")
            {
                return Err(Error::new(
                    "PLUGIN_MANIFEST_FAILED",
                    format!("Duplicate or reserved plugin command: {name}"),
                ));
            }
        }
        for (required, enabled) in [
            (Capability::DocumentFilter, plugin.document_filter),
            (Capability::EnvSource, !plugin.source_keys.is_empty()),
            (Capability::EnvGenerate, !plugin.generators.is_empty()),
        ] {
            if enabled && !manifest.capabilities.contains(&required) {
                return Err(Error::new(
                    "PLUGIN_MANIFEST_FAILED",
                    format!("Plugin {} did not declare {required:?}", manifest.id),
                ));
            }
        }
        manifests.push(manifest);
    }
    Ok(manifests)
}

pub struct Runtime<'a> {
    registrations: &'a [PluginRegistration],
    manifests: Vec<Manifest>,
    sessions: Vec<Option<Session>>,
    run_id: String,
    process_env: &'a Environment,
    source_cache: HashMap<(usize, String, String, String), Option<ProvidedValue>>,
}

impl<'a> Runtime<'a> {
    pub fn needed(plugins: &[PluginRegistration]) -> bool {
        plugins.iter().any(|plugin| {
            plugin.document_filter
                || !plugin.source_keys.is_empty()
                || !plugin.generators.is_empty()
        })
    }

    pub fn new(context: &'a Context<'_>) -> Result<Self> {
        let registrations = &context.loaded.config.plugins;
        let manifests = manifests(&context.loaded.project_root, registrations)?;
        let sessions = (0..manifests.len()).map(|_| None).collect();
        Ok(Self {
            registrations,
            manifests,
            sessions,
            run_id: new_run_id()
                .map_err(|error| Error::new("PLUGIN_START_FAILED", error.to_string()))?,
            process_env: context.process_env,
            source_cache: HashMap::new(),
        })
    }

    fn call<P: serde::Serialize, R: serde::de::DeserializeOwned>(
        &mut self,
        index: usize,
        method: &str,
        params: &P,
    ) -> Result<R> {
        if self.sessions[index].is_none() {
            self.sessions[index] = Some(Session::start(&self.manifests[index]).map_err(error)?);
        }
        self.sessions[index]
            .as_mut()
            .unwrap()
            .call_typed(method, params)
            .map_err(error)
    }

    fn values(
        &mut self,
        index: usize,
        method: &str,
        target: &Package,
        build: &str,
        keys: Vec<String>,
        group: Option<String>,
    ) -> Result<Vec<ProvidedValue>> {
        let request = ValueRequest {
            run_id: self.run_id.clone(),
            target: target.relative_dir.clone(),
            build: build.into(),
            keys: keys.clone(),
            group,
            settings: self.registrations[index].settings.clone(),
        };
        let result: ValueResult = self.call(index, method, &request)?;
        let requested: HashSet<_> = keys.iter().map(String::as_str).collect();
        let mut returned = HashSet::new();
        for value in &result.values {
            if !requested.contains(value.key.as_str())
                || !returned.insert(value.key.as_str())
                || value.key.is_empty()
                || value.key.contains(['=', '\0'])
                || value.value.contains('\0')
            {
                return Err(Error::new(
                    "PLUGIN_PROTOCOL_ERROR",
                    "Plugin returned an invalid, unrequested, or duplicate environment value.",
                ));
            }
        }
        Ok(result.values)
    }

    fn source_value(
        &mut self,
        key: &str,
        target: &Package,
        build: &str,
    ) -> Result<Option<(String, ProvidedValue)>> {
        for index in 0..self.registrations.len() {
            if !self.registrations[index]
                .source_keys
                .iter()
                .any(|item| item == key)
            {
                continue;
            }
            let cache_key = (
                index,
                target.relative_dir.clone(),
                build.to_owned(),
                key.to_owned(),
            );
            if !self.source_cache.contains_key(&cache_key) {
                let value = self
                    .values(index, "env.source", target, build, vec![key.into()], None)?
                    .into_iter()
                    .next();
                self.source_cache.insert(cache_key.clone(), value);
            }
            if let Some(value) = self.source_cache[&cache_key].as_ref() {
                return Ok(Some((
                    self.manifests[index].id.clone(),
                    ProvidedValue {
                        key: value.key.clone(),
                        value: value.value.clone(),
                        sensitive: value.sensitive,
                    },
                )));
            }
        }
        Ok(None)
    }

    pub fn finish(&mut self) -> Result<()> {
        for session in &mut self.sessions {
            if let Some(session) = session.take() {
                session.finish().map_err(error)?;
            }
        }
        Ok(())
    }

    /// Produce a reviewable plan. Applying it is an explicit host operation.
    pub fn plan_files(
        &mut self,
        plugin_id: &str,
        group: String,
        files: Vec<PathBuf>,
    ) -> Result<FilePlanResult> {
        let index = self
            .manifests
            .iter()
            .position(|manifest| {
                manifest.id == plugin_id && manifest.capabilities.contains(&Capability::FilePlan)
            })
            .ok_or_else(|| {
                Error::new(
                    "PLUGIN_CAPABILITY_DENIED",
                    "Plugin does not provide file plans.",
                )
            })?;
        let request = FilePlanRequest {
            run_id: self.run_id.clone(),
            group,
            files: files.clone(),
            settings: self.registrations[index].settings.clone(),
        };
        let result: FilePlanResult = self.call(index, "file.plan", &request)?;
        let allowed: HashSet<_> = files.iter().collect();
        let mut patches = HashSet::new();
        for patch in &result.patches {
            if !allowed.contains(&patch.file)
                || !patches.insert((&patch.file, &patch.key))
                || patch.key.is_empty()
                || patch.key.contains(['=', '\0'])
                || patch.value.contains('\0')
                || patch.expected_sha256.len() != 64
                || !patch
                    .expected_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(Error::new(
                    "PLUGIN_PROTOCOL_ERROR",
                    "Plugin returned an invalid file plan.",
                ));
            }
        }
        Ok(result)
    }
}

impl PluginHooks for Runtime<'_> {
    fn filter_document(
        &mut self,
        file: &FileRef,
        mut content: String,
        target: &Package,
        build: &str,
        existing: &Environment,
    ) -> Result<String> {
        for index in 0..self.registrations.len() {
            if !self.registrations[index].document_filter {
                continue;
            }
            let keys = self.registrations[index].filter_lookup.clone();
            let mut lookup = Vec::with_capacity(keys.len());
            for key in keys {
                let present = existing.contains_key(&key)
                    || self.process_env.contains_key(&key)
                    || self.source_value(&key, target, build)?.is_some();
                lookup.push(LookupValue { key, present });
            }
            let request = DocumentFilterInput {
                run_id: self.run_id.clone(),
                file_id: file.relative_path.clone(),
                target: target.relative_dir.clone(),
                build: build.into(),
                content,
                lookup,
                settings: self.registrations[index].settings.clone(),
            };
            let result: DocumentFilterResult = self.call(index, "document.filter", &request)?;
            content = mask_lines(&request.content, &result)?;
        }
        Ok(content)
    }

    fn provide_values(
        &mut self,
        target: &Package,
        build: &str,
        existing: &Environment,
        include_process_env: bool,
    ) -> Result<Vec<PluginValue>> {
        let mut provided = Vec::new();
        for index in 0..self.registrations.len() {
            let keys = self.registrations[index].source_keys.clone();
            for key in keys {
                if (!self.registrations[index].replace_file_values && existing.contains_key(&key))
                    || (include_process_env && self.process_env.contains_key(&key))
                {
                    continue;
                }
                if let Some((id, value)) = self.source_value(&key, target, build)? {
                    provided.push(PluginValue {
                        id,
                        key: value.key,
                        value: value.value,
                        sensitive: value.sensitive,
                        replace_file: self.registrations[index].replace_file_values,
                    });
                }
            }
            let groups = self.registrations[index].generators.clone();
            for group in groups {
                if group.keys.iter().all(|key| {
                    (!self.registrations[index].replace_file_values && existing.contains_key(key))
                        || (include_process_env && self.process_env.contains_key(key))
                }) {
                    continue;
                }
                let values = self.values(
                    index,
                    "env.generate",
                    target,
                    build,
                    group.keys,
                    Some(group.group),
                )?;
                for value in values {
                    provided.push(PluginValue {
                        id: self.manifests[index].id.clone(),
                        key: value.key,
                        value: value.value,
                        sensitive: value.sensitive,
                        replace_file: self.registrations[index].replace_file_values,
                    });
                }
            }
        }
        Ok(provided)
    }
}

fn mask_lines(content: &str, result: &DocumentFilterResult) -> Result<String> {
    let lines: Vec<_> = content.split_inclusive('\n').collect();
    let count = lines.len();
    let mut disabled = vec![false; count];
    for range in &result.disabled_lines {
        if range.start == 0 || range.end < range.start || range.end > count {
            return Err(Error::new(
                "PLUGIN_PROTOCOL_ERROR",
                "Plugin returned an invalid line range.",
            ));
        }
        disabled[range.start - 1..range.end].fill(true);
    }
    let mut result = String::with_capacity(content.len());
    for (index, line) in lines.iter().enumerate() {
        if disabled[index] {
            for ch in line.chars() {
                result.push(if matches!(ch, '\r' | '\n') { ch } else { ' ' });
            }
        } else {
            result.push_str(line);
        }
    }
    Ok(result)
}

pub fn execute_command(
    arguments: &[OsString],
    cli: &Cli,
    context: &Context<'_>,
    _output: &Output,
) -> Result<i32> {
    let name = arguments
        .first()
        .and_then(|arg| arg.to_str())
        .ok_or_else(|| {
            Error::new(
                "PLUGIN_INVALID_COMMAND",
                "Plugin command name must be UTF-8.",
            )
        })?;
    let registered = manifests(&context.loaded.project_root, &context.loaded.config.plugins)?;
    let manifest = registered
        .iter()
        .find(|manifest| {
            manifest.capabilities.iter().any(|capability| {
        matches!(capability, Capability::Command { name: command } if command == name)
    })
        })
        .ok_or_else(|| {
            Error::new(
                "CLI_ARGUMENT_ERROR",
                format!("error: unknown command '{name}'"),
            )
        })?;
    let arguments = arguments
        .iter()
        .map(|arg| {
            arg.to_str().map(str::to_owned).ok_or_else(|| {
                Error::new("PLUGIN_INVALID_COMMAND", "Plugin arguments must be UTF-8.")
            })
        })
        .collect::<Result<Vec<_>>>()?;
    invoke(
        manifest,
        CommandInvocation {
            common: serde_json::to_value(&cli.common)
                .map_err(|error| Error::new("PLUGIN_PROTOCOL_ERROR", error.to_string()))?,
            operation: serde_json::Value::Null,
            arguments,
        },
    )
}
