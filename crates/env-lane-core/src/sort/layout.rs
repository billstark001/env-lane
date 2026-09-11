//! Turn physical lines into movable key blocks without detaching their comments
//! or multiline continuations. Duplicate groups retain last-wins entry order.
use super::comments::normalize_blank_lines;
use crate::{
    document::{Document, LineKind},
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
        for line in &document.parsed_lines {
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
                    layout.blocks.push(Block {
                        key: entry.key.clone(),
                        active: matches!(line.kind, LineKind::Entry(_)),
                        value: entry.effective_value.clone(),
                        lines: vec![line.raw_line.clone()],
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
                    .flat_map(|block| block.leading.clone())
                    .collect(),
            ),
            lines: retained
                .iter()
                .flat_map(|block| block.lines.clone())
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
