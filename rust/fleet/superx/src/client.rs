//! placeholder
use clap::Args;

#[derive(Args)]
pub struct StartArgs {}

#[derive(Args)]
pub struct StopArgs {}

#[derive(Args)]
pub struct LsArgs {}

#[derive(Args)]
pub struct WatchArgs {}

pub fn start_main(_a: StartArgs) -> i32 {
    eprintln!("not implemented");
    2
}

pub fn stop_main(_a: StopArgs) -> i32 {
    eprintln!("not implemented");
    2
}

pub fn ls_main(_a: LsArgs) -> i32 {
    eprintln!("not implemented");
    2
}

pub fn watch_main(_a: WatchArgs) -> i32 {
    eprintln!("not implemented");
    2
}
