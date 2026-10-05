use super::{
    Action, Operation, SortOptions, Summary,
    comments::{
        comment_out, merge_leading, normalize_blank_lines, partition_preamble,
        remove_unlisted_comment, render_unlisted_comment,
    },
    layout::{Layout, blank, group_blocks},
};
use crate::document::{Document, Eol};
use std::collections::HashSet;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub changed: bool,
    pub current_content: String,
    pub next_content: String,
    pub operations: Vec<Operation>,
    pub summary: Summary,
}
pub fn build_plan(content: Option<&str>, template: &str, options: &SortOptions) -> Plan {
    let env = Document::parse(content.unwrap_or(""));
    let template = Document::parse(template);
    let mut env_layout = Layout::from_document(&env);
    let template_layout = Layout::from_document(&template);
    if let Some(first) = env_layout.blocks.first_mut() {
        let (matched, extras) = partition_preamble(&template_layout.preamble, &env_layout.preamble);
        env_layout.preamble = matched;
        if !extras.is_empty() {
            first.leading =
                normalize_blank_lines(extras.into_iter().chain(first.leading.clone()).collect());
        }
    }
    let groups = group_blocks(&env_layout.blocks);
    let mut lines = merge_leading(&template_layout.preamble, &env_layout.preamble);
    let mut seen = HashSet::new();
    let mut consumed = HashSet::new();
    let mut operations = Vec::new();
    let mut order = 0;
    for block in &template_layout.blocks {
        if !seen.insert(block.key.clone()) {
            continue;
        }
        if let Some(group) = groups.get(&block.key) {
            consumed.insert(group.key.clone());
            lines.extend(merge_leading(&block.leading, &group.leading));
            lines.extend(group.lines.clone());
            if group.order != order {
                operations.push(Operation {
                    action: Action::Move,
                    key: group.key.clone(),
                });
            }
            if group.count > 1 {
                operations.push(Operation {
                    action: Action::GroupDuplicate,
                    key: group.key.clone(),
                });
            }
        } else {
            lines.extend(block.leading.clone());
            lines.extend(block.lines.iter().map(|line| comment_out(line)));
            operations.push(Operation {
                action: Action::InsertCommented,
                key: block.key.clone(),
            });
        }
        order += 1;
    }
    let unlisted = render_unlisted_comment(&options.unlisted_variables_comment);
    let mut unlisted_rendered = false;
    for group in groups
        .values()
        .filter(|group| !consumed.contains(&group.key))
    {
        let is_extra = !seen.contains(&group.key);
        let leading = if is_extra {
            remove_unlisted_comment(&group.leading, &unlisted)
        } else {
            group.leading.clone()
        };
        if is_extra && !unlisted_rendered && !unlisted.is_empty() {
            if lines.last().is_some_and(|line| !blank(line)) {
                lines.push(String::new());
            }
            lines.extend(unlisted.clone());
            unlisted_rendered = true;
        }
        lines.extend(leading);
        lines.extend(group.lines.clone());
        operations.push(Operation {
            action: if is_extra {
                Action::AppendExtra
            } else {
                Action::AppendDuplicate
            },
            key: group.key.clone(),
        });
    }
    lines.extend(merge_leading(&template_layout.suffix, &env_layout.suffix));
    let render_document = if content.is_some() {
        &env.document
    } else {
        &template.document
    };
    let current_content = if content.is_some() {
        env.document.render(&env.document.lines, true, Eol::Auto)
    } else {
        String::new()
    };
    let next_content = render_document.render(&lines, options.preserve_bom, options.eol);
    let summary = Summary::from_operations(&operations);
    Plan {
        changed: current_content != next_content,
        current_content,
        next_content,
        operations,
        summary,
    }
}
