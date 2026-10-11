//! Resolve aliases to shared targets before applying defaults and selecting files.
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
    pub sync_dir: Option<PathBuf>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredResult {
    pub applied: bool,
    pub changed: bool,
    pub count: usize,
    pub missing_count: usize,
    pub unchanged_count: usize,
    pub results: Vec<SortResult>,
}
struct Target {
    name: String,
    aliases: Vec<String>,
    settings: SortTarget,
}

fn merged(defaults: &SortTarget, target: &SortTarget) -> SortTarget {
    SortTarget {
        enabled: Some(target.enabled.or(defaults.enabled).unwrap_or(true)),
        base_dir: target
            .base_dir
            .clone()
            .or_else(|| defaults.base_dir.clone()),
        file: Some(
            target
                .file
                .clone()
                .or_else(|| defaults.file.clone())
                .unwrap_or_else(|| ".env".into()),
        ),
        template: Some(
            target
                .template
                .clone()
                .or_else(|| defaults.template.clone())
                .unwrap_or_else(|| ".env.example".into()),
        ),
        files: match (&defaults.files, &target.files) {
            (Some(a), Some(b)) => {
                let mut files = a.clone();
                files.extend(b.clone());
                Some(files)
            }
            (a, b) => b.clone().or_else(|| a.clone()),
        },
        create: Some(target.create.or(defaults.create).unwrap_or(false)),
        unlisted_variables_comment: Some(
            target
                .unlisted_variables_comment
                .clone()
                .or_else(|| defaults.unlisted_variables_comment.clone())
                .unwrap_or_default(),
        ),
        sync_dir: target
            .sync_dir
            .clone()
            .or_else(|| defaults.sync_dir.clone()),
        targets: target.targets.clone().or_else(|| defaults.targets.clone()),
        suffixes: target
            .suffixes
            .clone()
            .or_else(|| defaults.suffixes.clone()),
    }
}
fn resolved_targets(loaded: &LoadedConfig, packages: &[Package]) -> Result<Vec<Target>> {
    let configured = loaded.config.sort.clone().unwrap_or_default();
    let defaults = configured
        .get(&loaded.config.selector.sort_defaults_key)
        .cloned()
        .unwrap_or_default();
    let mut targets: Vec<Target> = Vec::new();
    let mut used = HashSet::new();
    // Explicit config order determines the batch order; discovered targets follow.
    for (name, settings) in &configured {
        if name == &loaded.config.selector.sort_defaults_key {
            continue;
        }
        let package = packages
            .iter()
            .find(|package| package.aliases.contains(name));
        let mut settings = merged(&defaults, settings);
        settings.base_dir.get_or_insert_with(|| {
            package.map_or_else(
                || loaded.project_root.clone(),
                |package| package.dir.clone(),
            )
        });
        if let Some(package) = package {
            if let Some(existing) = targets
                .iter_mut()
                .find(|target| target.aliases == package.aliases)
            {
                if serde_json::to_value(&existing.settings).unwrap()
                    != serde_json::to_value(&settings).unwrap()
                {
                    return Err(Error::new(
                        "SORT_AMBIGUOUS_CONFIG",
                        format!(
                            "Sort aliases {} and {name} configure the same package differently.",
                            existing.name
                        ),
                    ));
                }
                continue;
            }
            used.insert(package.dir.clone());
        }
        targets.push(Target {
            name: name.clone(),
            aliases: package.map_or_else(|| vec![name.clone()], |package| package.aliases.clone()),
            settings,
        });
    }
    for package in packages {
        if used.contains(&package.dir) {
            continue;
        }
        let mut settings = defaults.clone();
        settings.base_dir.get_or_insert_with(|| package.dir.clone());
        targets.push(Target {
            name: package.relative_dir.clone(),
            aliases: package.aliases.clone(),
            settings,
        });
    }
    if let Some(names) = &defaults.targets {
        let mut ordered = Vec::new();
        for name in names {
            let index = targets
                .iter()
                .position(|target| target.name == *name || target.aliases.contains(name))
                .ok_or_else(|| {
                    Error::new(
                        "SORT_UNKNOWN_KEY",
                        format!("Unknown sort key in default.targets: {name}"),
                    )
                })?;
            if !ordered.contains(&index) {
                ordered.push(index);
            }
        }
        targets = ordered
            .into_iter()
            .map(|index| Target {
                name: targets[index].name.clone(),
                aliases: targets[index].aliases.clone(),
                settings: targets[index].settings.clone(),
            })
            .collect();
    }
    Ok(targets)
}

pub fn sort_configured(
    loaded: &LoadedConfig,
    packages: &[Package],
    key: Option<&str>,
    variant: Option<&str>,
    options: &ConfiguredOptions,
) -> Result<ConfiguredResult> {
    let key = key.map(trim).filter(|key| !key.is_empty()).unwrap_or("all");
    let suffix = variant.map(trim).unwrap_or("all");
    let suffix = suffix
        .strip_prefix(".env.")
        .or_else(|| suffix.strip_prefix('.'))
        .unwrap_or(suffix);
    let variant = normalize_variant(Some(suffix), "all", true, "env-suffix")?;
    let targets = resolved_targets(loaded, packages)?;
    let selected: Vec<_> = targets
        .iter()
        .filter(|target| {
            target.settings.enabled != Some(false)
                && (key == "all"
                    || target.name == key
                    || target.aliases.iter().any(|alias| alias == key))
        })
        .collect();
    if selected.is_empty() {
        return Err(Error::new(
            "SORT_UNKNOWN_KEY",
            format!("Unknown sort key: {key}"),
        ));
    }
    let mut jobs: IndexMap<PathBuf, (PathBuf, PathBuf, SortOptions)> = IndexMap::new();
    for target in selected {
        let settings = &target.settings;
        let base = settings.base_dir.as_ref().expect("resolved baseDir");
        let template = resolve_path(
            base,
            Path::new(settings.template.as_deref().unwrap_or(".env.example")),
        );
        for file in target_files(loaded, settings, &variant)? {
            let identity = super::state::identity(&file);
            let sort_options = SortOptions {
                create: options.create.or(settings.create).unwrap_or(false),
                check: options.check,
                preserve_bom: options
                    .preserve_bom
                    .unwrap_or(loaded.config.dotenv.preserve_bom),
                eol: options.eol.unwrap_or(loaded.config.dotenv.eol),
                unlisted_variables_comment: settings
                    .unlisted_variables_comment
                    .clone()
                    .unwrap_or_default(),
                sync_dir: options
                    .sync_dir
                    .as_ref()
                    .map(|directory| resolve_path(&loaded.invocation_cwd, directory))
                    .or_else(|| {
                        settings
                            .sync_dir
                            .as_ref()
                            .map(|directory| resolve_path(&loaded.project_root, directory))
                    })
                    .or_else(|| Some(loaded.project_root.join(".env-lane-cache"))),
            };
            if let Some((_, previous_template, previous_options)) = jobs.get(&identity) {
                if super::state::identity(previous_template) != super::state::identity(&template)
                    || serde_json::to_value(previous_options).unwrap()
                        != serde_json::to_value(&sort_options).unwrap()
                {
                    return Err(Error::new(
                        "SORT_AMBIGUOUS_DESTINATION",
                        format!(
                            "Multiple sort jobs configure {} differently.",
                            file.display()
                        ),
                    ));
                }
            } else {
                jobs.insert(identity, (file, template.clone(), sort_options));
            }
        }
    }
    let mut results = Vec::new();
    for (_, (file, template, options)) in jobs {
        results.push(sort_file(&file, &template, &options)?);
    }
    Ok(ConfiguredResult {
        applied: results.iter().any(|result| result.applied),
        changed: results.iter().any(|result| result.changed),
        count: results
            .iter()
            .filter(|result| result.status != super::Status::Missing)
            .count(),
        missing_count: results
            .iter()
            .filter(|result| result.status == super::Status::Missing)
            .count(),
        unchanged_count: results
            .iter()
            .filter(|result| result.status == super::Status::Unchanged)
            .count(),
        results,
    })
}
fn target_files(loaded: &LoadedConfig, target: &SortTarget, variant: &str) -> Result<Vec<PathBuf>> {
    let base = target.base_dir.as_ref().expect("resolved baseDir");
    let default_file = resolve_path(base, Path::new(target.file.as_deref().unwrap_or(".env")));
    let file_name = default_file.file_name().ok_or_else(|| {
        Error::new(
            "SORT_INVALID_CONFIG",
            "sort.file must name a file, not a filesystem root.",
        )
    })?;
    let directory = default_file.parent().expect("file has parent");
    let mut files = IndexMap::from([("default".to_owned(), default_file.clone())]);
    for pattern in &loaded.config.dotenv.order {
        if pattern.contains("{build}") {
            for build in &loaded.config.selector.builds {
                if build == "default" {
                    continue;
                }
                let pattern = if build == &loaded.config.dotenv.local_build_name {
                    loaded.config.dotenv.local_override_file.clone()
                } else {
                    pattern.replace("{build}", build)
                };
                files.insert(build.clone(), resolve_path(directory, Path::new(&pattern)));
            }
        }
    }
    if let Some(configured) = &target.files {
        for (suffix, pattern) in configured {
            files.insert(
                suffix.clone(),
                resolve_path(
                    base,
                    Path::new(&pattern.replace("{env}", suffix).replace("{suffix}", suffix)),
                ),
            );
        }
    }
    if let Some(suffixes) = &target.suffixes {
        if variant != "all" && !suffixes.iter().any(|suffix| suffix == variant) {
            return Err(Error::new(
                "SORT_UNKNOWN_SUFFIX",
                format!("Unknown sort suffix: {variant}"),
            ));
        }
        if variant == "all" {
            return suffixes
                .iter()
                .map(|suffix| {
                    normalize_variant(Some(suffix), "default", false, "sort suffix")?;
                    Ok(files.get(suffix).cloned().unwrap_or_else(|| {
                        directory.join(format!("{}.{suffix}", file_name.to_string_lossy()))
                    }))
                })
                .collect();
        }
    }
    if variant == "all" {
        return Ok(files.into_values().collect());
    }
    Ok(vec![files.shift_remove(variant).unwrap_or_else(|| {
        directory.join(format!("{}.{variant}", file_name.to_string_lossy()))
    })])
}
