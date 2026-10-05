//! Environment document and application primitives shared by native consumers.
//! JavaScript configuration evaluation and deprecated API shims belong to outer APIs.
pub mod check;
pub mod config;
pub mod document;
pub mod error;
pub mod paths;
pub mod policy;
pub mod redaction;
pub mod resolve;
pub mod run;
pub mod sort;
pub mod storage;
pub mod text;
pub mod variants;
pub mod workspace;
