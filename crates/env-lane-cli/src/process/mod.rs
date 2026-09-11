//! Child execution belongs to the executable, never to the shared domain context.
use env_lane_core::{
    error::{Error, Result},
    run::PreparedRun,
};
use std::process::{Command, Stdio};

#[cfg(unix)]
mod signals;

pub fn execute(prepared: &PreparedRun) -> Result<i32> {
    // Register before spawning so termination cannot leave a child in the gap
    // between process creation and installing cleanup handlers.
    #[cfg(unix)]
    let termination = signals::Termination::listen().map_err(process_error)?;
    let mut command = command(prepared);
    let mut child = match command.spawn() {
        Ok(child) => child,
        // `run` reports execution failure through its exit status. It does not
        // append parent diagnostics to streams owned by the requested command.
        Err(_) => return Ok(1),
    };
    #[cfg(unix)]
    let status = termination.wait(&mut child).map_err(process_error)?;
    #[cfg(not(unix))]
    let status = child.wait().map_err(process_error)?;
    Ok(status.code().unwrap_or(1))
}

fn command(prepared: &PreparedRun) -> Command {
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(&prepared.program);
        command.args(&prepared.arguments);
        command
    };
    #[cfg(windows)]
    let mut command = windows_command(prepared);
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
fn windows_command(prepared: &PreparedRun) -> Command {
    use std::{ffi::OsString, os::windows::process::CommandExt};
    let mut line = OsString::from("\"");
    line.push(&prepared.program);
    for argument in &prepared.arguments {
        line.push(" ");
        line.push(argument);
    }
    line.push("\"");
    let mut command = Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()));
    command.args(["/d", "/s", "/c"]).raw_arg(line);
    command
}

fn process_error(error: std::io::Error) -> Error {
    Error::new("CHILD_PROCESS_FAILED", error.to_string())
}
