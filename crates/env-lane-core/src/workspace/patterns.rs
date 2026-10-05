//! Compile workspace patterns once and derive the directories worth scanning.
use crate::{
    error::{Error, Result},
    paths::{relative_path, resolve_path},
};
mod braces;
use fancy_regex::Regex;
use picomatch_rs::{CompileOptions, make_re};
use std::path::{Path, PathBuf};

pub(super) struct DirectoryPatterns {
    root: PathBuf,
    included: Vec<DirectoryPattern>,
    excluded: Vec<Exclusion>,
}

struct DirectoryPattern {
    base: PathBuf,
    matcher: Regex,
    max_depth: usize,
}

struct Exclusion {
    absolute: bool,
    matcher: Regex,
}

impl DirectoryPatterns {
    pub(super) fn compile(root: &Path, patterns: &[String]) -> Result<Self> {
        let mut included = Vec::new();
        let mut excluded = Vec::new();
        for pattern in patterns {
            let expanded = braces::expand(pattern)?;
            for pattern in expanded.iter().filter(|value| !value.is_empty()) {
                // A leading negative extglob is an inclusion, unlike a list exclusion.
                if pattern.starts_with('!') && !pattern.starts_with("!(") {
                    let pattern = &pattern[1..];
                    excluded.push(Exclusion {
                        absolute: Path::new(pattern).is_absolute(),
                        matcher: compile_matcher(pattern, true)?,
                    });
                } else {
                    included.push(DirectoryPattern::compile(root, pattern)?);
                }
            }
        }
        Ok(Self {
            root: root.to_owned(),
            included,
            excluded,
        })
    }

    pub(super) fn roots(&self) -> std::collections::BTreeMap<PathBuf, usize> {
        let mut roots = std::collections::BTreeMap::new();
        for pattern in &self.included {
            let depth = roots.entry(pattern.base.clone()).or_insert(0);
            *depth = (*depth).max(pattern.max_depth);
        }
        roots
    }

    pub(super) fn matches(&self, path: &Path) -> Result<bool> {
        for pattern in &self.excluded {
            // Exclusions compare lexical names. Collapsing ../ here changes the
            // pattern's meaning even when it happens to point back into the root.
            let candidate = if pattern.absolute {
                path.to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/")
            } else {
                relative_path(&self.root, path)
            };
            if matches_directory(&pattern.matcher, &candidate)? {
                return Ok(false);
            }
        }
        for pattern in &self.included {
            if matches_directory(&pattern.matcher, &relative_path(&pattern.base, path))? {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

impl DirectoryPattern {
    fn compile(root: &Path, pattern: &str) -> Result<Self> {
        let pattern = pattern.trim_end_matches('/');
        // Keep special characters out of the physical scan root. Escaped names
        // must be matched after reading their parent, not opened with backslashes.
        let dynamic = pattern.find(['*', '?', '[', '(', '{', '\\']);
        let prefix_end = dynamic.unwrap_or(pattern.len());
        let split = pattern[..prefix_end]
            .rfind('/')
            .map_or(0, |index| index + 1);
        let base = resolve_path(root, Path::new(&pattern[..split]));
        let matcher = compile_matcher(&pattern[split..], false)?;
        let suffix = &pattern[split..];
        let max_depth = if suffix.contains("**") {
            usize::MAX
        } else {
            suffix.split('/').count()
        };
        Ok(Self {
            base,
            matcher,
            max_depth,
        })
    }
}

fn compile_matcher(pattern: &str, dot: bool) -> Result<Regex> {
    let descriptor = make_re(
        pattern,
        &CompileOptions {
            nonegate: true,
            dot,
            ..Default::default()
        },
        false,
    )
    .ok_or_else(|| glob_error(format!("Unsupported workspace pattern '{pattern}'")))?;
    Regex::new(&descriptor.source).map_err(|error| glob_error(error.to_string()))
}

fn matches_directory(matcher: &Regex, candidate: &str) -> Result<bool> {
    // Directory-only patterns can require a trailing slash, including a globstar
    // whose zero-directory match still consumes the preceding separator.
    Ok(matcher
        .is_match(candidate)
        .map_err(|error| glob_error(error.to_string()))?
        || matcher
            .is_match(&format!("{candidate}/"))
            .map_err(|error| glob_error(error.to_string()))?)
}

fn glob_error(message: String) -> Error {
    Error::new("INVALID_WORKSPACE_GLOB", message)
}
