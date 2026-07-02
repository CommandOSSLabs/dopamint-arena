//! placeholder
use clap::Args;

#[derive(Args)]
pub struct DaemonArgs {}

pub fn daemon_main(_a: DaemonArgs) -> i32 {
    eprintln!("not implemented");
    2
}
