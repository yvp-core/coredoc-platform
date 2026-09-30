fn main() {
    println!("cargo:rustc-check-cfg=cfg(coredoc_build_script)");
    println!("cargo:rustc-cfg=coredoc_build_script");
}
