//! Local project registry.
//!
//! All projects live under ONE user-chosen data root (defined once in
//! Settings — there is no per-project directory anymore):
//!
//! ```text
//! <data-root>/projects.json                     registry (self-contained)
//! <data-root>/projects/<id>/workspace.db ...    one directory per project
//! ```
//!
//! The fixed OS app-data directory only holds a tiny pointer file
//! (`data_root.json`) that says where the root is. Because the registry
//! travels with the root, copying the data root to another machine carries
//! the whole project list along. The default root is the app-data directory
//! itself, so a fresh install needs no configuration.

use reqora_core::error::AppError;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const REGISTRY_FILE: &str = "projects.json";
const ROOT_POINTER_FILE: &str = "data_root.json";
const PROJECTS_DIR: &str = "projects";
const DEFAULT_PROJECT_ID: &str = "default";

/// SQLite database file managed by `storage.rs` (plus its WAL sidecars).
const DB_FILE: &str = "workspace.db";
/// Per-project index written by `storage.rs`.
const MANIFEST_FILE: &str = "manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryFile {
    version: u8,
    active_project_id: String,
    projects: Vec<Project>,
}

/// Pointer in the fixed app-data directory: where the data root lives.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootPointer {
    data_root: Option<String>,
}

/// Everything behind the single mutex: the resolved root plus its registry.
#[derive(Debug)]
struct State {
    /// `None` => the app-data directory itself is the root.
    data_root: Option<String>,
    registry: RegistryFile,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    /// Absolute data directory of this project (`<root>/projects/<id>`).
    pub data_directory: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsState {
    pub active_project_id: String,
    pub projects: Vec<ProjectInfo>,
    /// The data root every project directory lives under.
    pub data_root: String,
    /// Absolute data directory of the active project.
    pub data_directory: String,
}

pub struct ProjectRegistry {
    app_data_dir: PathBuf,
    data: Mutex<State>,
}

impl ProjectRegistry {
    pub fn new(app_data_dir: PathBuf) -> Result<Self, AppError> {
        fs::create_dir_all(&app_data_dir)
            .map_err(|error| AppError::Storage(format!("创建应用数据目录失败: {error}")))?;

        let pointer_path = app_data_dir.join(ROOT_POINTER_FILE);
        let data_root: Option<String> = if pointer_path.exists() {
            let raw = fs::read_to_string(&pointer_path).map_err(|error| {
                AppError::Storage(format!("读取数据目录指针失败: {error}"))
            })?;
            serde_json::from_str::<RootPointer>(&raw)
                .map_err(|_| AppError::Storage("数据目录指针文件损坏，无法解析".into()))?
                .data_root
        } else {
            None
        };

        let state = Self::load_state(&app_data_dir, data_root)?;
        Ok(Self {
            app_data_dir,
            data: Mutex::new(state),
        })
    }

    /// Read (or first-run seed) the registry under the given root.
    fn load_state(app_data_dir: &Path, data_root: Option<String>) -> Result<State, AppError> {
        let root = Self::root_dir(app_data_dir, &data_root);
        let registry_path = root.join(REGISTRY_FILE);
        let registry = if registry_path.exists() {
            let raw = fs::read_to_string(&registry_path)
                .map_err(|error| AppError::Storage(format!("读取项目列表失败: {error}")))?;
            let mut parsed: RegistryFile = serde_json::from_str(&raw)
                .map_err(|_| AppError::Storage("项目列表文件损坏，无法解析".into()))?;
            if parsed.version != 1 || parsed.projects.is_empty() {
                return Err(AppError::Storage("项目列表格式不受支持".into()));
            }
            // Self-heal a stale active id instead of failing to boot.
            if !parsed
                .projects
                .iter()
                .any(|project| project.id == parsed.active_project_id)
            {
                parsed.active_project_id = parsed.projects[0].id.clone();
            }
            parsed
        } else {
            RegistryFile {
                version: 1,
                active_project_id: DEFAULT_PROJECT_ID.to_string(),
                projects: vec![Project {
                    id: DEFAULT_PROJECT_ID.to_string(),
                    name: "默认项目".into(),
                    created_at: crate::logging::now_millis(),
                }],
            }
        };
        Ok(State { data_root, registry })
    }

    fn root_dir(app_data_dir: &Path, data_root: &Option<String>) -> PathBuf {
        match data_root.as_deref() {
            Some(raw) if !raw.trim().is_empty() => PathBuf::from(raw.trim()),
            _ => app_data_dir.to_path_buf(),
        }
    }

    fn project_dir_in(root: &Path, id: &str) -> PathBuf {
        root.join(PROJECTS_DIR).join(id)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, AppError> {
        self.data
            .lock()
            .map_err(|_| AppError::Internal("项目列表锁不可用".into()))
    }

    /// Persist the registry under the current root, then the root pointer.
    fn persist(&self, state: &State) -> Result<(), AppError> {
        let root = Self::root_dir(&self.app_data_dir, &state.data_root);
        fs::create_dir_all(&root)
            .map_err(|error| AppError::Storage(format!("创建数据目录失败: {error}")))?;
        let raw = serde_json::to_vec_pretty(&state.registry)
            .map_err(|error| AppError::Storage(format!("序列化项目列表失败: {error}")))?;
        fs::write(root.join(REGISTRY_FILE), &raw)
            .map_err(|error| AppError::Storage(format!("写入项目列表失败: {error}")))?;
        let pointer = serde_json::to_vec_pretty(&RootPointer {
            data_root: state.data_root.clone(),
        })
        .map_err(|error| AppError::Storage(format!("序列化数据目录指针失败: {error}")))?;
        fs::write(self.app_data_dir.join(ROOT_POINTER_FILE), &pointer)
            .map_err(|error| AppError::Storage(format!("写入数据目录指针失败: {error}")))?;
        Ok(())
    }

    /// Make sure the directory exists and is actually writable, so a bad pick
    /// fails immediately instead of on save.
    fn ensure_directory(dir: &Path) -> Result<(), AppError> {
        if dir.exists() && !dir.is_dir() {
            return Err(AppError::Storage("指定路径是一个文件，请选择目录".into()));
        }
        fs::create_dir_all(dir)
            .map_err(|error| AppError::Storage(format!("创建数据目录失败: {error}")))?;
        let probe = dir.join(".reqora-write-test");
        fs::write(&probe, b"ok")
            .map_err(|error| AppError::Storage(format!("数据目录不可写: {error}")))?;
        let _ = fs::remove_file(&probe);
        Ok(())
    }

    /// Absolute data directory of the active project.
    pub fn project_dir(&self) -> Result<PathBuf, AppError> {
        let state = self.lock()?;
        let root = Self::root_dir(&self.app_data_dir, &state.data_root);
        Ok(Self::project_dir_in(
            &root,
            &state.registry.active_project_id,
        ))
    }

    pub fn info(&self) -> Result<ProjectsState, AppError> {
        let state = self.lock()?;
        let root = Self::root_dir(&self.app_data_dir, &state.data_root);
        let projects = state
            .registry
            .projects
            .iter()
            .map(|project| ProjectInfo {
                id: project.id.clone(),
                name: project.name.clone(),
                data_directory: Self::project_dir_in(&root, &project.id).display().to_string(),
                active: project.id == state.registry.active_project_id,
            })
            .collect();
        let data_directory = Self::project_dir_in(&root, &state.registry.active_project_id)
            .display()
            .to_string();
        Ok(ProjectsState {
            active_project_id: state.registry.active_project_id.clone(),
            projects,
            data_root: root.display().to_string(),
            data_directory,
        })
    }

    /// Create a project under the current root, make it active and return its
    /// data directory.
    pub fn create_project(&self, name: String) -> Result<PathBuf, AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("项目名称不能为空".into()));
        }
        let mut state = self.lock()?;
        let id = uuid::Uuid::new_v4().to_string();
        let dir = {
            let root = Self::root_dir(&self.app_data_dir, &state.data_root);
            let dir = Self::project_dir_in(&root, &id);
            Self::ensure_directory(&dir)?;
            dir
        };
        state.registry.projects.push(Project {
            id: id.clone(),
            name: name.to_string(),
            created_at: crate::logging::now_millis(),
        });
        state.registry.active_project_id = id;
        self.persist(&state)?;
        Ok(dir)
    }

    /// Switch the active project and return its data directory.
    pub fn switch_project(&self, id: String) -> Result<PathBuf, AppError> {
        let mut state = self.lock()?;
        if !state
            .registry
            .projects
            .iter()
            .any(|project| project.id == id)
        {
            return Err(AppError::InvalidInput("项目不存在".into()));
        }
        state.registry.active_project_id = id;
        self.persist(&state)?;
        drop(state);
        self.project_dir()
    }

    /// Rename a project in the registry (used when pulling a collaboration
    /// space so the local project carries the space's name).
    pub fn rename_project(&self, id: String, name: String) -> Result<(), AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("项目名称不能为空".into()));
        }
        let mut state = self.lock()?;
        let project = state
            .registry
            .projects
            .iter_mut()
            .find(|project| project.id == id)
            .ok_or_else(|| AppError::InvalidInput("项目不存在".into()))?;
        project.name = name.to_string();
        self.persist(&state)
    }

    /// Switch the global data root. There is exactly one root for ALL
    /// projects — this replaces the old per-project directory.
    ///
    /// - Root already has a `projects.json` → adopt that registry verbatim
    ///   (re-pointing at a previous root is non-destructive).
    /// - Fresh root → seed a new registry carrying ONLY the active project,
    ///   whose data files are copied over via `copy_active_into` (verified by
    ///   the caller, `WorkspaceStore::copy_to`). Other projects stay behind in
    ///   the old root; nothing is deleted.
    ///
    /// If copying fails, the pointer keeps pointing at the old root.
    pub fn set_data_root(
        &self,
        root: Option<String>,
        copy_active_into: impl FnOnce(&Path) -> Result<(), AppError>,
    ) -> Result<PathBuf, AppError> {
        let normalized = normalize_directory(root);
        let mut state = self.lock()?;

        let active_id = state.registry.active_project_id.clone();
        let active = state
            .registry
            .projects
            .iter()
            .find(|project| project.id == active_id)
            .cloned();

        let new_root = Self::root_dir(&self.app_data_dir, &normalized);
        Self::ensure_directory(&new_root)?;
        let registry_path = new_root.join(REGISTRY_FILE);

        let registry = if registry_path.exists() {
            let raw = fs::read_to_string(&registry_path)
                .map_err(|error| AppError::Storage(format!("读取项目列表失败: {error}")))?;
            let mut parsed: RegistryFile = serde_json::from_str(&raw)
                .map_err(|_| AppError::Storage("项目列表文件损坏，无法解析".into()))?;
            if parsed.version != 1 || parsed.projects.is_empty() {
                return Err(AppError::Storage("项目列表格式不受支持".into()));
            }
            if !parsed
                .projects
                .iter()
                .any(|project| project.id == parsed.active_project_id)
            {
                parsed.active_project_id = parsed.projects[0].id.clone();
            }
            parsed
        } else {
            if let Some(active) = &active {
                let target = Self::project_dir_in(&new_root, &active.id);
                let target_has_data =
                    target.join(DB_FILE).exists() || target.join(MANIFEST_FILE).exists();
                if !target_has_data {
                    Self::ensure_directory(&target)?;
                    copy_active_into(&target)?;
                }
            }
            RegistryFile {
                version: 1,
                active_project_id: active_id.clone(),
                projects: active.into_iter().collect(),
            }
        };

        state.data_root = normalized;
        state.registry = registry;
        self.persist(&state)?;
        drop(state);
        self.project_dir()
    }
}

fn normalize_directory(directory: Option<String>) -> Option<String> {
    directory
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
}
