pub struct Worker;
impl Worker { pub fn perform(&self) -> u32 { 42 } }
pub fn make() -> Worker { Worker }
#[cfg(coredoc_build_script)]
pub fn built() -> u32 { make().perform() }
pub fn run() -> u32 {
    let _unused = Worker::perform;
    let _text = "😀"; make().perform()
}
