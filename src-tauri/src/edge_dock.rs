//! Right-edge windows. Persistent placement is separate from general settings so
//! a stale settings panel cannot overwrite newer dock positions.
use crate::{
    json_io::write_json_atomic,
    services::notes::{default_config_dir, default_store, AppError},
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
static DOCK_FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockEntry {
    note_id: String,
    monitor: Option<String>,
    relative_y: f64,
    order: usize,
    width: f64,
    height: f64,
    #[serde(skip)]
    label: String,
    #[serde(skip)]
    expanded: bool,
}

#[derive(Default)]
pub struct DockState {
    entries: Mutex<Vec<DockEntry>>,
    pending: Mutex<Option<String>>,
}

fn error(message: &str) -> AppError {
    AppError {
        code: "edgeDock".into(),
        message: message.into(),
        details: Default::default(),
    }
}
fn entries(app: &AppHandle) -> Vec<DockEntry> {
    app.state::<DockState>().entries.lock().unwrap().clone()
}
pub fn is_docked(app: &AppHandle, label: &str) -> bool {
    app.try_state::<DockState>()
        .map(|state| {
            state
                .entries
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.label == label)
        })
        .unwrap_or(false)
}
fn persist(app: &AppHandle) -> Result<(), AppError> {
    let _guard = DOCK_FILE_LOCK.lock().unwrap();
    let snapshot = entries(app);
    write_json_atomic(&default_config_dir()?.join("edge-docks.json"), &snapshot)
}

/// Allocate a stable vertical stack, including crowded and scaled work areas.
pub fn stack_positions(desired: &[f64], extent: f64, item: f64, gap: f64) -> Vec<f64> {
    let mut result = Vec::new();
    for (index, value) in desired.iter().enumerate() {
        let low = result.last().copied().unwrap_or(-item - gap) + item + gap;
        let remaining = desired.len() - index;
        let high = (extent - remaining as f64 * item - (remaining - 1) as f64 * gap).max(low);
        result.push(value.max(low).min(high));
    }
    result
}

fn layout(app: &AppHandle) -> Result<(), AppError> {
    let mut all = entries(app);
    all.sort_by(|a, b| {
        a.relative_y
            .total_cmp(&b.relative_y)
            .then(a.order.cmp(&b.order))
    });
    let monitors = app.available_monitors()?;
    let primary = app
        .primary_monitor()?
        .or_else(|| monitors.first().cloned())
        .ok_or_else(|| error("无法读取显示器"))?;
    for monitor in &monitors {
        let group: Vec<_> = all
            .iter()
            .filter(|entry| {
                let chosen = monitors
                    .iter()
                    .find(|m| m.name().cloned() == entry.monitor)
                    .unwrap_or(&primary);
                chosen.position() == monitor.position()
            })
            .collect();
        if group.is_empty() {
            continue;
        }
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let extent = area.size.height as f64;
        let gap = (5.0 * scale).min(extent / (group.len() as f64 * 4.0));
        let item = (132.0 * scale)
            .min((extent - gap * (group.len() - 1) as f64) / group.len() as f64)
            .max(1.0);
        let desired: Vec<_> = group
            .iter()
            .map(|e| e.relative_y.clamp(0.0, 1.0) * (extent - item))
            .collect();
        let positions = stack_positions(&desired, extent, item, gap);
        for (entry, y) in group.iter().zip(positions) {
            let Some(window) = app.get_webview_window(&entry.label) else {
                continue;
            };
            let width = if entry.expanded {
                (entry.width * scale).min(area.size.width as f64)
            } else {
                44.0 * scale
            };
            let height = if entry.expanded {
                (entry.height * scale).min(extent)
            } else {
                item
            };
            let top = (area.position.y as f64 + y).min(area.position.y as f64 + extent - height);
            window.set_min_size(Some(LogicalSize::new(1.0, 1.0)))?;
            window.set_resizable(entry.expanded)?;
            window.set_always_on_top(true)?;
            window.set_size(PhysicalSize::new(
                width.round() as u32,
                height.round() as u32,
            ))?;
            window.set_position(PhysicalPosition::new(
                area.position.x + area.size.width as i32 - width.round() as i32,
                top.round() as i32,
            ))?;
            window.show()?;
        }
    }
    Ok(())
}

pub fn initialize(app: &AppHandle) -> Result<(), AppError> {
    app.manage(DockState::default());
    let path = default_config_dir()?.join("edge-docks.json");
    let stored: Vec<DockEntry> = if path.exists() {
        match std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
        {
            Some(entries) => entries,
            None => {
                let recovery = path.with_file_name(format!(
                    "edge-docks-recovery-{}.json",
                    chrono::Utc::now().format("%Y%m%d%H%M%S")
                ));
                let _ = std::fs::copy(&path, recovery);
                eprintln!("无法读取侧边配置，已保留恢复副本；以普通窗口继续启动");
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    for mut entry in stored {
        if default_store()?.read_note(&entry.note_id).is_err() {
            continue;
        }
        entry.label = format!("notepad-{}", entry.note_id);
        entry.expanded = false;
        WebviewWindowBuilder::new(
            app,
            &entry.label,
            WebviewUrl::App(
                format!("index.html?view=notepad&noteId={}&edge=1", entry.note_id).into(),
            ),
        )
        .title("花笺 · 侧边笔记")
        .inner_size(44.0, 132.0)
        .min_inner_size(1.0, 1.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .build()?;
        app.state::<DockState>().entries.lock().unwrap().push(entry);
    }
    layout(app)?;
    // Re-evaluate monitor work areas after unplugging a display / changing DPI.
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut previous = String::new();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let Ok(monitors) = handle.available_monitors() else {
                continue;
            };
            let signature = format!("{monitors:?}");
            if signature != previous {
                previous = signature;
                let app = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let _ = layout(&app);
                });
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn edge_attach(
    app: AppHandle,
    window: WebviewWindow,
    note_id: String,
) -> Result<(), AppError> {
    default_store()?.read_note(&note_id)?;
    if entries(&app)
        .iter()
        .any(|e| e.note_id == note_id && e.label != window.label())
    {
        return Err(error("此文档已吸附，请使用已有侧边按钮"));
    }
    let monitor = window.current_monitor()?;
    let mut data = entries(&app);
    if !data.iter().any(|e| e.label == window.label()) {
        data.push(DockEntry {
            note_id,
            monitor: monitor.and_then(|m| m.name().cloned()),
            relative_y: 0.12 + (data.len() as f64) * 0.16,
            order: data.len(),
            width: 420.0,
            height: 560.0,
            label: window.label().to_string(),
            expanded: false,
        });
    }
    *app.state::<DockState>().entries.lock().unwrap() = data;
    persist(&app)?;
    layout(&app)?;
    app.emit_to(
        window.label(),
        "edge-state",
        serde_json::json!({"expanded":false}),
    )?;
    Ok(())
}

pub fn expand_existing(app: &AppHandle, note_id: &str) -> Result<Option<String>, AppError> {
    let all = entries(app);
    let Some(target) = all.iter().find(|e| e.note_id == note_id) else {
        return Ok(None);
    };
    if let Some(current) = all.iter().find(|e| e.expanded && e.note_id != note_id) {
        *app.state::<DockState>().pending.lock().unwrap() = Some(note_id.to_string());
        if app.get_webview_window(&current.label).is_some() {
            app.emit_to(
                &current.label,
                "edge-collapse-request",
                Option::<String>::None,
            )?;
        }
        return Ok(Some(target.label.clone()));
    }
    {
        let state = app.state::<DockState>();
        let mut data = state.entries.lock().unwrap();
        if let Some(entry) = data.iter_mut().find(|e| e.note_id == note_id) {
            entry.expanded = true;
        }
    }
    layout(app)?;
    if let Some(w) = app.get_webview_window(&target.label) {
        app.emit_to(
            &target.label,
            "edge-state",
            serde_json::json!({"expanded":true}),
        )?;
        w.set_focus()?;
    }
    Ok(Some(target.label.clone()))
}

#[tauri::command]
pub async fn edge_expand(app: AppHandle, note_id: String) -> Result<(), AppError> {
    expand_existing(&app, &note_id)?.ok_or_else(|| error("未找到吸附文档"))?;
    Ok(())
}

#[tauri::command]
pub async fn edge_collapse(app: AppHandle, window: WebviewWindow) -> Result<(), AppError> {
    let size = window.inner_size()?;
    let scale = window.scale_factor()?;
    {
        let state = app.state::<DockState>();
        let mut all = state.entries.lock().unwrap();
        if let Some(entry) = all.iter_mut().find(|e| e.label == window.label()) {
            if entry.expanded {
                entry.width = size.width as f64 / scale;
                entry.height = size.height as f64 / scale;
            }
            entry.expanded = false;
        }
    }
    persist(&app)?;
    app.emit_to(
        window.label(),
        "edge-state",
        serde_json::json!({"expanded":false}),
    )?;
    layout(&app)?;
    let pending = app.state::<DockState>().pending.lock().unwrap().take();
    if let Some(id) = pending {
        expand_existing(&app, &id)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn edge_detach(app: AppHandle, window: WebviewWindow) -> Result<(), AppError> {
    {
        let state = app.state::<DockState>();
        state
            .entries
            .lock()
            .unwrap()
            .retain(|e| e.label != window.label());
        *state.pending.lock().unwrap() = None;
    }
    persist(&app)?;
    window.set_resizable(true)?;
    window.set_size(LogicalSize::new(420.0, 560.0))?;
    if let Some(m) = window.current_monitor()? {
        let area = m.work_area();
        let size = window.outer_size()?;
        window.set_position(PhysicalPosition::new(
            area.position.x + (area.size.width.saturating_sub(size.width)) as i32,
            area.position.y + 30,
        ))?;
    }
    layout(&app)?;
    Ok(())
}

#[tauri::command]
pub async fn edge_reposition(app: AppHandle, window: WebviewWindow) -> Result<(), AppError> {
    let Some(monitor) = window.current_monitor()? else {
        return Ok(());
    };
    let position = window.outer_position()?;
    let size = window.outer_size()?;
    let area = monitor.work_area();
    let relative = (position.y - area.position.y) as f64
        / area.size.height.saturating_sub(size.height).max(1) as f64;
    let right = area.position.x + area.size.width as i32 - size.width as i32;
    {
        let state = app.state::<DockState>();
        let mut all = state.entries.lock().unwrap();
        let Some(entry) = all.iter_mut().find(|e| e.label == window.label()) else {
            return Ok(());
        };
        if entry.expanded {
            return Ok(());
        }
        if (entry.relative_y - relative).abs() < 0.003 && (right - position.x).abs() <= 1 {
            return Ok(());
        }
        entry.relative_y = relative.clamp(0.0, 1.0);
        entry.monitor = monitor.name().cloned();
    }
    persist(&app)?;
    layout(&app)
}

pub fn remove_note(app: &AppHandle, id: &str) -> Result<(), AppError> {
    let old = entries(app);
    {
        let state = app.state::<DockState>();
        state.entries.lock().unwrap().retain(|e| e.note_id != id);
    }
    persist(app)?;
    for entry in old.iter().filter(|e| e.note_id == id) {
        if let Some(w) = app.get_webview_window(&entry.label) {
            let _ = w.destroy();
        }
    }
    layout(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn separates_collisions_and_keeps_buttons_visible() {
        assert_eq!(
            stack_positions(&[900.0, 900.0], 1000.0, 132.0, 5.0),
            vec![731.0, 868.0]
        );
        assert_eq!(
            stack_positions(&[-100.0, 0.0], 600.0, 100.0, 5.0),
            vec![0.0, 105.0]
        );
    }
}
