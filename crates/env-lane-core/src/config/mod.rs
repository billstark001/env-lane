//! Native configuration: schema, validation, decoding and discovery are separate
//! concerns. JavaScript evaluation is owned by an external configuration compiler.
mod cache;
mod format;
mod load;
mod schema;
mod validate;

pub use format::{parse_json5, parse_toml, parse_yaml};
pub use load::{
    EXECUTABLE_EXTENSIONS, LoadedConfig, NATIVE_EXTENSIONS, load, read_config, read_native_config,
    resolve_value,
};
pub use schema::*;

use crate::error::Error;

pub(super) fn invalid(message: impl Into<String>) -> Error {
    Error::new(
        "CONFIG_LOAD_FAILED",
        format!("Failed to load env-lane config: {}", message.into()),
    )
}
