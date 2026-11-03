fn main() {
    // Client IDs live in ../.env (see .env.example); they are public identifiers, not secrets.
    // ../.env.release is written by the release scripts for public builds (WANDIKA_PUBLIC=1). It's a
    // file, not only an environment variable, because Xcode's iPhone build doesn't pass the
    // script's environment on to cargo. Its values win over .env.
    println!("cargo:rerun-if-changed=../.env");
    println!("cargo:rerun-if-changed=../.env.release");
    println!("cargo:rerun-if-env-changed=WANDIKA_PUBLIC");
    println!("cargo:rerun-if-env-changed=WANDIKA_GOOGLE_REVIEWED");
    let mut vars = std::collections::BTreeMap::new();
    for file in ["../.env", "../.env.release"] {
        if let Ok(iter) = dotenvy::from_path_iter(file) {
            for (key, value) in iter.flatten() {
                if key.starts_with("WANDIKA_") {
                    vars.insert(key, value);
                }
            }
        }
    }
    for (key, value) in vars {
        println!("cargo:rustc-env={key}={value}");
    }
    tauri_build::build()
}
