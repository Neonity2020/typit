use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::Emitter;

/// 自定义退出菜单项的 id，前端确认后回调 quit_app 命令
const QUIT_MENU_ID: &str = "quit";

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    if !Path::new(&path).is_file() {
        return Err(format!("文件不存在：{path}"));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    // UTF-8 BOM 会被当成正文首字符，使首行 "# 标题" 解析失败、整行退化成普通段落，
    // 而它在编辑器里不可见、用户没法自己删掉，所以在解码后剥掉。
    if let Some(rest) = text.strip_prefix('\u{feff}') {
        return Ok(rest.to_owned());
    }
    Ok(text)
}

/// 原子写入：先写同目录的临时文件，再 rename 覆盖目标。
/// 直接 fs::write 会先截断再写，中途失败（崩溃、磁盘满）会留下半截文件。
fn write_atomically(target: &Path, contents: &str) -> std::io::Result<()> {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "路径没有文件名"))?;
    // 临时文件必须与目标同目录，rename 才是同一文件系统内的原子替换
    let tmp = dir.join(format!(".{}.{}.tmp", name.to_string_lossy(), std::process::id()));

    let outcome = write_temp_then_replace(&tmp, target, contents);
    if outcome.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    outcome
}

/// 写临时文件、落盘、继承目标权限、原子替换
fn write_temp_then_replace(tmp: &Path, target: &Path, contents: &str) -> std::io::Result<()> {
    let mut file = fs::File::create(tmp)?;
    file.write_all(contents.as_bytes())?;
    // 先落盘再替换，否则崩溃后可能得到一个已改名但内容为空的文件
    file.sync_all()?;
    drop(file);

    // 临时文件默认权限是 0600，不继承的话会把原有的 0644 之类改掉
    if let Ok(meta) = fs::metadata(target) {
        fs::set_permissions(tmp, meta.permissions())?;
    }

    fs::rename(tmp, target)
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    // 已存在的文件先解析符号链接：rename 会替换链接本身，而 fs::write 是写入链接指向
    // 的文件，直接 rename 会把符号链接变成一个普通文件。不存在（另存为新文件）时按给定路径创建。
    let target = fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    write_atomically(&target, &contents).map_err(|e| e.to_string())
}

/// 前端确认可以退出后调用（有未保存改动时，前端会先弹确认框）
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0)
}

/// 在系统默认浏览器中打开链接。
/// URL 来自文档内容、可以构造任意字符串，若不加校验直接交给 `open`，
/// 以 "-" 开头的参数会被当成命令行选项（例如 -a 启动任意 App），所以只放行
/// 明确允许的协议。`open` 启动后不阻塞命令线程，另起线程回收子进程避免僵尸。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    const ALLOWED: [&str; 3] = ["http://", "https://", "mailto:"];
    // 协议名按 RFC 3986 不区分大小写；转小写再比对，不影响对 "-" 开头参数的拦截
    let scheme = url.to_ascii_lowercase();
    if !ALLOWED.iter().any(|allowed| scheme.starts_with(allowed)) {
        return Err(format!("不支持的链接协议：{url}"));
    }
    let mut child = std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// 默认菜单的 Quit 项是 macOS 原生 terminate: 动作，不经过 Tauri，
/// 按 Cmd+Q 会直接终止进程、丢掉未保存的改动。这里把它换成普通菜单项，
/// 改由 on_menu_event 通知前端先确认。
fn replace_quit_item(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    // macOS 上第一项是应用名子菜单，它的最后一项就是 Quit
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
        if let Some(quit) = app_menu.items()?.last() {
            app_menu.remove(quit)?;
        }
        app_menu.append(&MenuItem::with_id(
            app,
            QUIT_MENU_ID,
            "退出 Typit",
            true,
            Some("CmdOrCtrl+Q"),
        )?)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_file, write_file, quit_app, open_url])
        .setup(|app| {
            replace_quit_item(app.handle())?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == QUIT_MENU_ID {
                let _ = app.emit("quit-requested", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
