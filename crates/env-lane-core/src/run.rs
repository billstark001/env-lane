//! Prepare child execution without starting a process or installing signal handlers.
use crate::{
    error::{Diagnostic, Error, Result},
    paths::resolve_path,
    resolve::{Context, Options, ResolvedEnvironment},
};
use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

/// API consumers select a directory explicitly. CLI string aliases are parsed at
/// the presentation boundary so a native path named `root` remains representable.
#[derive(Debug, Default)]
pub enum WorkingDirectory<'a> {
    #[default]
    Target,
    ProjectRoot,
    Path(&'a Path),
}

#[derive(Debug)]
pub struct PreparedRun {
    pub program: OsString,
    pub arguments: Vec<OsString>,
    pub cwd: PathBuf,
    pub environment: ResolvedEnvironment,
}

pub fn prepare(
    context: &Context<'_>,
    options: &Options<'_>,
    command: &[impl AsRef<OsStr>],
    directory: WorkingDirectory<'_>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<PreparedRun> {
    let (program, arguments) = command
        .split_first()
        .ok_or_else(|| Error::new("MISSING_COMMAND", "Missing command."))?;
    let environment = context.resolve(options, diagnostics)?;
    let cwd = match directory {
        WorkingDirectory::Target => environment.target.dir.clone(),
        WorkingDirectory::ProjectRoot => environment.root_dir.clone(),
        WorkingDirectory::Path(path) => resolve_path(&context.loaded.invocation_cwd, path),
    };
    Ok(PreparedRun {
        program: program.as_ref().to_owned(),
        arguments: arguments
            .iter()
            .map(|argument| argument.as_ref().to_owned())
            .collect(),
        cwd,
        environment,
    })
}
