//! 蜂巢桌面壳：Tauri 窗口（系统 WebView2）+ spawn 系统 node 子进程跑内核。
//! server-child.mjs 写 .board-url；这里轮询读取后动态建窗口加载看板。
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

fn main() {
    let desktop_dir = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap(); // packages/desktop
    let hive_root = desktop_dir.parent().unwrap();
    let url_file = desktop_dir.join(".board-url");
    let _ = std::fs::remove_file(&url_file);

    let mut child = Command::new("node")
        .arg(desktop_dir.join("server-child.mjs"))
        .current_dir(hive_root)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn node server-child.mjs 失败——确认系统 PATH 有 node");

    tauri::Builder::default()
        .setup(move |app| {
            let mut url = String::new();
            for _ in 0..150 {
                if let Ok(u) = std::fs::read_to_string(&url_file) {
                    if !u.trim().is_empty() {
                        url = u.trim().to_string();
                        break;
                    }
                }
                thread::sleep(Duration::from_millis(200));
            }
            if url.is_empty() {
                return Err("server 子进程 30 秒未产出 board-url".into());
            }
            let parsed: tauri::Url = url.parse().expect("board-url 不合法");
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(parsed))
                .title("蜂巢 Hive")
                .inner_size(1360.0, 860.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = child.kill();
            }
        });
}
