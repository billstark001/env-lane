//! Parser-library errors are translated only at the command-line boundary.
use clap::error::{ContextKind, ContextValue, ErrorKind};
use env_lane_core::error::Error;

pub fn render(error: &clap::Error) -> Error {
    let invalid = error
        .get(ContextKind::InvalidArg)
        .and_then(|value| match value {
            ContextValue::String(value) => Some(value.as_str()),
            ContextValue::Strings(values) => values.first().map(String::as_str),
            _ => None,
        });
    let message = match (error.kind(), invalid) {
        (ErrorKind::UnknownArgument, Some(argument)) if argument.starts_with('-') => {
            format!("error: unknown option '{argument}'")
        }
        (ErrorKind::MissingRequiredArgument, Some(argument)) => {
            let name = argument
                .trim_end_matches("...")
                .trim_matches(['<', '>'])
                .to_lowercase();
            format!("error: missing required argument '{name}'")
        }
        _ => error
            .to_string()
            .replace("unrecognized subcommand", "unknown command")
            .lines()
            .next()
            .unwrap_or("Invalid command arguments.")
            .to_owned(),
    };
    Error::new("CLI_ARGUMENT_ERROR", message)
}
