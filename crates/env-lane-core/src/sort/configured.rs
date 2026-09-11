//! Expand configured targets into ordered file jobs, then deduplicate by absolute
//! destination. Package aliases must not cause the same file to be sorted twice.
use super::{SortOptions, SortResult, sort_file};
use crate::{
    config::{LoadedConfig, SortTarget},
    document::Eol,
    error::{Error, Result},
    paths::resolve_path,
    text::trim,
    variants::normalize_variant,
    workspace::Package,
};
use indexmap::IndexMap;
use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

#[derive(Default)]
pub struct ConfiguredOptions {
    pub create: Option<bool>,
    pub check: bool,
    pub preserve_bom: Option<bool>,
    pub eol: Option<Eol>,
}
#[derive(Debug, Serialize)]
pub struct ConfiguredResult {
    pub applied: bool,
    pub changed: bool,
    pub count: usize,
    pub results: Vec<SortResult>,
}

pub fn sort_configured(
    loaded: &LoadedConfig,
    packages: &[Package],
    key: Option<&str>,
    variant: Option<&str>,
    options: &ConfiguredOptions,
) -> Result<ConfiguredResult> {
    let key = key.map(trim).filter(|key| !key.is_empty()).unwrap_or("all");
    let variant = normalize_variant(variant, "all", true, "env-suffix")?;
    let targets = resolved_targets(loaded, packages);
    let selected = targets
        .iter()
        .filter(|(name, _)| key == "all" || name.as_str() == key)
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Err(Error::new(
            "SORT_UNKNOWN_KEY",
            format!("Unknown sort key: {key}"),
        ));
    }
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    for (name, target) in selected {
        let base = target
            .base_dir
            .as_ref()
            .expect("resolved target has baseDir");
        let template = resolve_path(
            base,
            Path::new(target.template.as_deref().unwrap_or(".env.example")),
        );
        for file in target_files(loaded, name, target, &variant)? {
            if !seen.insert(file.clone()) {
                continue;
            }
            results.push(sort_file(
                &file,
                &template,
                &SortOptions {
                    create: options.create.or(target.create).unwrap_or(true),
                    check: options.check,
                    preserve_bom: options
                        .preserve_bom
                        .unwrap_or(loaded.config.dotenv.preserve_bom),
                    eol: options.eol.unwrap_or(loaded.config.dotenv.eol),
                    unlisted_variables_comment: target
                        .unlisted_variables_comment
                        .clone()
                        .unwrap_or_default(),
                },
            )?);
        }
    }
    Ok(ConfiguredResult {
        applied: results.iter().any(|result| result.applied),
        changed: results.iter().any(|result| result.changed),
        count: results.len(),
        results,
    })
}

fn resolved_targets(loaded: &LoadedConfig, packages: &[Package]) -> IndexMap<String, SortTarget> {
    let mut targets = loaded.config.sort.clone().unwrap_or_default();
    for package in packages {
        for alias in &package.aliases {
            let target = targets.entry(alias.clone()).or_default();
            if target.base_dir.is_none() {
                target.base_dir = Some(package.dir.clone());
            }
        }
    }
    for target in targets.values_mut() {
        if target.base_dir.is_none() {
            target.base_dir = Some(loaded.project_root.clone());
        }
    }
    targets
}

fn target_files(
    loaded: &LoadedConfig,
    name: &str,
    target: &SortTarget,
    variant: &str,
) -> Result<Vec<PathBuf>> {
    let base = target
        .base_dir
        .as_ref()
        .expect("resolved target has baseDir");
    let default_file = resolve_path(base, Path::new(target.file.as_deref().unwrap_or(".env")));
    let directory = default_file.parent().expect("resolved file has parent");
    let mut files = IndexMap::from([(String::new(), default_file.clone())]);
    for pattern in &loaded.config.dotenv.order {
        if pattern.contains("{build}") {
            for build in &loaded.config.selector.builds {
                files.insert(
                    build.clone(),
                    resolve_path(directory, Path::new(&pattern.replacen("{build}", build, 1))),
                );
            }
        }
    }
    if let Some(configured) = &target.files {
        for (suffix, pattern) in configured {
            if suffix == "default" {
                return Err(Error::new(
                    "SORT_INVALID_CONFIG",
                    format!("config.sort.{name}.files must not use reserved suffix \"default\"."),
                ));
            }
            files.insert(
                suffix.clone(),
                resolve_path(
                    base,
                    Path::new(&pattern.replace("{env}", suffix).replace("{suffix}", suffix)),
                ),
            );
        }
    }
    if variant == "all" {
        return Ok(files.into_values().collect());
    }
    let selected = files.shift_remove(variant).unwrap_or_else(|| {
        directory.join(format!(
            "{}.{variant}",
            default_file.file_name().unwrap().to_string_lossy()
        ))
    });
    Ok(vec![selected])
}
