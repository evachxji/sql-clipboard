fn main() {
    // 读取仓库根目录 .env 中的 IP_WHITELIST，编译期注入（仅正式版使用）
    let env_file = std::path::Path::new("../../.env");
    println!("cargo:rerun-if-changed={}", env_file.display());
    if let Ok(text) = std::fs::read_to_string(env_file) {
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            if let Some(v) = line.strip_prefix("IP_WHITELIST=") {
                println!("cargo:rustc-env=IP_WHITELIST={}", v.trim());
            }
        }
    }
    tauri_build::build()
}
