//! Target selection is independent of filesystem access and process state.
use super::Package;
use crate::error::{Error, Result};
use indexmap::IndexSet;
use std::path::Path;

/// Resolve a target from a single discovery snapshot. Callers that resolve several
/// sources can reuse this list without rescanning the workspace for each source.
pub fn resolve_target<'a>(
    packages: &'a [Package],
    requested: Option<&str>,
    default_target: &str,
    cwd: Option<&Path>,
) -> Result<&'a Package> {
    let target = requested
        .filter(|target| !target.is_empty())
        .unwrap_or(default_target);
    let mut target = crate::text::trim(target).to_owned();
    if target.is_empty()
        && let Some(cwd) = cwd
    {
        let nearest = packages
            .iter()
            .filter(|package| cwd.starts_with(&package.dir))
            .max_by_key(|package| package.dir.as_os_str().len());
        if let Some(package) = nearest {
            target = package
                .aliases
                .first()
                .unwrap_or(&package.relative_dir)
                .clone();
        }
    }
    if target.is_empty() {
        if packages.iter().all(|package| package.is_root)
            && let Some(package) = packages.first()
        {
            return Ok(package);
        }
        return Err(Error::new(
            "MISSING_TARGET",
            format!(
                "Missing target. Available targets: {}",
                available_targets(packages)
            ),
        ));
    }
    let matches: Vec<_> = packages
        .iter()
        .filter(|package| {
            package.aliases.contains(&target)
                || package.name.as_ref() == Some(&target)
                || package.relative_dir == target
        })
        .collect();
    match matches.as_slice() {
        [package] => Ok(package),
        [] => Err(Error::new(
            "UNKNOWN_TARGET",
            format!(
                "Unknown target '{target}'. Available targets: {}",
                available_targets(packages)
            ),
        )),
        _ => {
            let names = matches
                .iter()
                .map(|package| package.name.as_deref().unwrap_or(&package.relative_dir))
                .collect::<Vec<_>>()
                .join(", ");
            Err(Error::new(
                "AMBIGUOUS_TARGET",
                format!(
                    "Ambiguous target '{target}'. Matches: {names}. Use a package name, relative directory, or configure a unique alias."
                ),
            ))
        }
    }
}

fn available_targets(packages: &[Package]) -> String {
    packages
        .iter()
        .flat_map(|package| package.aliases.iter().cloned())
        .collect::<IndexSet<_>>()
        .into_iter()
        .collect::<Vec<_>>()
        .join(", ")
}
