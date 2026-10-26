use crate::services::notes::AppError;
use serde::Serialize;
use std::{
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};

pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let temp_path = temporary_json_path(path);
    let mut temp_file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .truncate(true)
        .open(&temp_path)?;
    serde_json::to_writer_pretty(&mut temp_file, value)?;
    temp_file.write_all(b"\n")?;
    temp_file.sync_all()?;
    drop(temp_file);
    fs::rename(&temp_path, path)?;
    sync_parent_dir(path)?;
    Ok(())
}

fn temporary_json_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("state.json");
    // Readers and settings windows can save concurrently. A shared .tmp name
    // lets one writer rename another writer's file, causing NotFound or corrupt JSON.
    path.with_file_name(format!("{file_name}.{}.tmp", uuid::Uuid::new_v4()))
}

#[cfg(not(target_os = "windows"))]
fn sync_parent_dir(path: &Path) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn sync_parent_dir(_path: &Path) -> Result<(), AppError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_writers_use_independent_atomic_temp_files() {
        let root=std::env::temp_dir().join(format!("floral-json-test-{}",uuid::Uuid::new_v4()));
        let path=root.join("config.json");
        let workers: Vec<_>=(0..8).map(|writer| {
            let path=path.clone();
            std::thread::spawn(move || {
                for revision in 0..15 {
                    write_json_atomic(&path,&serde_json::json!({"writer":writer,"revision":revision})).expect("concurrent atomic save");
                }
            })
        }).collect();
        for worker in workers { worker.join().unwrap(); }
        let value: serde_json::Value=serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert!(value["writer"].as_u64().unwrap()<8);
        assert_eq!(value["revision"],14);
        fs::remove_dir_all(root).unwrap();
    }
}
