//! Classify physical lines without discarding the text needed for later edits.
use super::syntax::{COMMENT_PREFIX, ENTRY_PREFIX, effective_values, is_escaped};
use crate::text::{is_whitespace, trim};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub key: String,
    pub prefix: String,
    pub separator: String,
    pub value_token: String,
    pub suffix: String,
    pub effective_value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_prefix: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LineKind {
    Empty,
    Comment,
    Entry(Entry),
    CommentedEntry(Entry),
    Continuation {
        #[serde(rename = "entryLineNumber")]
        entry_line_number: usize,
    },
    Invalid {
        reason: &'static str,
    },
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub line_number: usize,
    pub raw_line: String,
    #[serde(flatten)]
    pub kind: LineKind,
}
fn active_entry(raw: &str) -> Option<Entry> {
    let captures = ENTRY_PREFIX.captures(raw)?;
    let key = captures.name("key")?.as_str();
    let value = effective_values(raw).shift_remove(key)?;
    let prefix = captures.name("prefix")?.as_str();
    let rest = &raw[prefix.len()..];
    let (token, suffix) = split_value_suffix(rest);
    Some(Entry {
        key: key.into(),
        prefix: prefix.into(),
        separator: captures
            .name("equals")
            .or_else(|| captures.name("colon"))?
            .as_str()
            .into(),
        value_token: token.into(),
        suffix: suffix.into(),
        effective_value: value,
        active_prefix: None,
    })
}
// Keep whitespace preceding an inline comment with the suffix. Replacing only
// the value then leaves the user's alignment and comment text untouched.
fn split_value_suffix(rest: &str) -> (&str, &str) {
    let quote = rest
        .as_bytes()
        .first()
        .copied()
        .filter(|b| matches!(b, b'\'' | b'"' | b'`'));
    let mut closed = quote.is_none();
    let mut end = rest.len();
    for (i, b) in rest.bytes().enumerate() {
        if !closed {
            if i > 0 && Some(b) == quote && !is_escaped(rest, i) {
                closed = true;
            }
            continue;
        }
        if b == b'#' {
            end = i;
            break;
        }
    }
    let token = rest[..end].trim_end_matches(is_whitespace);
    (token, &rest[token.len()..])
}

fn commented_entry(raw: &str) -> Option<Entry> {
    let captures = COMMENT_PREFIX.captures(raw)?;
    let mut entry = active_entry(&captures["body"])?;
    let comment_prefix = &captures["prefix"];
    let indentation: String = comment_prefix
        .chars()
        .take_while(|character| is_whitespace(*character))
        .collect();
    entry.active_prefix = Some(format!("{indentation}{}", entry.prefix));
    entry.prefix = format!("{comment_prefix}{}", entry.prefix);
    Some(entry)
}

pub fn parse_line(raw: &str, line_number: usize) -> Line {
    let stripped = trim(raw);
    let kind = if stripped.is_empty() {
        LineKind::Empty
    } else if stripped.starts_with('#') {
        commented_entry(raw).map_or(LineKind::Comment, LineKind::CommentedEntry)
    } else if let Some(entry) = active_entry(raw) {
        LineKind::Entry(entry)
    } else {
        LineKind::Invalid {
            reason: "not valid dotenv assignment syntax",
        }
    };
    Line {
        line_number,
        raw_line: raw.into(),
        kind,
    }
}
