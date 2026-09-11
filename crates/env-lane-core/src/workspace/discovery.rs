//! Filesystem discovery and alias construction; target selection is pure.
use super::{Package, patterns::DirectoryPatterns};
use crate::{
    config::LoadedConfig,
    error::{Error, Result},
    paths::relative_path,
};
use indexmap::IndexSet;
use std::{fs, path::Path};
use walkdir::WalkDir;

pub fn list_packages(loaded: &LoadedConfig) -> Result<Vec<Package>> {
    let root = &loaded.project_root;
    let settings = &loaded.config.workspace;
    let patterns = DirectoryPatterns::compile(root, &settings.package_globs)?;
    let mut directories = Vec::new();
    for (base, max_depth) in patterns.roots() {
        collect_directories(root, &base, max_depth, &patterns, &mut directories)?;
    }
    directories.sort();
    directories.dedup();
    let mut packages = Vec::new();
    if settings.include_root {
        packages.push(package_for_directory(root, root));
    }
    packages.extend(
        directories
            .iter()
            .map(|directory| package_for_directory(root, directory)),
    );
    for (alias, target) in &settings.aliases {
        let matched = packages.iter_mut().find(|package| {
            package.name.as_ref() == Some(target)
                || package.relative_dir == *target
                || package.dir.file_name().and_then(|name| name.to_str()) == Some(target)
        });
        if let Some(package) = matched
            && !package.aliases.contains(alias)
        {
            package.aliases.push(alias.clone());
        }
    }
    Ok(packages)
}

fn package_for_directory(root: &Path, directory: &Path) -> Package {
    let name = read_package_name(directory);
    let is_root = directory == root;
    let relative_dir = if is_root {
        ".".to_owned()
    } else {
        relative_path(root, directory)
    };
    let mut aliases = IndexSet::new();
    if is_root {
        aliases.insert("root".to_owned());
        aliases.insert(".".to_owned());
    }
    if let Some(name) = &name
        && !name.is_empty()
    {
        aliases.insert(name.clone());
    }
    if !is_root {
        if let Some(basename) = directory.file_name().and_then(|name| name.to_str()) {
            aliases.insert(basename.to_owned());
        }
        aliases.insert(relative_dir.clone());
    }
    Package {
        name,
        dir: directory.to_owned(),
        relative_dir,
        aliases: aliases.into_iter().collect(),
        is_root,
    }
}

fn read_package_name(directory: &Path) -> Option<String> {
    let content = fs::read(directory.join("package.json")).ok()?;
    let package: serde_json::Value = serde_json::from_slice(&content).ok()?;
    package["name"].as_str().map(str::to_owned)
}

/// Keep lexical symlink paths as package identities; missing scan roots match nothing.
fn collect_directories(
    root: &Path,
    base: &Path,
    max_depth: usize,
    patterns: &DirectoryPatterns,
    directories: &mut Vec<std::path::PathBuf>,
) -> Result<()> {
    let walker = WalkDir::new(base)
        .max_depth(max_depth)
        .follow_links(true)
        .into_iter()
        .filter_entry(|entry| {
            !entry
                .path()
                .components()
                .any(|part| matches!(part.as_os_str().to_str(), Some("node_modules" | "dist")))
        });
    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error)
                if error
                    .io_error()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound) =>
            {
                continue;
            }
            Err(error) => return Err(Error::new("WORKSPACE_READ_FAILED", error.to_string())),
        };
        if entry.path() != root
            && entry.file_type().is_dir()
            && patterns.matches(entry.path())?
            && entry.path().join("package.json").exists()
        {
            directories.push(entry.path().to_owned());
        }
    }
    Ok(())
}
