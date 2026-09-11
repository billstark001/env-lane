use crate::{
    arguments::{Cli, Operation},
    output::Output,
};
use env_lane_core::{
    config::OutputFormat,
    document::format_value,
    error::{Diagnostic, Result},
    redaction::{self, Options as RedactionOptions},
    resolve::{Context, FileKind, FileRef, Options, ValueOrigin},
    workspace,
};
use serde_json::json;

pub(super) fn execute(
    cli: &Cli,
    context: &Context<'_>,
    output: &Output,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<i32> {
    match &cli.command {
        Operation::Packages => {
            output
                .require_text_or_json("The selected command does not support --format dotenv.")?;
            if output.is_json() {
                output.json(&context.packages)?;
            } else {
                for package in context.packages {
                    output.line(format!(
                        "{}\t{}\t{}",
                        package.name.as_deref().unwrap_or("<unnamed>"),
                        package.relative_dir,
                        package.aliases.join(",")
                    ))?;
                }
            }
        }
        Operation::ResolveTarget { target } => {
            let package = workspace::resolve_target(
                context.packages,
                Some(target),
                &context.loaded.config.workspace.default_target,
                Some(&context.loaded.invocation_cwd),
            )?;
            output
                .require_text_or_json("The selected command does not support --format dotenv.")?;
            if output.is_json() {
                output.json(package)?;
            } else {
                output.line(format!(
                    "{} {}",
                    package.name.as_deref().unwrap_or("<unnamed>"),
                    package.dir.display()
                ))?;
            }
        }
        Operation::Files {
            target,
            require_override,
        } => {
            files(
                context,
                target.as_deref(),
                cli.common.build.as_deref(),
                *require_override,
                output,
                diagnostics,
            )?;
        }
        Operation::Print {
            target,
            show_secrets,
            include_shell,
            no_process_env,
        } => {
            let resolved = context.resolve(
                &Options {
                    target: Some(target),
                    build: cli.common.build.as_deref(),
                    include_process_env: Some(!no_process_env),
                    ..Default::default()
                },
                diagnostics,
            )?;
            let redaction = RedactionOptions {
                show_secrets: *show_secrets,
                ..Default::default()
            };
            let mut keys: Vec<_> = resolved
                .values
                .keys()
                .filter(|key| {
                    *include_shell
                        || !matches!(
                            resolved.sources.get(*key),
                            Some(ValueOrigin::Process {
                                shell_override: None | Some(false)
                            })
                        )
                })
                .collect();
            keys.sort();
            let mut result = serde_json::Map::new();
            for key in keys {
                let value = redaction::redact(key, &resolved.values[key], &redaction);
                match output.format {
                    OutputFormat::Json => {
                        result.insert(
                            key.clone(),
                            json!({"value":value,"source":resolved.sources[key]}),
                        );
                    }
                    OutputFormat::Text => output.line(format!("{key}={value}"))?,
                    OutputFormat::Dotenv => {
                        output.line(format!("{key}={}", format_value(value)?))?
                    }
                }
            }
            if output.is_json() {
                output.json(&result)?;
            }
        }
        _ => unreachable!("inspection dispatch"),
    }
    Ok(0)
}

fn files(
    context: &Context<'_>,
    target: Option<&str>,
    build: Option<&str>,
    require_override: bool,
    output: &Output,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<()> {
    let mut result = Vec::new();
    if target == Some("all") {
        for package in context.packages {
            let files = context.files(
                &Options {
                    target: Some(&package.relative_dir),
                    build,
                    require_override: require_override.then_some(true),
                    ..Default::default()
                },
                diagnostics,
            )?;
            result.push((package, files));
        }
        output.require_text_or_json("The selected command does not support --format dotenv.")?;
        if output.is_json() {
            output.json(
                &result
                    .iter()
                    .map(|(package, files)| json!({"target":package,"files":files}))
                    .collect::<Vec<_>>(),
            )?;
        } else {
            for (package, files) in result {
                output.line(format!(
                    "# {}",
                    package.name.as_ref().unwrap_or(&package.relative_dir)
                ))?;
                print_files(output, &files)?;
            }
        }
    } else {
        let files = context.files(
            &Options {
                target,
                build,
                require_override: require_override.then_some(true),
                ..Default::default()
            },
            diagnostics,
        )?;
        output.require_text_or_json("The selected command does not support --format dotenv.")?;
        if output.is_json() {
            output.json(&files)?;
        } else {
            print_files(output, &files)?;
        }
    }
    Ok(())
}
fn print_files(output: &Output, files: &[FileRef]) -> Result<()> {
    for file in files {
        let kind = match file.kind {
            FileKind::Base => "base",
            FileKind::Override => "override",
            FileKind::Custom => "custom",
        };
        output.line(format!(
            "{} {kind:8} {}",
            if file.exists { "loaded " } else { "missing" },
            file.relative_path
        ))?;
    }
    Ok(())
}
