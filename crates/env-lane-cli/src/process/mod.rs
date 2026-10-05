//! Child execution belongs to the executable, never to the shared domain context.
use crate::output::Output;
use env_lane_core::{
    error::{Diagnostic, Error, Result, Severity},
    run::PreparedRun,
};
#[cfg(windows)]
use std::path::PathBuf;
use std::{
    ffi::OsStr,
    process::{Command, Stdio},
};
#[cfg(unix)]
use std::{io::IsTerminal, os::unix::process::CommandExt};

#[cfg(unix)]
mod signals;

pub fn execute(prepared: &PreparedRun, output: &Output) -> Result<i32> {
    // Register before spawning so termination cannot leave a child in the gap
    // between process creation and installing cleanup handlers.
    #[cfg(unix)]
    let isolated_group = !std::io::stdin().is_terminal()
        && !std::io::stdout().is_terminal()
        && !std::io::stderr().is_terminal();
    #[cfg(unix)]
    let termination = signals::Termination::listen(isolated_group).map_err(process_error)?;
    let mut command = command(prepared);
    #[cfg(unix)]
    if isolated_group {
        // A non-interactive child can own a process group without losing TTY
        // access. This lets an interrupted runner terminate its descendants.
        command.process_group(0);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        #[cfg(windows)]
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let Some(batch) = windows_batch_fallback(prepared) else {
                return spawn_failure(prepared, output, error);
            };
            let mut retry = command_for(prepared, batch.as_os_str());
            match retry.spawn() {
                Ok(child) => child,
                Err(error) => return spawn_failure(prepared, output, error),
            }
        }
        Err(error) => return spawn_failure(prepared, output, error),
    };
    #[cfg(unix)]
    let status = termination.wait(&mut child).map_err(process_error)?;
    #[cfg(not(unix))]
    let status = child.wait().map_err(process_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            drop(termination);
            // Preserve the signal disposition seen by the calling shell or
            // package manager. The numeric fallback is only for a failed raise.
            signal_hook::low_level::emulate_default_handler(signal).map_err(process_error)?;
            return Ok(128 + signal);
        }
    }
    Ok(status.code().unwrap_or(1))
}

fn spawn_failure(prepared: &PreparedRun, output: &Output, error: std::io::Error) -> Result<i32> {
    let directory_missing = !prepared.cwd.is_dir();
    let not_found = error.kind() == std::io::ErrorKind::NotFound && !directory_missing;
    let (code, diagnostic) = if not_found {
        (127, "RUN_COMMAND_NOT_FOUND")
    } else {
        (126, "RUN_SPAWN_FAILED")
    };
    output.diagnostic(&Diagnostic {
        code: diagnostic.into(),
        severity: Severity::Error,
        message: format!(
            "Cannot start '{}': {error}",
            prepared.program.to_string_lossy()
        ),
        details: None,
    })?;
    Ok(code)
}

fn command(prepared: &PreparedRun) -> Command {
    command_for(prepared, &prepared.program)
}

fn command_for(prepared: &PreparedRun, program: &OsStr) -> Command {
    let mut command = Command::new(program);
    command.args(&prepared.arguments);
    // Inheritance is intentional: disabling shell values during dotenv resolution
    // does not remove PATH or other inherited variables from the child process.
    command
        .current_dir(&prepared.cwd)
        .envs(&prepared.environment.values)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    command
}

#[cfg(windows)]
fn windows_batch_fallback(prepared: &PreparedRun) -> Option<PathBuf> {
    let program = PathBuf::from(&prepared.program);
    let explicit_batch = match program.extension().and_then(|extension| extension.to_str()) {
        Some(extension)
            if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat") =>
        {
            true
        }
        Some(_) => return None,
        None => false,
    };
    let mut directories = vec![prepared.cwd.clone()];
    if program.components().count() == 1 {
        let path = prepared
            .environment
            .values
            .iter()
            .rev()
            .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
            .map(|(_, value)| std::ffi::OsString::from(value))
            .or_else(|| std::env::var_os("PATH"));
        directories.extend(path.as_deref().into_iter().flat_map(std::env::split_paths));
    }
    let extensions = if explicit_batch {
        String::new()
    } else {
        prepared
            .environment
            .values
            .iter()
            .rev()
            .find(|(key, _)| key.eq_ignore_ascii_case("PATHEXT"))
            .map(|(_, value)| value.clone())
            .or_else(|| std::env::var("PATHEXT").ok())
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into())
    };
    for directory in directories {
        // Windows resolves relative PATH entries from the child's working
        // directory, while is_file() observes this process's working directory.
        let directory = if directory.is_absolute() {
            directory
        } else {
            prepared.cwd.join(directory)
        };
        let base = directory.join(&program);
        for extension in extensions.split(';') {
            if !explicit_batch
                && !extension.eq_ignore_ascii_case(".cmd")
                && !extension.eq_ignore_ascii_case(".bat")
            {
                continue;
            }
            let mut name = base.as_os_str().to_owned();
            name.push(extension);
            let candidate = PathBuf::from(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn process_error(error: std::io::Error) -> Error {
    Error::new("CHILD_PROCESS_FAILED", error.to_string())
}
