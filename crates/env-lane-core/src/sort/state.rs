//! Per-file template ancestry. No local values are persisted. Each field advances
//! independently, and conflicting fields retain their old accepted baseline.
use super::{
    Action, Operation,
    comments::normalize_blank_lines,
    layout::{Block, Layout},
};
use crate::{
    document::{Document, Eol, LineKind, format_value, parse_line},
    error::{Error, Result},
    paths::relative_path,
    storage,
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

#[derive(Debug, Serialize)]
pub struct Conflict {
    pub key: String,
    pub field: &'static str,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Baseline {
    value_fingerprint: String,
    leading: Vec<String>,
    inline: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileBaseline {
    entries: IndexMap<String, Baseline>,
    preamble: Vec<String>,
    suffix: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    version: u8,
    files: IndexMap<String, FileBaseline>,
}
pub(super) struct Store {
    path: PathBuf,
    identity: String,
    state: State,
    _lock: Option<File>,
}
pub(super) struct Reconciliation {
    pub content: String,
    pub template: String,
    pub operations: Vec<Operation>,
    pub conflicts: Vec<Conflict>,
    pub established: bool,
}
fn invalid(message: impl Into<String>) -> Error {
    Error::new("SORT_STATE_INVALID", message)
}
fn fingerprint(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
pub(super) fn identity(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) if parent != path => identity(parent).join(name),
        _ => path.to_owned(),
    })
}

impl Store {
    pub fn load(directory: &Path, file: &Path, template: &Path, check: bool) -> Result<Self> {
        let path = directory.join("sort-sync-state.json");
        let lock_path = directory.join("sort-sync-state.lock");
        for destination in [&path, &lock_path] {
            if identity(destination) == identity(file)
                || identity(destination) == identity(template)
            {
                return Err(invalid(
                    "Sort state and lock must be distinct from env and template files.",
                ));
            }
        }
        let lock = if check {
            None
        } else {
            fs::create_dir_all(directory).map_err(|error| invalid(error.to_string()))?;
            let file = OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(&lock_path)
                .map_err(|error| invalid(error.to_string()))?;
            fs2::FileExt::try_lock_exclusive(&file).map_err(|error| {
                Error::new(
                    "SORT_STATE_BUSY",
                    format!("Cannot lock {}: {error}", lock_path.display()),
                )
            })?;
            Some(file)
        };
        let state = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<State>(&bytes)
                .map_err(|error| invalid(format!("{}: {error}", path.display())))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => State {
                version: 1,
                files: IndexMap::new(),
            },
            Err(error) => return Err(invalid(error.to_string())),
        };
        if state.version != 1 {
            return Err(invalid("Unsupported sort state version."));
        }
        for (identity, file) in &state.files {
            let (env, template): (String, String) = serde_json::from_str(identity)
                .map_err(|_| invalid("Invalid sort state file identity."))?;
            if env.is_empty()
                || template.is_empty()
                || file.entries.values().any(|entry| {
                    entry.value_fingerprint.len() != 64
                        || !entry
                            .value_fingerprint
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                })
            {
                return Err(invalid("Invalid sort state baseline."));
            }
        }
        let base = identity(directory.parent().unwrap_or(directory));
        let identity = serde_json::to_string(&(
            relative_path(&base, &identity(file)),
            relative_path(&base, &identity(template)),
        ))
        .map_err(|error| invalid(error.to_string()))?;
        Ok(Self {
            path,
            identity,
            state,
            _lock: lock,
        })
    }
    pub fn reconcile(
        &mut self,
        content: &str,
        template: &str,
        exists: bool,
    ) -> Result<Reconciliation> {
        let env = Document::parse(content);
        let source = Document::parse(template);
        let mut local = Layout::from_document(&env);
        let mut desired = Layout::from_document(&source);
        desired.preamble = normalize_blank_lines(desired.preamble);
        desired.suffix = normalize_blank_lines(desired.suffix);
        for block in &mut desired.blocks {
            block.leading = normalize_blank_lines(std::mem::take(&mut block.leading));
        }
        // Explicit recreation starts from the current template. An absent file
        // has no local fields whose ownership can be inferred from old state.
        let previous = self
            .state
            .files
            .shift_remove(&self.identity)
            .filter(|_| exists);
        let established = previous.is_some();
        let mut next = FileBaseline::default();
        let mut operations = Vec::new();
        let mut conflicts = Vec::new();
        let mut seen = HashSet::new();
        for block in &mut desired.blocks {
            // The existing sort contract uses the first template definition.
            if !seen.insert(block.key.clone()) {
                continue;
            }
            let snapshot = snapshot(block);
            let mut accepted = snapshot.clone();
            if let Some(old) = previous
                .as_ref()
                .and_then(|baseline| baseline.entries.get(&block.key))
            {
                let indices: Vec<_> = local
                    .blocks
                    .iter()
                    .enumerate()
                    .filter_map(|(index, entry)| (entry.key == block.key).then_some(index))
                    .collect();
                if !indices.is_empty() {
                    block.leading.clear();
                }
                if let [index] = indices.as_slice() {
                    let entry = &mut local.blocks[*index];
                    // After initialization, local comments are reconciled here. The
                    // layout sorter must not re-inject template text over local edits.
                    block.leading.clear();
                    if old.value_fingerprint != snapshot.value_fingerprint {
                        let current = fingerprint(&entry.value);
                        if current == old.value_fingerprint {
                            replace_value(entry, &block.value)?;
                            operations.push(Operation {
                                action: Action::DefaultUpdated,
                                key: block.key.clone(),
                            });
                        } else if current != snapshot.value_fingerprint {
                            accepted
                                .value_fingerprint
                                .clone_from(&old.value_fingerprint);
                            conflicts.push(Conflict {
                                key: block.key.clone(),
                                field: "default",
                            });
                        }
                    }
                    if old.leading != snapshot.leading
                        && !reconcile_comments(&mut entry.leading, &old.leading, &snapshot.leading)
                    {
                        accepted.leading.clone_from(&old.leading);
                        block.leading.clear();
                        conflicts.push(Conflict {
                            key: block.key.clone(),
                            field: "leading-comment",
                        });
                    } else if old.leading != snapshot.leading {
                        operations.push(Operation {
                            action: Action::CommentUpdated,
                            key: block.key.clone(),
                        });
                    }
                    let current = inline(entry);
                    if old.inline != snapshot.inline {
                        if current.trim() == old.inline.trim() {
                            replace_inline(entry, &snapshot.inline);
                            operations.push(Operation {
                                action: Action::CommentUpdated,
                                key: block.key.clone(),
                            });
                        } else if current.trim() != snapshot.inline.trim() {
                            accepted.inline.clone_from(&old.inline);
                            conflicts.push(Conflict {
                                key: block.key.clone(),
                                field: "inline-comment",
                            });
                        }
                    }
                } else if indices.len() > 1
                    && (old.value_fingerprint != snapshot.value_fingerprint
                        || old.leading != snapshot.leading
                        || old.inline != snapshot.inline)
                {
                    accepted = old.clone();
                    block.leading.clear();
                    conflicts.push(Conflict {
                        key: block.key.clone(),
                        field: "duplicate-entry",
                    });
                }
            }
            next.entries.entry(block.key.clone()).or_insert(accepted);
        }
        next.preamble = desired.preamble.clone();
        next.suffix = desired.suffix.clone();
        if let Some(previous) = previous {
            for (key, field, current, old, desired, accepted) in [
                (
                    "<header>",
                    "header-comment",
                    &mut local.preamble,
                    &previous.preamble,
                    &mut desired.preamble,
                    &mut next.preamble,
                ),
                (
                    "<footer>",
                    "footer-comment",
                    &mut local.suffix,
                    &previous.suffix,
                    &mut desired.suffix,
                    &mut next.suffix,
                ),
            ] {
                if old != desired && !reconcile_comments(current, old, desired) {
                    accepted.clone_from(old);
                    desired.clear();
                    conflicts.push(Conflict {
                        key: key.into(),
                        field,
                    });
                } else if old != desired {
                    operations.push(Operation {
                        action: Action::CommentUpdated,
                        key: key.into(),
                    });
                }
                desired.clear();
            }
        }
        for conflict in &conflicts {
            operations.push(Operation {
                action: Action::ConflictKeptLocal,
                key: conflict.key.clone(),
            });
        }
        self.state.files.insert(self.identity.clone(), next);
        Ok(Reconciliation {
            content: render(&env, &local),
            template: render(&source, &desired),
            operations,
            conflicts,
            established,
        })
    }
    pub fn save(&self) -> Result<()> {
        let content = serde_json::to_string_pretty(&self.state)
            .map_err(|error| invalid(error.to_string()))?
            + "\n";
        storage::write_if_changed(&self.path, &content)?;
        Ok(())
    }
}
fn render(document: &Document, layout: &Layout) -> String {
    let mut lines = layout.preamble.clone();
    for block in &layout.blocks {
        lines.extend(block.leading.clone());
        lines.extend(block.lines.clone());
    }
    lines.extend(layout.suffix.clone());
    document.document.render(&lines, true, Eol::Auto)
}
fn snapshot(block: &Block) -> Baseline {
    Baseline {
        value_fingerprint: fingerprint(&block.value),
        leading: block.leading.clone(),
        inline: inline(block),
    }
}
fn inline(block: &Block) -> String {
    if block.lines.len() > 1 {
        let last = block.lines.last().unwrap();
        if let LineKind::Entry(entry) | LineKind::CommentedEntry(entry) =
            parse_line(&block.lines[0], 1).kind
            && let Some(quote) = entry.value_token.trim_start().chars().next()
            && let LineKind::Entry(tail) = parse_line(
                &format!(
                    "SORT_VALUE={quote}{}",
                    if block.active {
                        last.as_str()
                    } else {
                        super::layout::uncomment(last).unwrap_or(last)
                    }
                ),
                1,
            )
            .kind
        {
            return tail.suffix;
        }
    }
    match parse_line(&block.lines[0], 1).kind {
        LineKind::Entry(entry) | LineKind::CommentedEntry(entry) => entry.suffix,
        _ => String::new(),
    }
}
fn replace_value(block: &mut Block, value: &str) -> Result<()> {
    if let LineKind::Entry(entry) | LineKind::CommentedEntry(entry) =
        parse_line(&block.lines[0], 1).kind
    {
        let rendered = format!("{}{}{}", entry.prefix, format_value(value)?, inline(block));
        block.lines = rendered
            .split('\n')
            .enumerate()
            .map(|(index, line)| {
                if index > 0 && !block.active {
                    format!("# {line}")
                } else {
                    line.to_owned()
                }
            })
            .collect();
        block.value = value.into();
    }
    Ok(())
}
fn replace_inline(block: &mut Block, suffix: &str) {
    let old = inline(block);
    let last = block.lines.last_mut().unwrap();
    last.truncate(last.len() - old.len());
    last.push_str(suffix);
}
fn reconcile_comments(current: &mut Vec<String>, old: &[String], new: &[String]) -> bool {
    if current == new {
        return true;
    }
    let old_lines = comment_lines(old);
    let new_lines = comment_lines(new);
    let old_positions = unique_positions(current, &old_lines);
    if !new_lines.is_empty()
        && let Some(new_positions) = unique_positions(current, &new_lines)
    {
        // A manually accepted update can coexist with the old block. Remove
        // only unambiguous old managed lines; retain local notes and shared lines.
        if let Some(old_positions) = old_positions {
            for index in old_positions.into_iter().rev() {
                if !new_positions.contains(&index) {
                    current.remove(index);
                }
            }
        }
        return true;
    }
    if old_lines.is_empty() {
        current.splice(0..0, new.iter().cloned());
        return true;
    }
    let Some(positions) = old_positions else {
        return false;
    };
    // Keep the exact new spacing when the old block is still contiguous.
    if let Some(index) = current.windows(old.len()).position(|lines| lines == old) {
        current.splice(index..index + old.len(), new.iter().cloned());
        return true;
    }
    let mut chunks = Vec::new();
    let mut chunk = Vec::new();
    for line in new {
        chunk.push(line.clone());
        if !super::layout::blank(line) {
            chunks.push(std::mem::take(&mut chunk));
        }
    }
    if let Some(last) = chunks.last_mut() {
        last.extend(chunk);
    }
    let mut replacement = Vec::new();
    let mut next_position = 0;
    for (index, line) in current.iter().enumerate() {
        if positions.get(next_position) == Some(&index) {
            if let Some(chunk) = chunks.get(next_position) {
                replacement.extend(chunk.clone());
            }
            next_position += 1;
            if next_position == positions.len() {
                replacement.extend(chunks.iter().skip(next_position).flatten().cloned());
            }
        } else {
            replacement.push(line.clone());
        }
    }
    *current = replacement;
    true
}
fn comment_lines(lines: &[String]) -> Vec<&str> {
    lines
        .iter()
        .filter(|line| !super::layout::blank(line))
        .map(String::as_str)
        .collect()
}
fn unique_positions(current: &[String], desired: &[&str]) -> Option<Vec<usize>> {
    if desired.is_empty() {
        return None;
    }
    let mut forward = current.iter().enumerate();
    let earliest = desired
        .iter()
        .map(|line| {
            forward
                .find(|(_, value)| value.as_str() == *line)
                .map(|(index, _)| index)
        })
        .collect::<Option<Vec<_>>>()?;
    let mut backward = current.iter().enumerate().rev();
    let mut latest = desired
        .iter()
        .rev()
        .map(|line| {
            backward
                .find(|(_, value)| value.as_str() == *line)
                .map(|(index, _)| index)
        })
        .collect::<Option<Vec<_>>>()?;
    latest.reverse();
    (earliest == latest).then_some(earliest)
}
