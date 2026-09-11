//! Effective-value grammar and quoting shared by parsing and patch rendering.
use crate::{
    error::{Error, Result},
    text::trim,
};
use indexmap::IndexMap;
use regex::Regex;
use std::sync::LazyLock;

// Deliberately implement the frozen dotenv grammar, rather than adopting a dotenv crate.
// ECMAScript whitespace differs from Rust Unicode whitespace (notably BOM and NEL).
const ECMASCRIPT_WHITESPACE: &str = r"[\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";
// Alternation order is intentional: quoted tokens are attempted before the
// unquoted fallback. Escaped quotes follow dotenv's grammar, which differs from
// the backslash-parity rule used to locate editable multiline spans.
static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    compile_grammar(concat!(
        r"(?m)(?:^|[\u{2028}\u{2029}])\s*(?:export\s+)?",
        r"(?P<key>[A-Za-z0-9_.-]+)(?:\s*=\s*?|:\s+?)",
        r"(?P<value>",
        r"\s*'(?:\\'|[^'])*'|",
        r#"\s*"(?:\\"|[^"])*"|"#,
        r"\s*`(?:\\`|[^`])*`|",
        r"[^#\r\n]+)?",
        r"\s*(?:#[^\r\n\u{2028}\u{2029}]*)?",
        r"(?:$|[\u{2028}\u{2029}])",
    ))
});

pub(super) static ENTRY_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    compile_grammar(concat!(
        r"^(?P<prefix>\s*(?:export\s+)?(?P<key>[A-Za-z0-9_.-]+)\s*",
        r"(?:(?P<equals>=)\s*|(?P<colon>:)\s+))",
    ))
});

pub(super) static COMMENT_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| compile_grammar(r"^(?P<prefix>\s*#\s*)(?P<body>[^\r\n\u{2028}\u{2029}]*)$"));

fn compile_grammar(pattern: &str) -> Regex {
    Regex::new(&pattern.replace(r"\s", ECMASCRIPT_WHITESPACE))
        .expect("built-in dotenv grammar must be valid")
}

pub(super) fn is_escaped(s: &str, i: usize) -> bool {
    s.as_bytes()[..i]
        .iter()
        .rev()
        .take_while(|b| **b == b'\\')
        .count()
        % 2
        == 1
}

// dotenv strips matching quotes with multiline anchors after token matching.
// This can strip a quoted inner line even when the entire token is unquoted.
// Keep this separate from quote termination used by the editable line model.
fn strip_quotes(raw: &str) -> String {
    let mut result = String::new();
    let mut copied = 0;
    for (start, quote) in raw.char_indices() {
        if start < copied || !matches!(quote, '\'' | '"' | '`') {
            continue;
        }
        if start > 0 && !raw[..start].ends_with(['\n', '\r', '\u{2028}', '\u{2029}']) {
            continue;
        }
        let end = raw
            .char_indices()
            .rev()
            .find(|(i, c)| {
                *i > start
                    && *c == quote
                    && (*i + 1 == raw.len()
                        || raw[*i + 1..].starts_with(['\n', '\r', '\u{2028}', '\u{2029}']))
            })
            .map(|(i, _)| i);
        if let Some(end) = end {
            result.push_str(&raw[copied..start]);
            result.push_str(&raw[start + 1..end]);
            copied = end + 1;
        }
    }
    result.push_str(&raw[copied..]);
    result
}

/// Parse last-wins values while retaining each key's first insertion position.
pub fn effective_values(content: &str) -> IndexMap<String, String> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut values = IndexMap::new();
    let mut offset = 0;
    while let Some(captures) = ASSIGNMENT.captures_at(&normalized, offset) {
        let matched = captures
            .get(0)
            .expect("assignment match contains its full span");
        offset = matched.end();
        if matched.as_str().ends_with(['\u{2028}', '\u{2029}']) {
            // Rust anchors only recognize LF. The grammar explicitly consumes
            // Unicode line separators; reconsider that boundary as the start of
            // the next assignment rather than skipping it.
            offset -= '\u{2028}'.len_utf8();
        }
        if offset <= matched.start() {
            offset = matched.end();
        }
        let raw = trim(captures.name("value").map_or("", |m| m.as_str()));
        let quote = raw.as_bytes().first().copied();
        let mut value = strip_quotes(raw);
        if quote == Some(b'"') {
            value = value.replace("\\n", "\n").replace("\\r", "\r");
        }
        values.insert(captures["key"].to_owned(), value);
    }
    values
}

/// Choose a spelling by reparsing it; never silently change a requested value.
pub fn format_value(value: &str) -> Result<String> {
    let candidates = [
        value.to_owned(),
        format!("\"{}\"", value.replace('\r', "\\r").replace('\n', "\\n")),
        format!("'{value}'"),
        format!("`{value}`"),
    ];
    for candidate in candidates {
        if effective_values(&format!("ENV_LANE_VALUE={candidate}"))
            .get("ENV_LANE_VALUE")
            .is_some_and(|v| v == value)
        {
            return Ok(candidate);
        }
    }
    Err(Error::new(
        "UNREPRESENTABLE_ENV_VALUE",
        "Value cannot be represented by dotenv without changing its effective value.",
    ))
}
