//! Output policy is explicit and shared by all native command presentations.
use env_lane_core::{
    config::OutputFormat,
    error::{Diagnostic, Error, Result, Severity},
};
use serde::Serialize;
use std::io::{self, Write};

pub struct Output {
    pub format: OutputFormat,
    pub prefix: bool,
}
impl Output {
    pub fn is_json(&self) -> bool {
        matches!(self.format, OutputFormat::Json)
    }
    pub fn line(&self, value: impl std::fmt::Display) -> Result<()> {
        writeln!(io::stdout().lock(), "{value}").map_err(output_error)
    }
    pub fn json(&self, value: &impl Serialize) -> Result<()> {
        self.line(
            serde_json::to_string_pretty(value)
                .map_err(|error| Error::new("OUTPUT_FAILED", error.to_string()))?,
        )
    }
    pub fn require_text_or_json(&self, message: &str) -> Result<()> {
        if matches!(self.format, OutputFormat::Dotenv) {
            Err(Error::new("UNSUPPORTED_OUTPUT_FORMAT", message))
        } else {
            Ok(())
        }
    }
    pub fn diagnostic(&self, event: &Diagnostic) -> Result<()> {
        let level = match event.severity {
            Severity::Info => "info",
            Severity::Warn => "warning",
            Severity::Error => "error",
        };
        let prefix = if self.prefix { "[env-lane] " } else { "" };
        let mut stderr = io::stderr().lock();
        for line in event.message.split('\n') {
            writeln!(stderr, "{prefix}{level} {}: {line}", event.code).map_err(output_error)?;
        }
        Ok(())
    }
    pub fn error(&self, error: &Error) -> Result<()> {
        if self.is_json() {
            self.json(&serde_json::json!({"ok": false, "error": error}))
        } else {
            self.diagnostic(&Diagnostic {
                code: error.code.into(),
                severity: Severity::Error,
                message: error.message.clone(),
                details: None,
            })
        }
    }
}
fn output_error(error: io::Error) -> Error {
    Error::new("OUTPUT_FAILED", error.to_string())
}
