//! Hold a lock until stdin closes; used to exercise cross-process ownership.
use std::{
    io::{self, Read, Write},
    path::PathBuf,
};
fn main() {
    let target = PathBuf::from(std::env::args_os().nth(1).expect("target path"));
    let _guard = env_lane_vault::lock::acquire(&target, &Default::default()).unwrap();
    println!("acquired");
    io::stdout().flush().unwrap();
    io::stdin().read_to_end(&mut Vec::new()).unwrap();
}
