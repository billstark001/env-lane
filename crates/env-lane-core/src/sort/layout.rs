//! Turn physical lines into movable key blocks without detaching their comments
//! or multiline continuations. Duplicate groups retain last-wins entry order.
use super::comments::normalize_blank_lines;
use crate::{
    document::{Document, LineKind, effective_values},
    text::trim,
};
use indexmap::IndexMap;

#[derive(Clone)]
pub(super) struct Block {
    pub key: String,
    pub active: bool,
    pub value: String,
    pub lines: Vec<String>,
    pub leading: Vec<String>,
    pub order: usize,
}
pub(super) struct Layout {
    pub preamble: Vec<String>,
    pub blocks: Vec<Block>,
    pub suffix: Vec<String>,
}
pub(super) struct Group {
    pub key: String,
    pub order: usize,
    pub count: usize,
    pub leading: Vec<String>,
    pub lines: Vec<String>,
}
impl Layout {
    pub fn from_document(document: &Document) -> Self {
        let mut layout = Self {
            preamble: Vec::new(),
            blocks: Vec::new(),
            suffix: Vec::new(),
        };
        let mut pending = Vec::new();
        let mut skip_until = 0;
        for (index, line) in document.parsed_lines.iter().enumerate() {
            if index < skip_until {
                continue;
            }
            match &line.kind {
                LineKind::Continuation { .. } => {
                    if let Some(block) = layout.blocks.last_mut() {
                        block.lines.push(line.raw_line.clone());
                    }
                }
                LineKind::Entry(entry) | LineKind::CommentedEntry(entry) => {
                    if layout.blocks.is_empty() {
                        layout.preamble = std::mem::take(&mut pending);
                    }
                    let (value, lines) = if matches!(line.kind, LineKind::CommentedEntry(_)) {
                        commented_multiline(document, index, &entry.key).unwrap_or_else(|| {
                            (entry.effective_value.clone(), vec![line.raw_line.clone()])
                        })
                    } else {
                        (entry.effective_value.clone(), vec![line.raw_line.clone()])
                    };
                    skip_until = index + lines.len();
                    layout.blocks.push(Block {
                        key: entry.key.clone(),
                        active: matches!(line.kind, LineKind::Entry(_)),
                        value,
                        lines,
                        leading: std::mem::take(&mut pending),
                        order: layout.blocks.len(),
                    });
                }
                _ => pending.push(line.raw_line.clone()),
            }
        }
        if layout.blocks.is_empty() {
            layout.preamble = pending;
        } else {
            layout.suffix = pending;
        }
        for block in &mut layout.blocks {
            if block.active
                && block.lines.len() > 1
                && let Some(value) = effective_values(&block.lines.join("\n")).get(&block.key)
            {
                block.value.clone_from(value);
            }
        }
        layout
    }
}

pub(super) fn group_blocks(blocks: &[Block]) -> IndexMap<String, Group> {
    let mut by_key: IndexMap<&str, Vec<&Block>> = IndexMap::new();
    for block in blocks {
        by_key.entry(&block.key).or_default().push(block);
    }
    let mut groups = Vec::new();
    for (key, blocks) in by_key {
        let has_value = blocks
            .iter()
            .any(|block| block.active || !block.value.is_empty());
        let retained = blocks
            .iter()
            .filter(|block| block.active || !block.value.is_empty() || !has_value)
            .collect::<Vec<_>>();
        let Some(first) = retained.first() else {
            continue;
        };
        groups.push(Group {
            key: key.into(),
            order: first.order,
            count: retained.len(),
            leading: normalize_blank_lines(
                blocks
                    .iter()
                    .flat_map(|block| block.leading.iter().cloned())
                    .collect(),
            ),
            lines: retained
                .iter()
                .flat_map(|block| block.lines.iter().cloned())
                .collect(),
        });
    }
    groups.sort_by_key(|group| group.order);
    groups
        .into_iter()
        .map(|group| (group.key.clone(), group))
        .collect()
}

pub(super) fn blank(line: &str) -> bool {
    trim(line).is_empty()
}

// Sort-generated inactive multiline defaults retain a comment marker on every
// physical line. Parse their uncommented span solely to identify its value and
// continuation boundary; the general document API keeps its existing grammar.
fn commented_multiline(
    document: &Document,
    start: usize,
    key: &str,
) -> Option<(String, Vec<String>)> {
    let original = &document.document.lines[start..];
    let uncommented = original
        .iter()
        .map_while(|line| uncomment(line))
        .collect::<Vec<_>>();
    let parsed = Document::parse(&uncommented.join("\n"));
    let count = 1 + parsed
        .parsed_lines
        .iter()
        .skip(1)
        .take_while(|line| {
            matches!(
                line.kind,
                LineKind::Continuation {
                    entry_line_number: 1
                }
            )
        })
        .count();
    if count < 2 {
        return None;
    }
    Some((
        effective_values(&uncommented[..count].join("\n"))
            .get(key)?
            .clone(),
        original[..count].to_vec(),
    ))
}

pub(super) fn uncomment(line: &str) -> Option<&str> {
    let body = line.trim_start().strip_prefix('#')?;
    Some(body.strip_prefix(' ').unwrap_or(body))
}
