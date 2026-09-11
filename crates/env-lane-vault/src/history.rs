//! Pure history rewrite planning. Selection uses authenticated records; surviving
//! ciphertext is copied verbatim, including unreadable lines allowed by callers.
use crate::store::{Store, persistence};
use env_lane_core::{
    error::{Error, Result},
    paths::relative_path,
};
use indexmap::IndexMap;
use serde::Serialize;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

pub struct PruneOptions<'a> {
    pub file: Option<&'a Path>,
    pub key: Option<&'a str>,
    pub keep_recent: Option<usize>,
    /// Absolute cutoff timestamp. The external API converts olderThanDays once
    /// using the operation clock; the planner does not read a global clock.
    pub older_than: Option<f64>,
    pub preserve_latest: bool,
}
impl Default for PruneOptions<'_> {
    fn default() -> Self {
        Self {
            file: None,
            key: None,
            keep_recent: None,
            older_than: None,
            preserve_latest: true,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub store_path: PathBuf,
    pub store_digest: String,
    pub removed_records: usize,
    pub kept_records: usize,
}

/// The snapshot and selected lines cannot be altered through the public summary.
/// Applying still checks the current digest while holding the store write lock.
pub struct RewritePlan {
    summary: Summary,
    expected_lines: Vec<String>,
    next_lines: Vec<String>,
}
impl RewritePlan {
    pub fn summary(&self) -> &Summary {
        &self.summary
    }
    pub fn apply(&self) -> Result<bool> {
        if self.summary.removed_records == 0 {
            return Ok(false);
        }
        persistence::rewrite(
            &self.summary.store_path,
            &self.expected_lines,
            &self.next_lines,
        )?;
        Ok(true)
    }
}

pub struct PrunePlan {
    pub rewrite: RewritePlan,
    pub groups: usize,
}

pub fn prune(path: &Path, store: &Store, options: &PruneOptions<'_>) -> Result<PrunePlan> {
    if options.keep_recent.is_none() && options.older_than.is_none() {
        return Err(invalid(
            "History prune requires --keep-recent or --older-than-days.",
        ));
    }
    if options.keep_recent == Some(0) {
        return Err(invalid("keepRecent must be a positive integer."));
    }
    if options.older_than.is_some_and(|cutoff| !cutoff.is_finite()) {
        return Err(invalid("History cutoff must be a finite timestamp."));
    }
    let mut groups = IndexMap::<_, Vec<_>>::new();
    for line in &store.records {
        if options
            .file
            .is_some_and(|file| file != line.group_file_path)
            || options.key.is_some_and(|key| key != line.record.key)
        {
            continue;
        }
        groups
            .entry((&line.group_file_path, &line.record.key))
            .or_default()
            .push(line);
    }
    let mut removed = BTreeSet::new();
    for records in groups.values_mut() {
        records.sort_by(|left, right| {
            right
                .record
                .timestamp
                .total_cmp(&left.record.timestamp)
                .then_with(|| right.record.order.cmp(&left.record.order))
        });
        for (rank, line) in records.iter().enumerate() {
            if options.preserve_latest && rank == 0 {
                continue;
            }
            if options.keep_recent.is_some_and(|count| rank >= count)
                || options
                    .older_than
                    .is_some_and(|cutoff| line.record.timestamp < cutoff)
            {
                removed.insert(line.line_index);
            }
        }
    }
    Ok(PrunePlan {
        rewrite: plan(path, store, &removed),
        groups: groups.len(),
    })
}

pub struct SanitizePlan {
    pub rewrite: RewritePlan,
    pub affected_entries: Vec<String>,
}

/// The exclusion policy is supplied by the shared matcher, allowing history
/// inspection and synchronization to use the same interpretation of each rule.
pub fn sanitize(
    path: &Path,
    base: &Path,
    store: &Store,
    mut excluded: impl FnMut(&Path, &str) -> bool,
) -> Result<SanitizePlan> {
    if store.failed_records != 0 {
        return Err(Error::new(
            "VAULT_CORRUPT_STORE",
            "Cannot sanitize unreadable Vault history.",
        ));
    }
    let mut removed = BTreeSet::new();
    let mut affected = BTreeSet::new();
    for line in &store.records {
        if excluded(&line.group_file_path, &line.record.key) {
            removed.insert(line.line_index);
            affected.insert(format!(
                "{}:{}",
                relative_path(base, &line.group_file_path),
                line.record.key
            ));
        }
    }
    Ok(SanitizePlan {
        rewrite: plan(path, store, &removed),
        affected_entries: affected.into_iter().collect(),
    })
}

fn plan(path: &Path, store: &Store, removed: &BTreeSet<usize>) -> RewritePlan {
    let next_lines: Vec<_> = store
        .raw_lines
        .iter()
        .enumerate()
        .filter(|(index, _)| !removed.contains(index))
        .map(|(_, line)| line.clone())
        .collect();
    RewritePlan {
        summary: Summary {
            store_path: path.to_owned(),
            store_digest: persistence::digest(&store.raw_lines),
            removed_records: store.raw_lines.len() - next_lines.len(),
            kept_records: next_lines.len(),
        },
        expected_lines: store.raw_lines.clone(),
        next_lines,
    }
}
fn invalid(message: &str) -> Error {
    Error::new("VAULT_INVALID_PRUNE_OPTIONS", message)
}
