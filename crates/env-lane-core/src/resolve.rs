//! Build selection and dotenv merging. Environment input is explicit so repeated
//! API calls cannot observe a stale process snapshot hidden in global state.
use crate::{
    config::{LoadedConfig, Selector, Validation},
    document::Document,
    error::{Diagnostic, Error, Result, Severity},
    paths::{relative_path, resolve_path},
    workspace::{Package, resolve_target},
};
use indexmap::IndexMap;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub type Environment = IndexMap<String, String>;

#[derive(Debug, Default)]
pub struct Options<'a> {
    pub target: Option<&'a str>,
    pub build: Option<&'a str>,
    pub include_process_env: Option<bool>,
    pub require_override: Option<bool>,
}

/// A caller can share discovery across related operations while supplying a
/// fresh environment on each invocation. This context has no process-global state.
pub struct Context<'a> {
    pub loaded: &'a LoadedConfig,
    pub packages: &'a [Package],
    pub process_env: &'a Environment,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub kind: FileKind,
    pub path: PathBuf,
    pub relative_path: String,
    pub exists: bool,
    pub required: bool,
    pub order: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Base,
    Override,
    Custom,
}

#[derive(Debug, Serialize)]
#[serde(tag = "source", rename_all = "lowercase")]
pub enum ValueOrigin {
    Dotenv {
        file: PathBuf,
        #[serde(rename = "relativeFile")]
        relative_file: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        line: Option<usize>,
    },
    Process {
        #[serde(rename = "shellOverride", skip_serializing_if = "Option::is_none")]
        shell_override: Option<bool>,
    },
    Selector {
        #[serde(rename = "shellOverride")]
        shell_override: bool,
    },
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedEnvironment {
    pub root_dir: PathBuf,
    pub target: Package,
    pub build: String,
    pub selector_key: String,
    pub files: Vec<FileRef>,
    pub values: Environment,
    pub sources: IndexMap<String, ValueOrigin>,
}

pub fn select_build(
    requested: Option<&str>,
    selector: &Selector,
    process_env: &Environment,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<String> {
    let build = crate::text::trim(
        requested
            .or_else(|| process_env.get(&selector.env_key).map(String::as_str))
            .unwrap_or(&selector.default_build),
    );
    if build.is_empty() {
        return Err(Error::new("INVALID_BUILD", "Build name is empty."));
    }
    let mut bytes = build.bytes();
    let valid_start = bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric());
    if !valid_start
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    {
        return Err(Error::new(
            "INVALID_BUILD",
            format!("Invalid build name '{build}'."),
        ));
    }
    if !selector.builds.is_empty()
        && !selector.builds.iter().any(|allowed| allowed == build)
        && !matches!(selector.build_validation, Validation::Off)
    {
        let message = format!(
            "Build '{build}' is not listed in selector.builds: {}.",
            selector.builds.join(", ")
        );
        if matches!(selector.build_validation, Validation::Error) {
            return Err(Error::new("UNLISTED_BUILD", message));
        }
        diagnostics.push(Diagnostic {
            code: "UNLISTED_BUILD".into(),
            severity: Severity::Warn,
            message,
            details: Some(serde_json::json!({"build":build,"allowedBuilds":selector.builds})),
        });
    }
    Ok(build.to_owned())
}

impl Context<'_> {
    pub fn files(
        &self,
        options: &Options<'_>,
        diagnostics: &mut Vec<Diagnostic>,
    ) -> Result<Vec<FileRef>> {
        let target = self.target(options.target)?;
        let build = select_build(
            options.build,
            &self.loaded.config.selector,
            self.process_env,
            diagnostics,
        )?;
        Ok(self.files_for_target(target, &build, options.require_override))
    }

    pub fn resolve(
        &self,
        options: &Options<'_>,
        diagnostics: &mut Vec<Diagnostic>,
    ) -> Result<ResolvedEnvironment> {
        let target = self.target(options.target)?;
        let config = &self.loaded.config;
        let build = select_build(
            options.build,
            &config.selector,
            self.process_env,
            diagnostics,
        )?;
        let files = self.files_for_target(target, &build, options.require_override);
        require_files(&files)?;
        let mut values = Environment::new();
        let mut sources = IndexMap::new();
        for file in files.iter().filter(|file| file.exists) {
            merge_dotenv(file, &config.selector, &mut values, &mut sources)?;
        }
        if options
            .include_process_env
            .unwrap_or(config.dotenv.include_process_env)
        {
            for (key, value) in self.process_env {
                let shell_override = values.contains_key(key).then_some(true);
                values.insert(key.clone(), value.clone());
                sources.insert(key.clone(), ValueOrigin::Process { shell_override });
            }
        }
        values.insert(config.selector.env_key.clone(), build.clone());
        sources.insert(
            config.selector.env_key.clone(),
            ValueOrigin::Selector {
                shell_override: self.process_env.contains_key(&config.selector.env_key),
            },
        );
        Ok(ResolvedEnvironment {
            root_dir: self.loaded.project_root.clone(),
            target: target.clone(),
            build,
            selector_key: config.selector.env_key.clone(),
            files,
            values,
            sources,
        })
    }

    fn target(&self, requested: Option<&str>) -> Result<&Package> {
        resolve_target(
            self.packages,
            requested,
            &self.loaded.config.workspace.default_target,
            Some(&self.loaded.invocation_cwd),
        )
    }

    /// Keep repeated paths: localOverrideFile may intentionally point to .env,
    /// making the same file appear twice with different order/kind metadata.
    pub fn files_for_target(
        &self,
        target: &Package,
        build: &str,
        require_override: Option<bool>,
    ) -> Vec<FileRef> {
        let settings = &self.loaded.config.dotenv;
        settings
            .order
            .iter()
            .enumerate()
            .map(|(order, pattern)| {
                let filename = if pattern.contains("{build}") && build == settings.local_build_name
                {
                    settings.local_override_file.clone()
                } else {
                    pattern.replace("{build}", build)
                };
                let path = resolve_path(&target.dir, Path::new(&filename));
                FileRef {
                    kind: match order {
                        0 => FileKind::Base,
                        1 => FileKind::Override,
                        _ => FileKind::Custom,
                    },
                    relative_path: relative_path(&self.loaded.project_root, &path),
                    exists: path.exists(),
                    path,
                    order,
                    required: order > 0 && require_override.unwrap_or(settings.require_override),
                }
            })
            .collect()
    }
}

fn require_files(files: &[FileRef]) -> Result<()> {
    let missing = files
        .iter()
        .filter(|file| file.required && !file.exists)
        .map(|file| file.relative_path.as_str())
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }
    Err(Error::new(
        "MISSING_REQUIRED_ENV_FILE",
        format!("Missing required env file(s): {}", missing.join(", ")),
    ))
}

fn merge_dotenv(
    file: &FileRef,
    selector: &Selector,
    values: &mut Environment,
    sources: &mut IndexMap<String, ValueOrigin>,
) -> Result<()> {
    let bytes = fs::read(&file.path)
        .map_err(|error| Error::new("ENV_FILE_READ_FAILED", error.to_string()))?;
    // Node's UTF-8 reader replaces malformed sequences; that is part of the
    // persisted document contract, so native consumers use the same decoding.
    let document = Document::parse(&String::from_utf8_lossy(&bytes));
    if selector.forbid_in_dotenv && document.current_map.contains_key(&selector.env_key) {
        return Err(Error::new(
            "SELECTOR_IN_DOTENV",
            format!(
                "{} is a selector and must not be stored in dotenv files ({}).",
                selector.env_key, file.relative_path
            ),
        ));
    }
    for (key, entry) in document.current_map {
        values.insert(key.clone(), entry.effective_value);
        sources.insert(
            key,
            ValueOrigin::Dotenv {
                file: file.path.clone(),
                relative_file: file.relative_path.clone(),
                line: entry.line_number,
            },
        );
    }
    Ok(())
}
