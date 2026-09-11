use super::{source::load_source, transform::transform};
use crate::{
    config::{KeyRef, Rule, RuleOptions, Severity},
    error::{Diagnostic, Error, Result},
    resolve::{Context, Environment, select_build},
    text::trim,
};
use indexmap::IndexMap;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Finding {
    pub ok: bool,
    pub severity: Severity,
    #[serde(rename = "type")]
    pub rule_type: &'static str,
    pub label: String,
    pub message: String,
}
#[derive(Debug, Default, Serialize)]
pub struct Summary {
    pub ok: usize,
    pub warnings: usize,
    pub errors: usize,
}
#[derive(Debug, Serialize)]
pub struct CheckResult {
    pub ok: bool,
    pub check: String,
    pub build: String,
    pub findings: Vec<Finding>,
    pub summary: Summary,
}

pub fn run_check(
    context: &Context<'_>,
    name: &str,
    build: Option<&str>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<CheckResult> {
    let config = &context.loaded.config;
    let check = config
        .checks
        .as_ref()
        .and_then(|checks| checks.get(name))
        .ok_or_else(|| Error::new("UNKNOWN_ENV_CHECK", format!("Unknown env check '{name}'.")))?;
    let build = select_build(build, &config.selector, context.process_env, diagnostics)?;
    let mut sources = IndexMap::new();
    for (name, source) in &check.sources {
        sources.insert(
            name.clone(),
            load_source(context, name, source, &build, diagnostics)?,
        );
    }
    let findings = check
        .rules
        .iter()
        .map(|rule| evaluate(rule, &sources))
        .collect::<Result<Vec<_>>>()?;
    let mut summary = Summary::default();
    for finding in &findings {
        if finding.ok {
            summary.ok += 1;
        } else if matches!(finding.severity, Severity::Warn) {
            summary.warnings += 1;
        } else {
            summary.errors += 1;
        }
    }
    Ok(CheckResult {
        ok: summary.errors == 0,
        check: name.into(),
        build,
        findings,
        summary,
    })
}

fn source<'a>(sources: &'a IndexMap<String, Environment>, name: &str) -> Result<&'a Environment> {
    sources.get(name).ok_or_else(|| {
        Error::new(
            "UNKNOWN_ENV_CHECK_SOURCE",
            format!("Unknown env check source: {name}"),
        )
    })
}
fn value<'a>(sources: &'a IndexMap<String, Environment>, reference: &KeyRef) -> Result<&'a str> {
    Ok(source(sources, &reference.source)?
        .get(&reference.key)
        .map(String::as_str)
        .unwrap_or(""))
}
fn finding(
    ok: bool,
    kind: &'static str,
    options: &RuleOptions,
    label: String,
    message: String,
) -> Finding {
    Finding {
        ok,
        rule_type: kind,
        severity: options.severity.clone().unwrap_or(Severity::Error),
        label: options.label.clone().unwrap_or(label),
        message,
    }
}
fn evaluate(rule: &Rule, sources: &IndexMap<String, Environment>) -> Result<Finding> {
    match rule {
        Rule::Required {
            source: name,
            key,
            options,
        } => {
            let values = source(sources, name)?;
            let ok = values.get(key).is_some_and(|value| !trim(value).is_empty());
            let message = if ok {
                format!("{name} has {key}")
            } else {
                format!("{name} missing required {key}")
            };
            Ok(finding(
                ok,
                "required",
                options,
                format!("{name}.{key} required"),
                message,
            ))
        }
        Rule::RequiredAny {
            source: name,
            keys,
            options,
        } => {
            let values = source(sources, name)?;
            let found = keys.iter().find(|key| {
                values
                    .get(*key)
                    .is_some_and(|value| !trim(value).is_empty())
            });
            let message = match found {
                Some(key) => format!("{name} has {key}"),
                None => format!("{name} missing required {}", keys.join(" or ")),
            };
            Ok(finding(
                found.is_some(),
                "requiredAny",
                options,
                format!("{name}.{} required", keys.join("|")),
                message,
            ))
        }
        Rule::Equals {
            left,
            right,
            options,
            transform: operation,
        } => {
            let left_value = transform(value(sources, left)?, operation.as_ref());
            let right_value = transform(value(sources, right)?, operation.as_ref());
            let label = options.label.clone().unwrap_or_else(|| {
                format!(
                    "{}.{} == {}.{}",
                    left.source, left.key, right.source, right.key
                )
            });
            let skipped = trim(&left_value).is_empty() || trim(&right_value).is_empty();
            let ok = !skipped && left_value == right_value;
            let outcome = if skipped {
                "skipped"
            } else if ok {
                "aligned"
            } else {
                "mismatch"
            };
            let mut result = finding(
                ok,
                "equals",
                options,
                label.clone(),
                format!("{label} {outcome}"),
            );
            if skipped && options.severity.is_none() {
                result.severity = Severity::Warn;
            }
            Ok(result)
        }
    }
}
