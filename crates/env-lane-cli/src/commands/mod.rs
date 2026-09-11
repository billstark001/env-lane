//! Dispatch uses shared application contexts; each command owns only presentation.
mod check;
mod inspect;
mod sort;
mod sync;
use crate::{
    arguments::{Cli, Operation},
    output::Output,
};
use env_lane_core::{
    error::{Diagnostic, Error, Result, Severity},
    resolve::{Context, Options},
    run::{self, WorkingDirectory},
};

pub fn execute(
    cli: &Cli,
    context: &Context<'_>,
    output: &Output,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<i32> {
    match &cli.command {
        Operation::Packages
        | Operation::ResolveTarget { .. }
        | Operation::Files { .. }
        | Operation::Print { .. } => inspect::execute(cli, context, output, diagnostics),
        Operation::Run {
            target,
            run_cwd,
            quiet,
            command,
        } => {
            if !matches!(output.format, env_lane_core::config::OutputFormat::Text) {
                return Err(Error::new(
                    "UNSUPPORTED_OUTPUT_FORMAT",
                    "The run command supports only text output because the child process owns stdout.",
                ));
            }
            let directory = match run_cwd.as_deref() {
                None => WorkingDirectory::Target,
                Some(path)
                    if path.as_os_str().is_empty() || path == std::path::Path::new("target") =>
                {
                    WorkingDirectory::Target
                }
                Some(path) if path == std::path::Path::new("root") => WorkingDirectory::ProjectRoot,
                Some(path) => WorkingDirectory::Path(path),
            };
            let prepared = run::prepare(
                context,
                &Options {
                    target: Some(target),
                    build: cli.common.build.as_deref(),
                    ..Default::default()
                },
                command,
                directory,
                diagnostics,
            )?;
            for event in diagnostics.drain(..) {
                output.diagnostic(&event)?;
            }
            if !quiet {
                let resolved = &prepared.environment;
                let loaded = resolved
                    .files
                    .iter()
                    .filter(|file| file.exists)
                    .map(|file| file.relative_path.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                output.diagnostic(&Diagnostic {
                    code: "RUN_SUMMARY".into(),
                    severity: Severity::Info,
                    message: format!(
                        "target={} build={} loaded={}",
                        resolved
                            .target
                            .name
                            .as_ref()
                            .unwrap_or(&resolved.target.relative_dir),
                        resolved.build,
                        if loaded.is_empty() { "<none>" } else { &loaded }
                    ),
                    details: None,
                })?;
            }
            crate::process::execute(&prepared)
        }
        Operation::Check {
            policy,
            target,
            require_override,
        } => check::execute(
            context,
            policy.as_deref(),
            target.as_deref(),
            cli.common.build.as_deref(),
            *require_override,
            output,
            diagnostics,
        ),
        Operation::Sync {
            name,
            dry_run,
            show_secrets,
        } => sync::execute(
            context,
            name,
            cli.common.build.as_deref(),
            *dry_run,
            *show_secrets,
            output,
            diagnostics,
        ),
        Operation::SortFile {
            env_file,
            template_file,
            options,
        } => sort::file(context, env_file, template_file, options, output),
        Operation::Sort {
            key,
            env_suffix,
            options,
        } => sort::configured(
            context,
            key.as_deref(),
            env_suffix.as_deref(),
            options,
            output,
        ),
    }
}
