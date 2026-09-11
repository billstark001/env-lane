//! Selector auditing is separate from environment resolution: it scans every env
//! document under the selected scope, including variants not currently injected.
use crate::{
    error::{Diagnostic, Error, Result},
    paths::relative_path,
    resolve::{Context, select_build},
    storage::load_document,
    workspace::resolve_target,
};
use serde::Serialize;
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Default)]
pub struct CheckOptions<'a> {
    pub target: Option<&'a str>,
    pub build: Option<&'a str>,
    pub require_override: Option<bool>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Violation {
    pub file: PathBuf,
    pub relative_file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingFile {
    pub file: PathBuf,
    pub relative_file: String,
    pub target: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub ok: bool,
    pub selector_key: String,
    pub violations: Vec<Violation>,
    pub missing_required: Vec<MissingFile>,
}

pub fn check_selector(
    context: &Context<'_>,
    options: &CheckOptions<'_>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<CheckResult> {
    let config = &context.loaded.config;
    let selected = options
        .target
        .filter(|target| !target.is_empty() && *target != "all")
        .map(|target| {
            resolve_target(
                context.packages,
                Some(target),
                &config.workspace.default_target,
                Some(&context.loaded.invocation_cwd),
            )
        })
        .transpose()?;
    let scan_root = selected
        .map(|package| package.dir.as_path())
        .unwrap_or(&context.loaded.project_root);
    let mut violations = Vec::new();
    for file in env_documents(scan_root)? {
        let document = load_document(&file)?;
        if let Some(entry) = document.parsed.current_map.get(&config.selector.env_key) {
            violations.push(Violation {
                relative_file: relative_path(&context.loaded.project_root, &file),
                file,
                line: entry.line_number,
            });
        }
    }
    let mut missing_required = Vec::new();
    if options
        .require_override
        .unwrap_or(config.dotenv.require_override)
    {
        let targets = selected
            .map(|package| vec![package])
            .unwrap_or_else(|| context.packages.iter().collect());
        for package in targets {
            let build = select_build(
                options.build,
                &config.selector,
                context.process_env,
                diagnostics,
            )?;
            for file in context.files_for_target(package, &build, Some(true)) {
                if file.required && !file.exists {
                    missing_required.push(MissingFile {
                        file: file.path,
                        relative_file: file.relative_path,
                        target: package
                            .name
                            .clone()
                            .unwrap_or_else(|| package.relative_dir.clone()),
                    });
                }
            }
        }
    }
    Ok(CheckResult {
        ok: violations.is_empty() && missing_required.is_empty(),
        selector_key: config.selector.env_key.clone(),
        violations,
        missing_required,
    })
}

/// These are the fixed check patterns (**/.env, **/.env.*, **/*.env,
/// **/*.env.*), not arbitrary user globs. Hidden directories stay excluded while
/// the explicitly named .env files are included.
fn is_env_filename(name: &str) -> bool {
    if name.starts_with('.') {
        return name == ".env" || name.starts_with(".env.");
    }
    name.ends_with(".env") || name.contains(".env.")
}

fn env_documents(root: &Path) -> Result<Vec<PathBuf>> {
    let mut pending = VecDeque::from([(root.to_owned(), Vec::<PathBuf>::new())]);
    let mut files = Vec::new();
    while let Some((directory, mut ancestors)) = pending.pop_front() {
        let canonical = fs::canonicalize(&directory).map_err(scan_error)?;
        if ancestors.contains(&canonical) {
            continue;
        }
        ancestors.push(canonical);
        let mut entries = fs::read_dir(&directory)
            .map_err(scan_error)?
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(scan_error)?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if path.is_dir() {
                if !name.starts_with('.')
                    && !matches!(name.as_ref(), "node_modules" | "dist" | "coverage" | "tmp")
                {
                    pending.push_back((path, ancestors.clone()));
                }
            } else if path.is_file() && is_env_filename(&name) {
                files.push(path);
            }
        }
    }
    Ok(files)
}
fn scan_error(error: std::io::Error) -> Error {
    Error::new("ENV_LANE_ERROR", error.to_string())
}
