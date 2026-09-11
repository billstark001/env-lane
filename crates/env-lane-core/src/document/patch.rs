//! Pure document edits. Persistence belongs to the filesystem adapter so previews
//! and failed formatting never write a partially transformed document.
use super::{Document, Entry, Eol, Line, LineKind, format_value};
use crate::error::Result;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Patch {
    Set { key: String, value: String },
    Delete { key: String },
}
impl Patch {
    fn key(&self) -> &str {
        match self {
            Self::Set { key, .. } | Self::Delete { key } => key,
        }
    }
}
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Update {
    #[default]
    All,
    Last,
}
#[derive(Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PatchOptions {
    pub ignored_keys: HashSet<String>,
    pub update: Update,
    pub match_commented: bool,
    pub remove_duplicate_entries: bool,
    pub blank_line_before_additions: bool,
    #[serde(rename = "preserveBOM")]
    pub preserve_bom: bool,
    pub eol: Eol,
}
impl Default for PatchOptions {
    fn default() -> Self {
        Self {
            ignored_keys: HashSet::new(),
            update: Update::All,
            match_commented: false,
            remove_duplicate_entries: false,
            blank_line_before_additions: true,
            preserve_bom: true,
            eol: Eol::Auto,
        }
    }
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchResult {
    pub content: String,
    pub changed: bool,
    pub written_keys: Vec<String>,
    pub added_keys: Vec<String>,
    pub deleted_keys: Vec<String>,
    pub removed_duplicate_keys: Vec<String>,
    pub restored_commented_keys: Vec<String>,
}
/// Additions follow request order; caller-specific collation belongs to the outer API.
/// Plan edits in memory. The final content and change lists can be inspected
/// before a caller chooses whether to persist them.
pub fn patch(content: &str, patches: &[Patch], options: &PatchOptions) -> Result<PatchResult> {
    let document = Document::parse(content);
    // IndexMap preserves first insertion order while later operations for the
    // same key replace earlier ones, matching last-request-wins semantics.
    let desired = patches.iter().map(|patch| (patch.key(), patch)).collect();
    let mut editor = PatchEditor::new(&document, desired, options);
    for line in &document.parsed_lines {
        editor.visit_line(line)?;
    }
    editor.append_missing_values()?;
    let rendered = document
        .document
        .render(&editor.lines, options.preserve_bom, options.eol);
    if rendered == content {
        return Ok(PatchResult {
            content: rendered,
            ..Default::default()
        });
    }
    editor.result.content = rendered;
    editor.result.changed = true;
    Ok(editor.result)
}

/// Tracks edits by original line number so dropping one duplicate multiline
/// assignment cannot accidentally remove the continuation of another occurrence.
struct PatchEditor<'a> {
    desired: IndexMap<&'a str, &'a Patch>,
    options: &'a PatchOptions,
    last_match: IndexMap<String, usize>,
    consumed_keys: HashSet<String>,
    replaced_entries: HashSet<usize>,
    lines: Vec<String>,
    result: PatchResult,
}

impl<'a> PatchEditor<'a> {
    fn new(
        document: &Document,
        desired: IndexMap<&'a str, &'a Patch>,
        options: &'a PatchOptions,
    ) -> Self {
        let last_match = document
            .parsed_lines
            .iter()
            .filter_map(|line| {
                matching_entry(line, options.match_commented)
                    .map(|entry| (entry.key.clone(), line.line_number))
            })
            .collect();
        Self {
            desired,
            options,
            last_match,
            consumed_keys: HashSet::new(),
            replaced_entries: HashSet::new(),
            lines: Vec::new(),
            result: PatchResult::default(),
        }
    }

    fn visit_line(&mut self, line: &Line) -> Result<()> {
        if let LineKind::Continuation { entry_line_number } = line.kind
            && self.replaced_entries.contains(&entry_line_number)
        {
            return Ok(());
        }
        let Some(entry) = matching_entry(line, self.options.match_commented) else {
            self.keep_line(line);
            return Ok(());
        };
        let Some(&patch) = self.desired.get(entry.key.as_str()) else {
            self.keep_line(line);
            return Ok(());
        };
        if self.options.ignored_keys.contains(&entry.key) {
            self.keep_line(line);
            return Ok(());
        }
        if matches!(self.options.update, Update::Last)
            && self.last_match.get(&entry.key) != Some(&line.line_number)
        {
            self.visit_earlier_occurrence(line, entry);
            return Ok(());
        }
        self.consumed_keys.insert(entry.key.clone());
        match patch {
            Patch::Delete { .. } => {
                self.result.deleted_keys.push(entry.key.clone());
                self.replaced_entries.insert(line.line_number);
            }
            Patch::Set { value, .. } => self.replace_value(line, entry, value)?,
        }
        Ok(())
    }

    fn keep_line(&mut self, line: &Line) {
        self.lines.push(line.raw_line.clone());
    }

    fn visit_earlier_occurrence(&mut self, line: &Line, entry: &Entry) {
        if self.options.remove_duplicate_entries && matches!(line.kind, LineKind::Entry(_)) {
            self.result.removed_duplicate_keys.push(entry.key.clone());
            self.replaced_entries.insert(line.line_number);
        } else {
            self.keep_line(line);
        }
    }

    fn replace_value(&mut self, line: &Line, entry: &Entry, value: &str) -> Result<()> {
        if matches!(line.kind, LineKind::Entry(_)) && entry.effective_value == value {
            self.keep_line(line);
            return Ok(());
        }
        let prefix = entry.active_prefix.as_ref().unwrap_or(&entry.prefix);
        self.lines.push(format!(
            "{prefix}{}{suffix}",
            format_value(value)?,
            suffix = entry.suffix
        ));
        self.replaced_entries.insert(line.line_number);
        self.result.written_keys.push(entry.key.clone());
        if entry.active_prefix.is_some() {
            self.result.restored_commented_keys.push(entry.key.clone());
        }
        Ok(())
    }

    fn append_missing_values(&mut self) -> Result<()> {
        let additions: Vec<_> = self
            .desired
            .values()
            .filter_map(|patch| match patch {
                Patch::Set { key, value }
                    if !self.consumed_keys.contains(key)
                        && !self.options.ignored_keys.contains(key) =>
                {
                    Some((key, value))
                }
                _ => None,
            })
            .collect();
        if self.options.blank_line_before_additions
            && !additions.is_empty()
            && self.lines.last().is_some_and(|line| !line.is_empty())
        {
            self.lines.push(String::new());
        }
        for (key, value) in additions {
            self.lines.push(format!("{key}={}", format_value(value)?));
            self.result.written_keys.push(key.clone());
            self.result.added_keys.push(key.clone());
        }
        Ok(())
    }
}

fn matching_entry(line: &Line, match_commented: bool) -> Option<&Entry> {
    match &line.kind {
        LineKind::Entry(entry) => Some(entry),
        LineKind::CommentedEntry(entry) if match_commented => Some(entry),
        _ => None,
    }
}
