//! Policy and selector check presentation.
use crate::output::Output;
use env_lane_core::{
    check,
    config::Severity as PolicySeverity,
    error::{Diagnostic, Error, Result, Severity},
    policy,
    resolve::Context,
};

pub(super) fn execute(
    context: &Context<'_>,
    policy: Option<&str>,
    target: Option<&str>,
    build: Option<&str>,
    require_override: bool,
    output: &Output,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<i32> {
    match (policy, target) {
        (Some(_), Some(_)) => Err(Error::new(
            "INVALID_CHECK_SELECTION",
            "Use either --policy or --target, not both.",
        )),
        (None, None) => Err(Error::new(
            "MISSING_CHECK_SELECTION",
            "Missing check selection. Use --policy <name> or --target <target>.",
        )),
        (Some(name), None) => {
            let result = policy::run_check(context, name, build, diagnostics)?;
            output
                .require_text_or_json("The selected command does not support --format dotenv.")?;
            if output.is_json() {
                output.json(&result)?;
            } else {
                for finding in result.findings {
                    let prefix = if finding.ok {
                        "OK"
                    } else if matches!(finding.severity, PolicySeverity::Warn) {
                        "WARN"
                    } else {
                        "ERROR"
                    };
                    output.line(format!("[{prefix}] {}", finding.message))?;
                }
                output.line(format!(
                    "Summary: {} ok, {} warnings, {} errors.",
                    result.summary.ok, result.summary.warnings, result.summary.errors
                ))?;
            }
            Ok(i32::from(!result.ok))
        }
        (None, Some(target)) => {
            let result = check::check_selector(
                context,
                &check::CheckOptions {
                    target: Some(target),
                    build,
                    require_override: require_override.then_some(true),
                },
                diagnostics,
            )?;
            if output.is_json() {
                output.json(&result)?;
            } else if result.ok {
                output.require_text_or_json(
                    "The selected command does not support --format dotenv.",
                )?;
                output.line(format!(
                    "OK: {} is absent from dotenv files.",
                    result.selector_key
                ))?;
            } else {
                report_selector_findings(&result, output)?;
            }
            Ok(i32::from(!result.ok))
        }
    }
}

fn report_selector_findings(result: &check::CheckResult, output: &Output) -> Result<()> {
    if !result.violations.is_empty() {
        let locations = result
            .violations
            .iter()
            .map(|violation| {
                format!(
                    "  {}{}",
                    violation.relative_file,
                    violation
                        .line
                        .map(|line| format!(":{line}"))
                        .unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        output.diagnostic(&Diagnostic {
            code: "SELECTOR_IN_DOTENV".into(),
            severity: Severity::Error,
            message: format!(
                "{} must not be stored in dotenv files:\n{locations}",
                result.selector_key
            ),
            details: None,
        })?;
    }
    if !result.missing_required.is_empty() {
        let locations = result
            .missing_required
            .iter()
            .map(|file| format!("  {}: {}", file.target, file.relative_file))
            .collect::<Vec<_>>()
            .join("\n");
        output.diagnostic(&Diagnostic {
            code: "MISSING_REQUIRED_ENV_FILE".into(),
            severity: Severity::Error,
            message: format!("Missing required env file(s):\n{locations}"),
            details: None,
        })?;
    }
    Ok(())
}
