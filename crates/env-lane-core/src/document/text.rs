//! Physical text layout: BOM, line endings, and final-newline preservation.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocument {
    pub has_bom: bool,
    pub eol: String,
    pub has_final_newline: bool,
    pub lines: Vec<String>,
}
impl TextDocument {
    pub fn parse(content: &str) -> Self {
        let raw = content.strip_prefix('\u{feff}').unwrap_or(content);
        let has_final_newline = raw.ends_with('\n');
        let mut lines: Vec<_> = if raw.is_empty() {
            vec![]
        } else {
            raw.split('\n')
                .map(|s| s.strip_suffix('\r').unwrap_or(s).to_owned())
                .collect()
        };
        // Only CR directly preceding LF is an EOL; a terminal bare CR is content.
        if !has_final_newline && raw.ends_with('\r') {
            lines.last_mut().unwrap().push('\r');
        }
        if has_final_newline {
            lines.pop();
        }
        Self {
            has_bom: raw.len() != content.len(),
            eol: if raw.contains("\r\n") { "\r\n" } else { "\n" }.into(),
            has_final_newline,
            lines,
        }
    }
    pub fn render(&self, lines: &[String], preserve_bom: bool, eol: Eol) -> String {
        let sep = match eol {
            Eol::Auto => &self.eol,
            Eol::Lf => "\n",
            Eol::Crlf => "\r\n",
        };
        let mut out = if self.has_bom && preserve_bom {
            "\u{feff}".to_owned()
        } else {
            String::new()
        };
        out.push_str(&lines.join(sep));
        if !lines.is_empty() && self.has_final_newline {
            out.push_str(sep);
        }
        out
    }
}
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    #[default]
    Auto,
    Lf,
    Crlf,
}
