//! Template comments establish layout; unmatched env comments travel with values.
use super::layout::blank;
use crate::{
    document::{LineKind, parse_line},
    text::{is_whitespace, trim},
};
use std::collections::HashSet;

pub(super) fn normalize_blank_lines(lines: Vec<String>) -> Vec<String> {
    let mut output: Vec<String> = Vec::new();
    for line in lines {
        if blank(&line) && output.last().is_some_and(|last| blank(last)) {
            continue;
        }
        output.push(line);
    }
    output
}
fn comment_set(lines: &[String]) -> HashSet<&str> {
    lines
        .iter()
        .filter(|line| matches!(parse_line(line, 1).kind, LineKind::Comment))
        .map(|line| trim(line))
        .collect()
}
pub(super) fn partition_preamble(
    template: &[String],
    env: &[String],
) -> (Vec<String>, Vec<String>) {
    let env = normalize_blank_lines(env.to_vec());
    let comments = comment_set(template);
    let mut matched = Vec::new();
    let mut extras = Vec::new();
    for line in env {
        if matches!(parse_line(&line, 1).kind, LineKind::Comment) && comments.contains(trim(&line))
        {
            matched.push(line);
        } else if !blank(&line) {
            extras.push(line);
        }
    }
    (matched, extras)
}
pub(super) fn merge_leading(template: &[String], env: &[String]) -> Vec<String> {
    let mut merged = normalize_blank_lines(template.to_vec());
    if merged.is_empty() {
        return normalize_blank_lines(env.to_vec());
    }
    let comments = comment_set(template);
    let extras = normalize_blank_lines(
        env.iter()
            .filter(|line| {
                !blank(line)
                    && !(matches!(parse_line(line, 1).kind, LineKind::Comment)
                        && comments.contains(trim(line)))
            })
            .cloned()
            .collect(),
    );
    if extras.is_empty() {
        return merged;
    }
    if !merged.last().is_none_or(|line| blank(line)) && !blank(&extras[0]) {
        merged.push(String::new());
    }
    merged.extend(extras);
    normalize_blank_lines(merged)
}
pub(super) fn comment_out(line: &str) -> String {
    match parse_line(line, 1).kind {
        LineKind::CommentedEntry(_) => line.into(),
        LineKind::Entry(entry) => {
            let indentation = entry
                .prefix
                .chars()
                .take_while(|character| is_whitespace(*character))
                .collect::<String>();
            format!("{indentation}# {}", &line[indentation.len()..])
        }
        _ => format!("# {}", line.trim_start_matches(is_whitespace)),
    }
}
pub(super) fn render_unlisted_comment(value: &str) -> Vec<String> {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let lines = normalized.split('\n').collect::<Vec<_>>();
    let start = lines
        .iter()
        .position(|line| !blank(line))
        .unwrap_or(lines.len());
    let end = lines
        .iter()
        .rposition(|line| !blank(line))
        .map(|index| index + 1)
        .unwrap_or(start);
    lines[start..end]
        .iter()
        .map(|line| {
            if blank(line) {
                String::new()
            } else if line.trim_start_matches(is_whitespace).starts_with('#') {
                (*line).into()
            } else {
                format!("# {line}")
            }
        })
        .collect()
}
pub(super) fn remove_unlisted_comment(lines: &[String], comment: &[String]) -> Vec<String> {
    let mut lines = lines.to_vec();
    if comment.is_empty() || lines.len() < comment.len() {
        return lines;
    }
    for index in (0..=lines.len() - comment.len()).rev() {
        if lines.get(index..index + comment.len()) == Some(comment) {
            let start = if index > 0 && blank(&lines[index - 1]) {
                index - 1
            } else {
                index
            };
            lines.drain(start..index + comment.len());
        }
    }
    normalize_blank_lines(lines)
}
