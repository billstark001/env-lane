//! A document retains physical lines separately from effective dotenv values.
//! Multiple consumers use this model so resolving, checking and editing agree.
mod line;
mod patch;
mod syntax;
mod text;

pub use line::{Entry, Line, LineKind, parse_line};
pub use patch::{Patch, PatchOptions, PatchResult, Update, patch};
pub use syntax::{effective_values, format_value};
pub use text::{Eol, TextDocument};

use indexmap::IndexMap;
use serde::Serialize;
use syntax::is_escaped;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueSource {
    pub effective_value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_number: Option<usize>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Occurrence {
    pub effective_value: String,
    pub prefix: String,
    pub line_number: usize,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub document: TextDocument,
    pub parsed_lines: Vec<Line>,
    pub current_map: IndexMap<String, ValueSource>,
    pub occurrences_map: IndexMap<String, Vec<Occurrence>>,
    pub invalid_line_count: usize,
    pub shadowed_entry_count: usize,
}
impl Document {
    pub fn parse(content: &str) -> Self {
        let document = TextDocument::parse(content);
        let mut parsed_lines: Vec<_> = document
            .lines
            .iter()
            .enumerate()
            .map(|(i, l)| parse_line(l, i + 1))
            .collect();
        mark_multiline_continuations(&mut parsed_lines);
        let mut current_map = IndexMap::new();
        let mut occurrences_map: IndexMap<String, Vec<Occurrence>> = IndexMap::new();
        let mut invalid_line_count = 0;
        let mut shadowed_entry_count = 0;
        for line in &parsed_lines {
            match &line.kind {
                LineKind::Entry(entry) => {
                    occurrences_map
                        .entry(entry.key.clone())
                        .or_default()
                        .push(Occurrence {
                            effective_value: entry.effective_value.clone(),
                            prefix: entry.prefix.clone(),
                            line_number: line.line_number,
                        });
                    if current_map
                        .insert(
                            entry.key.clone(),
                            ValueSource {
                                effective_value: entry.effective_value.clone(),
                                line_number: Some(line.line_number),
                            },
                        )
                        .is_some()
                    {
                        shadowed_entry_count += 1;
                    }
                }
                LineKind::Invalid { .. } => invalid_line_count += 1,
                _ => {}
            }
        }
        let mut result = Self {
            document,
            parsed_lines,
            current_map,
            occurrences_map,
            invalid_line_count,
            shadowed_entry_count,
        };
        result.apply_effective_values(content);
        result
    }

    // Physical-line parsing preserves edit locations; whole-document parsing
    // supplies multiline values. Only the last occurrence receives the final value.
    fn apply_effective_values(&mut self, content: &str) {
        for (key, value) in effective_values(content) {
            let line_number = self.current_map.get(&key).and_then(|v| v.line_number);
            if let Some(occurrences) = self.occurrences_map.get_mut(&key) {
                occurrences.last_mut().unwrap().effective_value = value.clone();
            }
            if let Some(number) = line_number
                && let LineKind::Entry(entry) = &mut self.parsed_lines[number - 1].kind
            {
                entry.effective_value = value.clone();
            }
            self.current_map.insert(
                key,
                ValueSource {
                    effective_value: value,
                    line_number,
                },
            );
        }
    }
}

/// A continuation belongs to its opening entry even when its text resembles an
/// assignment. Editing that entry must remove its entire physical-line span.
fn mark_multiline_continuations(lines: &mut [Line]) {
    let mut index = 0;
    while index < lines.len() {
        let Some(end) = multiline_end(lines, index) else {
            index += 1;
            continue;
        };
        let entry_line_number = lines[index].line_number;
        for line in &mut lines[index + 1..=end] {
            line.kind = LineKind::Continuation { entry_line_number };
        }
        index = end + 1;
    }
}

fn multiline_end(lines: &[Line], start: usize) -> Option<usize> {
    let LineKind::Entry(entry) = &lines[start].kind else {
        return None;
    };
    let token = entry.value_token.trim_start_matches(is_whitespace);
    let quote = *token.as_bytes().first()?;
    if !matches!(quote, b'\'' | b'"' | b'`') || has_closing_quote(token, quote, 1) {
        return None;
    }
    (start + 1..lines.len()).find(|index| has_closing_quote(&lines[*index].raw_line, quote, 0))
}

fn has_closing_quote(text: &str, quote: u8, start: usize) -> bool {
    text.bytes()
        .enumerate()
        .skip(start)
        .any(|(index, byte)| byte == quote && !is_escaped(text, index))
}
use crate::text::is_whitespace;
