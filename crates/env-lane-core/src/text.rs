//! Text operations used by selection, transforms and document layout.
//! The whitespace set is the established data contract: BOM counts as whitespace,
//! while NEL does not. Rust's built-in Unicode trim uses a different set.
pub fn is_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_whitespace)
}
