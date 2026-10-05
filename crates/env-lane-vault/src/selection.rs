//! Selection and local-only exclusions use the same dot-aware glob boundary.
use crate::config::Config;
use env_lane_core::{
    error::{Error, Result},
    paths::relative_path,
};
use fancy_regex::Regex;
use picomatch_rs::{CompileOptions, make_re};
use std::path::Path;

fn compile_matcher(pattern: &str) -> Result<Regex> {
    if pattern.is_empty() {
        return Err(Error::new(
            "VAULT_INVALID_FILTER",
            "Vault pattern must be a non-empty string.",
        ));
    }
    let expression = make_re(
        pattern,
        &CompileOptions {
            nonegate: true,
            dot: true,
            ..Default::default()
        },
        false,
    )
    .ok_or_else(|| {
        Error::new(
            "VAULT_INVALID_FILTER",
            format!("Invalid Vault pattern: {pattern}"),
        )
    })?;
    Regex::new(&expression.source)
        .map_err(|error| Error::new("VAULT_INVALID_FILTER", error.to_string()))
}

#[derive(Default, Clone)]
pub struct Filter {
    pub file: Option<String>,
    pub key: Option<String>,
    pub include: Option<String>,
    pub exclude: Option<String>,
    pub only: Option<String>,
    pub approve_deletes: bool,
}

struct PathMatcher {
    direct: Regex,
    nested: Option<Regex>,
}
impl PathMatcher {
    fn new(pattern: &str) -> Result<Self> {
        Ok(Self {
            direct: compile_matcher(pattern)?,
            nested: (!Path::new(pattern).is_absolute())
                .then(|| compile_matcher(&format!("**/{pattern}")))
                .transpose()?,
        })
    }
    fn matches(&self, candidate: &str) -> Result<bool> {
        if matches_compiled(&self.direct, candidate)? {
            return Ok(true);
        }
        self.nested
            .as_ref()
            .map(|matcher| matches_compiled(matcher, candidate))
            .unwrap_or(Ok(false))
    }
}

/// A selection compiled once for every candidate in a native operation.
pub struct PreparedFilter {
    file: Option<PathMatcher>,
    key: Option<Regex>,
    include: Option<PathMatcher>,
    exclude: Option<PathMatcher>,
    only: Option<Vec<String>>,
    pub approve_deletes: bool,
}

impl Filter {
    /// Validate selectors even when the store has no entries to visit.
    pub fn validate(&self) -> Result<()> {
        self.compile().map(|_| ())
    }

    pub fn compile(&self) -> Result<PreparedFilter> {
        let only = self.only.as_deref().map(|value| {
            value
                .split(',')
                .map(str::trim)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        });
        if only.as_ref().is_some_and(|actions| {
            actions.iter().any(|action| {
                !["add", "modify", "delete", "identical", "conflict"].contains(&action.as_str())
            })
        }) {
            return Err(Error::new(
                "VAULT_INVALID_FILTER",
                "--only contains an unknown action.",
            ));
        }
        Ok(PreparedFilter {
            file: self.file.as_deref().map(PathMatcher::new).transpose()?,
            key: self.key.as_deref().map(compile_matcher).transpose()?,
            include: self.include.as_deref().map(PathMatcher::new).transpose()?,
            exclude: self.exclude.as_deref().map(PathMatcher::new).transpose()?,
            only,
            approve_deletes: self.approve_deletes,
        })
    }

    pub fn selected(&self, file: &Path, key: &str, action: &str) -> Result<bool> {
        self.compile()?.selected(file, key, action)
    }
}
impl PreparedFilter {
    pub fn selected(&self, file: &Path, key: &str, action: &str) -> Result<bool> {
        if self
            .only
            .as_ref()
            .is_some_and(|actions| !actions.iter().any(|item| item == action))
        {
            return Ok(false);
        }
        let file = file.to_string_lossy().replace('\\', "/");
        let pair = format!("{file}:{key}");
        if let Some(matcher) = &self.file
            && !matcher.matches(&file)?
        {
            return Ok(false);
        }
        if let Some(matcher) = &self.key
            && !matches_compiled(matcher, key)?
        {
            return Ok(false);
        }
        if let Some(matcher) = &self.include
            && !matcher.matches(&pair)?
        {
            return Ok(false);
        }
        if let Some(matcher) = &self.exclude
            && matcher.matches(&pair)?
        {
            return Ok(false);
        }
        Ok(true)
    }
}

struct ExclusionRule {
    files: Vec<Regex>,
    keys: Vec<Regex>,
}

/// Compile local-only patterns once for all records in an operation.
pub struct Exclusions<'a> {
    config: &'a Config,
    rules: Vec<ExclusionRule>,
}

impl<'a> Exclusions<'a> {
    pub fn new(config: &'a Config) -> Result<Self> {
        let rules = config
            .exclude
            .iter()
            .map(|rule| {
                Ok(ExclusionRule {
                    files: rule
                        .files
                        .iter()
                        .map(|pattern| compile_matcher(pattern))
                        .collect::<Result<_>>()?,
                    keys: rule
                        .keys
                        .iter()
                        .map(|pattern| compile_matcher(pattern))
                        .collect::<Result<_>>()?,
                })
            })
            .collect::<Result<_>>()?;
        Ok(Self { config, rules })
    }

    pub fn excluded(&self, file: &Path, key: &str) -> Result<bool> {
        let relative = relative_path(&self.config.base_dir, file);
        let basename = file
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        for rule in &self.rules {
            let file_match = rule.files.iter().try_fold(false, |found, matcher| {
                Ok::<_, Error>(
                    found
                        || matches_compiled(matcher, &relative)?
                        || matches_compiled(matcher, basename)?,
                )
            })?;
            let key_match = rule.keys.iter().try_fold(false, |found, matcher| {
                Ok::<_, Error>(found || matches_compiled(matcher, key)?)
            })?;
            if file_match && key_match {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn assert_clean(&self, store: &crate::store::Store) -> Result<()> {
        if !self.rules.is_empty() && store.failed_records > 0 {
            return Err(Error::new(
                "VAULT_EXCLUDE_AUDIT_FAILED",
                format!(
                    "Cannot verify the local-only exclude boundary because {} vault record(s) are unreadable. Sanitize or repair the store before continuing; ignoreCorruptRecords cannot bypass exclude auditing.",
                    store.failed_records
                ),
            ));
        }
        let mut examples = Vec::new();
        let mut count = 0;
        for line in &store.records {
            if self.excluded(&line.group_file_path, &line.record.key)? {
                count += 1;
                let example = format!(
                    "{}:{}",
                    relative_path(&self.config.base_dir, &line.group_file_path),
                    line.record.key
                );
                if !examples.contains(&example) && examples.len() < 3 {
                    examples.push(example);
                }
            }
        }
        if count > 0 {
            return Err(Error::new(
                "VAULT_EXCLUDED_HISTORY",
                format!(
                    "Vault store contains {count} historical record(s) now matched by exclude ({}). Excluded values are local-only; run \"env-lane vault sanitize <keyFile> --excluded --dry-run\" and then repeat with --yes before continuing. Rotate any secret that may already have been shared.",
                    examples.join(", ")
                ),
            ));
        }
        Ok(())
    }
}

fn matches_compiled(matcher: &Regex, candidate: &str) -> Result<bool> {
    matcher
        .is_match(candidate)
        .map_err(|error| Error::new("VAULT_INVALID_FILTER", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::Filter;

    #[test]
    fn invalid_action_is_rejected_without_store_entries() {
        let filter = Filter {
            only: Some("unknown".into()),
            ..Default::default()
        };
        assert_eq!(filter.validate().unwrap_err().code, "VAULT_INVALID_FILTER");
    }

    #[test]
    fn empty_patterns_are_rejected_before_visiting_entries() {
        for field in ["file", "key", "include", "exclude"] {
            let mut filter = Filter::default();
            match field {
                "file" => filter.file = Some(String::new()),
                "key" => filter.key = Some(String::new()),
                "include" => filter.include = Some(String::new()),
                _ => filter.exclude = Some(String::new()),
            }
            assert_eq!(filter.validate().unwrap_err().code, "VAULT_INVALID_FILTER");
        }
    }
}
