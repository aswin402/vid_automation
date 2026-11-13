use crate::error::{AppError, AppResult};
use crate::models::{
    AssetRecord, BatchItemRecord, BatchRecord, EditSettings, ProcessingJobRecord, ProjectRecord,
    SubtitleCueItem,
};
use chrono::Utc;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

pub const DEFAULT_OWNER_ID: &str = "local-desktop-user";
pub const BATCH_LIBRARY_OWNER_ID: &str = "batch-library";
pub const BATCH_ITEM_OWNER_ID: &str = "batch-item";

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn open(db_path: &Path) -> AppResult<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.init_schema()?;
        db.migrate_v2_settings_defaults()?;
        Ok(db)
    }

    pub fn migrate_v2_settings_defaults(&self) -> AppResult<()> {
        let conn = self.conn.lock();

        let mut batch_updates: Vec<(String, String)> = Vec::new();
        {
            let mut stmt =
                conn.prepare("SELECT id, shared_settings_json FROM batches")?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (id, raw) = row?;
                let mut settings: EditSettings =
                    serde_json::from_str(&raw).unwrap_or_default();
                if settings.upgrade_to_v2_defaults() {
                    if let Ok(serialized) = serde_json::to_string(&settings) {
                        batch_updates.push((id, serialized));
                    }
                }
            }
        }

        let mut project_updates: Vec<(String, String)> = Vec::new();
        {
            let mut stmt =
                conn.prepare("SELECT id, settings_json FROM projects")?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (id, raw) = row?;
                let mut settings: EditSettings =
                    serde_json::from_str(&raw).unwrap_or_default();
                if settings.upgrade_to_v2_defaults() {
                    if let Ok(serialized) = serde_json::to_string(&settings) {
                        project_updates.push((id, serialized));
                    }
                }
            }
        }

        if !batch_updates.is_empty() || !project_updates.is_empty() {
            conn.execute_batch("BEGIN IMMEDIATE;")?;
            let res: Result<(), rusqlite::Error> = (|| {
                for (id, json) in &batch_updates {
                    conn.execute(
                        "UPDATE batches SET shared_settings_json = ?1 WHERE id = ?2",
                        params![json, id],
                    )?;
                }
                for (id, json) in &project_updates {
                    conn.execute(
                        "UPDATE projects SET settings_json = ?1 WHERE id = ?2",
                        params![json, id],
                    )?;
                }
                Ok(())
            })();
            match res {
                Ok(()) => conn.execute_batch("COMMIT;")?,
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    return Err(e.into());
                }
            }
        }

        Ok(())
    }

    fn init_schema(&self) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                settings_json TEXT NOT NULL,
                active_subtitle_version INTEGER NOT NULL DEFAULT 0,
                detected_language TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending_upload',
                storage_key TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL DEFAULT 0,
                duration_ms INTEGER,
                width INTEGER,
                height INTEGER,
                video_codec TEXT,
                audio_codec TEXT,
                frame_rate TEXT,
                pixel_format TEXT,
                has_audio INTEGER NOT NULL DEFAULT 0,
                checksum TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_assets_project_kind ON assets(project_id, kind);

            CREATE TABLE IF NOT EXISTS subtitle_cues (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                version INTEGER NOT NULL DEFAULT 1,
                sequence INTEGER NOT NULL,
                start_ms INTEGER NOT NULL,
                end_ms INTEGER NOT NULL,
                text TEXT NOT NULL,
                words_json TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_subtitle_cues_project_version ON subtitle_cues(project_id, version, sequence);

            CREATE TABLE IF NOT EXISTS processing_jobs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                stage TEXT NOT NULL DEFAULT 'queued',
                progress REAL,
                idempotency_key TEXT,
                settings_snapshot_json TEXT,
                subtitle_version INTEGER,
                output_asset_id TEXT,
                error_code TEXT,
                error_message_safe TEXT,
                internal_diagnostics TEXT,
                attempt_count INTEGER NOT NULL DEFAULT 1,
                started_at TEXT,
                finished_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_jobs_project_status ON processing_jobs(project_id, status);

            CREATE TABLE IF NOT EXISTS batches (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                name TEXT NOT NULL,
                library_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                shared_settings_json TEXT NOT NULL,
                mapping_mode TEXT NOT NULL DEFAULT 'one_to_one',
                output_dir TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS batch_items (
                id TEXT PRIMARY KEY,
                batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
                sort_order INTEGER NOT NULL DEFAULT 0,
                selected INTEGER NOT NULL DEFAULT 1,
                title TEXT NOT NULL,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                source_asset_id TEXT,
                logo_asset_id TEXT,
                outro_asset_id TEXT,
                use_custom_settings INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_batch_items_batch_order ON batch_items(batch_id, sort_order);
            "#,
        )?;
        Ok(())
    }

    pub fn create_project(&self, name: &str, settings: &EditSettings) -> AppResult<ProjectRecord> {
        self.create_project_with_owner(DEFAULT_OWNER_ID, name, settings)
    }

    pub fn create_project_with_owner(
        &self,
        owner_id: &str,
        name: &str,
        settings: &EditSettings,
    ) -> AppResult<ProjectRecord> {
        let id = Uuid::new_v4().to_string();
        let now = now_iso();
        let settings_str = serde_json::to_string(settings)?;
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO projects (id, owner_id, name, status, settings_json, active_subtitle_version, detected_language, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'draft', ?4, 0, NULL, ?5, ?6)",
            params![id, owner_id, name.trim(), settings_str, now, now],
        )?;
        drop(conn);
        self.get_project(&id)
    }

    pub fn get_project(&self, project_id: &str) -> AppResult<ProjectRecord> {
        let conn = self.conn.lock();
        let row = conn
            .query_row(
                "SELECT id, owner_id, name, status, settings_json, active_subtitle_version, detected_language, created_at, updated_at
                 FROM projects WHERE id = ?1",
                params![project_id],
                |r| {
                    let settings_raw: String = r.get(4)?;
                    let mut settings: EditSettings = serde_json::from_str(&settings_raw).unwrap_or_default();
                    settings.upgrade_to_v2_defaults();
                    Ok(ProjectRecord {
                        id: r.get(0)?,
                        owner_id: r.get(1)?,
                        name: r.get(2)?,
                        status: r.get(3)?,
                        settings_json: settings,
                        active_subtitle_version: r.get(5)?,
                        detected_language: r.get(6)?,
                        created_at: r.get(7)?,
                        updated_at: r.get(8)?,
                    })
                },
            )
            .optional()?;
        row.ok_or_else(|| AppError::not_found("Project not found."))
    }

    pub fn list_projects(&self) -> AppResult<Vec<ProjectRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, owner_id, name, status, settings_json, active_subtitle_version, detected_language, created_at, updated_at
             FROM projects WHERE owner_id = ?1 ORDER BY updated_at DESC",
        )?;
        let iter = stmt.query_map(params![DEFAULT_OWNER_ID], |r| {
            let settings_raw: String = r.get(4)?;
            let mut settings: EditSettings = serde_json::from_str(&settings_raw).unwrap_or_default();
            settings.upgrade_to_v2_defaults();
            Ok(ProjectRecord {
                id: r.get(0)?,
                owner_id: r.get(1)?,
                name: r.get(2)?,
                status: r.get(3)?,
                settings_json: settings,
                active_subtitle_version: r.get(5)?,
                detected_language: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
            })
        })?;
        let mut out = Vec::new();
        for item in iter {
            out.push(item?);
        }
        Ok(out)
    }

    pub fn update_project(
        &self,
        project_id: &str,
        name: Option<&str>,
        status: Option<&str>,
        settings: Option<&EditSettings>,
        active_sub_ver: Option<i64>,
        detected_language: Option<&str>,
    ) -> AppResult<ProjectRecord> {
        let mut current = self.get_project(project_id)?;
        if let Some(n) = name {
            current.name = n.trim().to_string();
        }
        if let Some(st) = status {
            current.status = st.to_string();
        }
        if let Some(cfg) = settings {
            current.settings_json = cfg.clone();
        }
        if let Some(ver) = active_sub_ver {
            current.active_subtitle_version = ver;
        }
        if let Some(lang) = detected_language {
            current.detected_language = Some(lang.to_string());
        }
        current.updated_at = now_iso();
        let settings_str = serde_json::to_string(&current.settings_json)?;
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE projects
             SET name = ?1, status = ?2, settings_json = ?3, active_subtitle_version = ?4, detected_language = ?5, updated_at = ?6
             WHERE id = ?7",
            params![
                current.name,
                current.status,
                settings_str,
                current.active_subtitle_version,
                current.detected_language,
                current.updated_at,
                project_id
            ],
        )?;
        Ok(current)
    }

    pub fn delete_project(&self, project_id: &str) -> AppResult<()> {
        let conn = self.conn.lock();
        let affected = conn.execute("DELETE FROM projects WHERE id = ?1", params![project_id])?;
        if affected == 0 {
            return Err(AppError::not_found("Project not found."));
        }
        Ok(())
    }

    pub fn insert_asset(&self, asset: &AssetRecord) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO assets (
                id, project_id, kind, status, storage_key, original_filename, mime_type,
                size_bytes, duration_ms, width, height, video_codec, audio_codec,
                frame_rate, pixel_format, has_audio, checksum, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                asset.id,
                asset.project_id,
                asset.kind,
                asset.status,
                asset.storage_key,
                asset.original_filename,
                asset.mime_type,
                asset.size_bytes as i64,
                asset.duration_ms,
                asset.width.map(|v| v as i64),
                asset.height.map(|v| v as i64),
                asset.video_codec,
                asset.audio_codec,
                asset.frame_rate,
                asset.pixel_format,
                if asset.has_audio { 1 } else { 0 },
                asset.checksum,
                asset.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn update_asset(&self, asset: &AssetRecord) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE assets SET
                status = ?1, mime_type = ?2, size_bytes = ?3, duration_ms = ?4,
                width = ?5, height = ?6, video_codec = ?7, audio_codec = ?8,
                frame_rate = ?9, pixel_format = ?10, has_audio = ?11, checksum = ?12
             WHERE id = ?13",
            params![
                asset.status,
                asset.mime_type,
                asset.size_bytes as i64,
                asset.duration_ms,
                asset.width.map(|v| v as i64),
                asset.height.map(|v| v as i64),
                asset.video_codec,
                asset.audio_codec,
                asset.frame_rate,
                asset.pixel_format,
                if asset.has_audio { 1 } else { 0 },
                asset.checksum,
                asset.id,
            ],
        )?;
        Ok(())
    }

    fn row_to_asset(r: &rusqlite::Row<'_>) -> rusqlite::Result<AssetRecord> {
        let size_i64: i64 = r.get(7)?;
        let width_opt: Option<i64> = r.get(9)?;
        let height_opt: Option<i64> = r.get(10)?;
        let has_audio_int: i64 = r.get(15)?;
        Ok(AssetRecord {
            id: r.get(0)?,
            project_id: r.get(1)?,
            kind: r.get(2)?,
            status: r.get(3)?,
            storage_key: r.get(4)?,
            original_filename: r.get(5)?,
            mime_type: r.get(6)?,
            size_bytes: size_i64.max(0) as u64,
            duration_ms: r.get(8)?,
            width: width_opt.map(|v| v as u32),
            height: height_opt.map(|v| v as u32),
            video_codec: r.get(11)?,
            audio_codec: r.get(12)?,
            frame_rate: r.get(13)?,
            pixel_format: r.get(14)?,
            has_audio: has_audio_int != 0,
            checksum: r.get(16)?,
            stream_url: None,
            created_at: r.get(17)?,
        })
    }

    pub fn get_asset(&self, asset_id: &str) -> AppResult<AssetRecord> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, project_id, kind, status, storage_key, original_filename, mime_type,
                    size_bytes, duration_ms, width, height, video_codec, audio_codec,
                    frame_rate, pixel_format, has_audio, checksum, created_at
             FROM assets WHERE id = ?1",
            params![asset_id],
            Self::row_to_asset,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Asset not found."))
    }

    pub fn list_project_assets(&self, project_id: &str) -> AppResult<Vec<AssetRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, kind, status, storage_key, original_filename, mime_type,
                    size_bytes, duration_ms, width, height, video_codec, audio_codec,
                    frame_rate, pixel_format, has_audio, checksum, created_at
             FROM assets WHERE project_id = ?1 ORDER BY created_at DESC",
        )?;
        let iter = stmt.query_map(params![project_id], Self::row_to_asset)?;
        let mut out = Vec::new();
        for item in iter {
            out.push(item?);
        }
        Ok(out)
    }

    pub fn find_ready_asset(
        &self,
        project_id: &str,
        kind: &str,
        specific_id: Option<&str>,
    ) -> AppResult<Option<AssetRecord>> {
        let assets = self.list_project_assets(project_id)?;
        Ok(assets.into_iter().find(|a| {
            a.kind == kind
                && a.status == "ready"
                && specific_id.map_or(true, |sid| a.id == sid)
        }))
    }

    pub fn delete_asset_row(&self, asset_id: &str) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM assets WHERE id = ?1", params![asset_id])?;
        Ok(())
    }

    pub fn list_project_assets_asc(&self, project_id: &str) -> AppResult<Vec<AssetRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, kind, status, storage_key, original_filename, mime_type,
                    size_bytes, duration_ms, width, height, video_codec, audio_codec,
                    frame_rate, pixel_format, has_audio, checksum, created_at
             FROM assets WHERE project_id = ?1 ORDER BY created_at ASC, rowid ASC",
        )?;
        let iter = stmt.query_map(params![project_id], Self::row_to_asset)?;
        let mut out = Vec::new();
        for item in iter {
            out.push(item?);
        }
        Ok(out)
    }

    pub fn count_storage_key_refs(&self, storage_key: &str) -> AppResult<usize> {
        let conn = self.conn.lock();
        let cnt: i64 = conn.query_row(
            "SELECT COUNT(*) FROM assets WHERE storage_key = ?1",
            params![storage_key],
            |r| r.get(0),
        )?;
        Ok(cnt.max(0) as usize)
    }

    pub fn count_subtitle_cues(&self, project_id: &str, version: i64) -> AppResult<usize> {
        if version <= 0 {
            return Ok(0);
        }
        let conn = self.conn.lock();
        let cnt: i64 = conn.query_row(
            "SELECT COUNT(*) FROM subtitle_cues WHERE project_id = ?1 AND version = ?2",
            params![project_id, version],
            |r| r.get(0),
        )?;
        Ok(cnt.max(0) as usize)
    }

    pub fn max_subtitle_version(&self, project_id: &str) -> AppResult<i64> {
        let conn = self.conn.lock();
        let max_v: Option<i64> = conn.query_row(
            "SELECT MAX(version) FROM subtitle_cues WHERE project_id = ?1",
            params![project_id],
            |r| r.get(0),
        )?;
        Ok(max_v.unwrap_or(0))
    }

    pub fn get_subtitle_cues(&self, project_id: &str, version: i64) -> AppResult<Vec<SubtitleCueItem>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, sequence, start_ms, end_ms, text, words_json
             FROM subtitle_cues
             WHERE project_id = ?1 AND version = ?2
             ORDER BY sequence ASC",
        )?;
        let iter = stmt.query_map(params![project_id, version], |r| {
            let seq: i64 = r.get(1)?;
            let words_raw: Option<String> = r.get(5)?;
            let words_json = words_raw.and_then(|s| serde_json::from_str::<Value>(&s).ok());
            Ok(SubtitleCueItem {
                id: Some(r.get(0)?),
                sequence: seq.max(1) as usize,
                start_ms: r.get(2)?,
                end_ms: r.get(3)?,
                text: r.get(4)?,
                words_json,
            })
        })?;
        let mut out = Vec::new();
        for item in iter {
            out.push(item?);
        }
        Ok(out)
    }

    pub fn insert_subtitle_version(
        &self,
        project_id: &str,
        version: i64,
        cues: &[SubtitleCueItem],
    ) -> AppResult<Vec<SubtitleCueItem>> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let now = now_iso();
        let mut saved = Vec::with_capacity(cues.len());
        for (idx, cue) in cues.iter().enumerate() {
            let id = Uuid::new_v4().to_string();
            let seq = idx + 1;
            let words_str = cue
                .words_json
                .as_ref()
                .and_then(|w| serde_json::to_string(w).ok());
            tx.execute(
                "INSERT INTO subtitle_cues (id, project_id, version, sequence, start_ms, end_ms, text, words_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![id, project_id, version, seq as i64, cue.start_ms, cue.end_ms, cue.text, words_str, now],
            )?;
            saved.push(SubtitleCueItem {
                id: Some(id),
                sequence: seq,
                start_ms: cue.start_ms,
                end_ms: cue.end_ms,
                text: cue.text.clone(),
                words_json: cue.words_json.clone(),
            });
        }
        tx.commit()?;
        Ok(saved)
    }

    fn row_to_job(r: &rusqlite::Row<'_>) -> rusqlite::Result<ProcessingJobRecord> {
        let snap_raw: Option<String> = r.get(7)?;
        let snap_val = snap_raw.and_then(|s| serde_json::from_str::<Value>(&s).ok());
        Ok(ProcessingJobRecord {
            id: r.get(0)?,
            project_id: r.get(1)?,
            kind: r.get(2)?,
            status: r.get(3)?,
            stage: r.get(4)?,
            progress: r.get(5)?,
            idempotency_key: r.get(6)?,
            settings_snapshot_json: snap_val,
            subtitle_version: r.get(8)?,
            output_asset_id: r.get(9)?,
            error_code: r.get(10)?,
            error_message_safe: r.get(11)?,
            internal_diagnostics: r.get(12)?,
            attempt_count: r.get(13)?,
            started_at: r.get(14)?,
            finished_at: r.get(15)?,
            created_at: r.get(16)?,
            updated_at: r.get(17)?,
        })
    }

    pub fn insert_job(&self, job: &ProcessingJobRecord) -> AppResult<()> {
        let snap_str = job
            .settings_snapshot_json
            .as_ref()
            .and_then(|v| serde_json::to_string(v).ok());
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO processing_jobs (
                id, project_id, kind, status, stage, progress, idempotency_key,
                settings_snapshot_json, subtitle_version, output_asset_id,
                error_code, error_message_safe, internal_diagnostics, attempt_count,
                started_at, finished_at, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                job.id,
                job.project_id,
                job.kind,
                job.status,
                job.stage,
                job.progress,
                job.idempotency_key,
                snap_str,
                job.subtitle_version,
                job.output_asset_id,
                job.error_code,
                job.error_message_safe,
                job.internal_diagnostics,
                job.attempt_count,
                job.started_at,
                job.finished_at,
                job.created_at,
                job.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn update_job(&self, job: &ProcessingJobRecord) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE processing_jobs SET
                status = ?1, stage = ?2, progress = ?3, subtitle_version = ?4,
                output_asset_id = ?5, error_code = ?6, error_message_safe = ?7,
                internal_diagnostics = ?8, attempt_count = ?9, started_at = ?10,
                finished_at = ?11, updated_at = ?12
             WHERE id = ?13",
            params![
                job.status,
                job.stage,
                job.progress,
                job.subtitle_version,
                job.output_asset_id,
                job.error_code,
                job.error_message_safe,
                job.internal_diagnostics,
                job.attempt_count,
                job.started_at,
                job.finished_at,
                job.updated_at,
                job.id,
            ],
        )?;
        Ok(())
    }

    pub fn get_job(&self, job_id: &str) -> AppResult<ProcessingJobRecord> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, project_id, kind, status, stage, progress, idempotency_key,
                    settings_snapshot_json, subtitle_version, output_asset_id,
                    error_code, error_message_safe, internal_diagnostics, attempt_count,
                    started_at, finished_at, created_at, updated_at
             FROM processing_jobs WHERE id = ?1",
            params![job_id],
            Self::row_to_job,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Job not found."))
    }

    pub fn list_project_jobs(&self, project_id: &str) -> AppResult<Vec<ProcessingJobRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, kind, status, stage, progress, idempotency_key,
                    settings_snapshot_json, subtitle_version, output_asset_id,
                    error_code, error_message_safe, internal_diagnostics, attempt_count,
                    started_at, finished_at, created_at, updated_at
             FROM processing_jobs WHERE project_id = ?1 ORDER BY created_at DESC",
        )?;
        let iter = stmt.query_map(params![project_id], Self::row_to_job)?;
        let mut out = Vec::new();
        for item in iter {
            out.push(item?);
        }
        Ok(out)
    }

    fn row_to_batch(r: &rusqlite::Row<'_>) -> rusqlite::Result<BatchRecord> {
        let settings_raw: String = r.get(4)?;
        let mut shared_settings: EditSettings = serde_json::from_str(&settings_raw).unwrap_or_default();
        shared_settings.upgrade_to_v2_defaults();
        Ok(BatchRecord {
            id: r.get(0)?,
            owner_id: r.get(1)?,
            name: r.get(2)?,
            library_project_id: r.get(3)?,
            shared_settings_json: shared_settings,
            mapping_mode: r.get(5)?,
            output_dir: r.get(6)?,
            created_at: r.get(7)?,
            updated_at: r.get(8)?,
        })
    }

    pub fn create_batch(
        &self,
        name: &str,
        library_project_id: &str,
        shared_settings: &EditSettings,
    ) -> AppResult<BatchRecord> {
        let id = Uuid::new_v4().to_string();
        let now = now_iso();
        let settings_str = serde_json::to_string(shared_settings)?;
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO batches (id, owner_id, name, library_project_id, shared_settings_json, mapping_mode, output_dir, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'one_to_one', NULL, ?6, ?7)",
            params![id, DEFAULT_OWNER_ID, name.trim(), library_project_id, settings_str, now, now],
        )?;
        drop(conn);
        self.get_batch(&id)
    }

    pub fn get_batch(&self, batch_id: &str) -> AppResult<BatchRecord> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, owner_id, name, library_project_id, shared_settings_json, mapping_mode, output_dir, created_at, updated_at
             FROM batches WHERE id = ?1",
            params![batch_id],
            Self::row_to_batch,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Batch automation workspace not found."))
    }

    pub fn list_batches(&self) -> AppResult<Vec<BatchRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, owner_id, name, library_project_id, shared_settings_json, mapping_mode, output_dir, created_at, updated_at
             FROM batches WHERE owner_id = ?1 ORDER BY updated_at DESC",
        )?;
        let iter = stmt.query_map(params![DEFAULT_OWNER_ID], Self::row_to_batch)?;
        let mut out = Vec::new();
        for item in iter {
            out.push(item?);
        }
        Ok(out)
    }

    pub fn update_batch(
        &self,
        batch_id: &str,
        name: Option<&str>,
        mapping_mode: Option<&str>,
        output_dir: Option<Option<&str>>,
        shared_settings: Option<&EditSettings>,
    ) -> AppResult<BatchRecord> {
        let mut current = self.get_batch(batch_id)?;
        if let Some(n) = name {
            if !n.trim().is_empty() {
                current.name = n.trim().to_string();
            }
        }
        if let Some(mm) = mapping_mode {
            current.mapping_mode = mm.trim().to_string();
        }
        if let Some(od_opt) = output_dir {
            current.output_dir = od_opt
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
        }
        if let Some(ss) = shared_settings {
            current.shared_settings_json = ss.clone();
        }
        current.updated_at = now_iso();
        let settings_str = serde_json::to_string(&current.shared_settings_json)?;
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE batches
             SET name = ?1, shared_settings_json = ?2, mapping_mode = ?3, output_dir = ?4, updated_at = ?5
             WHERE id = ?6",
            params![
                current.name,
                settings_str,
                current.mapping_mode,
                current.output_dir,
                current.updated_at,
                batch_id
            ],
        )?;
        Ok(current)
    }

    pub fn touch_batch(&self, batch_id: &str) -> AppResult<()> {
        let now = now_iso();
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE batches SET updated_at = ?1 WHERE id = ?2",
            params![now, batch_id],
        )?;
        Ok(())
    }

    pub fn delete_batch(&self, batch_id: &str) -> AppResult<()> {
        let conn = self.conn.lock();
        let affected = conn.execute("DELETE FROM batches WHERE id = ?1", params![batch_id])?;
        if affected == 0 {
            return Err(AppError::not_found("Batch automation workspace not found."));
        }
        Ok(())
    }

    fn row_to_batch_item(r: &rusqlite::Row<'_>) -> rusqlite::Result<BatchItemRecord> {
        let sort_i64: i64 = r.get(2)?;
        let sel_i64: i64 = r.get(3)?;
        let custom_i64: i64 = r.get(9)?;
        Ok(BatchItemRecord {
            id: r.get(0)?,
            batch_id: r.get(1)?,
            sort_order: sort_i64.max(0) as usize,
            selected: sel_i64 != 0,
            title: r.get(4)?,
            project_id: r.get(5)?,
            source_asset_id: r.get(6)?,
            logo_asset_id: r.get(7)?,
            outro_asset_id: r.get(8)?,
            use_custom_settings: custom_i64 != 0,
            created_at: r.get(10)?,
            updated_at: r.get(11)?,
        })
    }

    pub fn insert_batch_item(&self, item: &BatchItemRecord) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO batch_items (
                id, batch_id, sort_order, selected, title, project_id,
                source_asset_id, logo_asset_id, outro_asset_id, use_custom_settings,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                item.id,
                item.batch_id,
                item.sort_order as i64,
                if item.selected { 1 } else { 0 },
                item.title,
                item.project_id,
                item.source_asset_id,
                item.logo_asset_id,
                item.outro_asset_id,
                if item.use_custom_settings { 1 } else { 0 },
                item.created_at,
                item.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn update_batch_item(&self, item: &BatchItemRecord) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE batch_items SET
                sort_order = ?1, selected = ?2, title = ?3,
                source_asset_id = ?4, logo_asset_id = ?5, outro_asset_id = ?6,
                use_custom_settings = ?7, updated_at = ?8
             WHERE id = ?9",
            params![
                item.sort_order as i64,
                if item.selected { 1 } else { 0 },
                item.title,
                item.source_asset_id,
                item.logo_asset_id,
                item.outro_asset_id,
                if item.use_custom_settings { 1 } else { 0 },
                item.updated_at,
                item.id,
            ],
        )?;
        Ok(())
    }

    pub fn get_batch_item(&self, item_id: &str) -> AppResult<BatchItemRecord> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, batch_id, sort_order, selected, title, project_id,
                    source_asset_id, logo_asset_id, outro_asset_id, use_custom_settings,
                    created_at, updated_at
             FROM batch_items WHERE id = ?1",
            params![item_id],
            Self::row_to_batch_item,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Batch item not found."))
    }

    pub fn list_batch_items(&self, batch_id: &str) -> AppResult<Vec<BatchItemRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, batch_id, sort_order, selected, title, project_id,
                    source_asset_id, logo_asset_id, outro_asset_id, use_custom_settings,
                    created_at, updated_at
             FROM batch_items WHERE batch_id = ?1 ORDER BY sort_order ASC, created_at ASC",
        )?;
        let iter = stmt.query_map(params![batch_id], Self::row_to_batch_item)?;
        let mut out = Vec::new();
        for item in iter {
            out.push(item?);
        }
        Ok(out)
    }

    pub fn delete_batch_item_row(&self, item_id: &str) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM batch_items WHERE id = ?1", params![item_id])?;
        Ok(())
    }

    /// Creates a consistent, compacted, atomic online snapshot of the live SQLite database
    /// (including all WAL state) at `dest_path` using SQLite's `VACUUM INTO`.
    pub fn backup_to_file(&self, dest_path: &Path) -> AppResult<()> {
        if let Some(parent) = dest_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if dest_path.exists() {
            std::fs::remove_file(dest_path)?;
        }
        let dest_str = dest_path.to_string_lossy().to_string();
        let conn = self.conn.lock();
        conn.execute("VACUUM INTO ?1", params![dest_str])?;
        Ok(())
    }

    /// Returns `(user_project_count, batch_count, ready_asset_count)` for backup manifests.
    pub fn count_user_entities(&self) -> AppResult<(usize, usize, usize)> {
        let conn = self.conn.lock();
        let projects: i64 = conn.query_row(
            "SELECT COUNT(*) FROM projects WHERE owner_id = ?1",
            params![DEFAULT_OWNER_ID],
            |r| r.get(0),
        )?;
        let batches: i64 =
            conn.query_row("SELECT COUNT(*) FROM batches", [], |r| r.get(0))?;
        let assets: i64 = conn.query_row(
            "SELECT COUNT(*) FROM assets WHERE status = 'ready'",
            [],
            |r| r.get(0),
        )?;
        Ok((
            projects.max(0) as usize,
            batches.max(0) as usize,
            assets.max(0) as usize,
        ))
    }

    /// Atomically restores all tables from `src_db_path` into the active SQLite connection
    /// without closing or unlocking the database file (safe on Windows, macOS, and Linux).
    pub fn restore_from_file(&self, src_db_path: &Path) -> AppResult<(usize, usize)> {
        if !src_db_path.is_file() {
            return Err(AppError::not_found(format!(
                "Backup database file not found: {}",
                src_db_path.display()
            )));
        }

        let src_str = src_db_path.to_string_lossy().to_string();
        let conn = self.conn.lock();

        conn.execute("PRAGMA foreign_keys = OFF", [])?;
        if let Err(err) = conn.execute("ATTACH DATABASE ?1 AS backup_src", params![src_str]) {
            let _ = conn.execute("PRAGMA foreign_keys = ON", []);
            return Err(err.into());
        }

        let restore_result: AppResult<()> = (|| {
            let has_batches: i64 = conn.query_row(
                "SELECT COUNT(*) FROM backup_src.sqlite_master WHERE type = 'table' AND name = 'batches'",
                [],
                |r| r.get(0),
            )?;
            let has_batch_items: i64 = conn.query_row(
                "SELECT COUNT(*) FROM backup_src.sqlite_master WHERE type = 'table' AND name = 'batch_items'",
                [],
                |r| r.get(0),
            )?;

            conn.execute_batch("BEGIN IMMEDIATE;")?;
            let swap_res: Result<(), rusqlite::Error> = (|| {
                conn.execute("DELETE FROM main.batch_items", [])?;
                conn.execute("DELETE FROM main.batches", [])?;
                conn.execute("DELETE FROM main.processing_jobs", [])?;
                conn.execute("DELETE FROM main.subtitle_cues", [])?;
                conn.execute("DELETE FROM main.assets", [])?;
                conn.execute("DELETE FROM main.projects", [])?;

                conn.execute(
                    "INSERT INTO main.projects (id, owner_id, name, status, settings_json, active_subtitle_version, detected_language, created_at, updated_at)
                     SELECT id, owner_id, name, status, settings_json, active_subtitle_version, detected_language, created_at, updated_at
                     FROM backup_src.projects",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO main.assets (id, project_id, kind, status, storage_key, original_filename, mime_type, size_bytes, duration_ms, width, height, video_codec, audio_codec, frame_rate, pixel_format, has_audio, checksum, created_at)
                     SELECT id, project_id, kind, status, storage_key, original_filename, mime_type, size_bytes, duration_ms, width, height, video_codec, audio_codec, frame_rate, pixel_format, has_audio, checksum, created_at
                     FROM backup_src.assets",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO main.subtitle_cues (id, project_id, version, sequence, start_ms, end_ms, text, words_json, created_at)
                     SELECT id, project_id, version, sequence, start_ms, end_ms, text, words_json, created_at
                     FROM backup_src.subtitle_cues",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO main.processing_jobs (id, project_id, kind, status, stage, progress, idempotency_key, settings_snapshot_json, subtitle_version, output_asset_id, error_code, error_message_safe, internal_diagnostics, attempt_count, started_at, finished_at, created_at, updated_at)
                     SELECT id, project_id, kind,
                            CASE WHEN status IN ('queued', 'running') THEN 'cancelled' ELSE status END,
                            CASE WHEN status IN ('queued', 'running') THEN 'cancelled' ELSE stage END,
                            progress, idempotency_key, settings_snapshot_json, subtitle_version, output_asset_id, error_code, error_message_safe, internal_diagnostics, attempt_count, started_at, finished_at, created_at, updated_at
                     FROM backup_src.processing_jobs",
                    [],
                )?;

                if has_batches > 0 {
                    conn.execute(
                        "INSERT INTO main.batches (id, owner_id, name, library_project_id, shared_settings_json, mapping_mode, output_dir, created_at, updated_at)
                         SELECT id, owner_id, name, library_project_id, shared_settings_json, mapping_mode, output_dir, created_at, updated_at
                         FROM backup_src.batches",
                        [],
                    )?;
                }
                if has_batch_items > 0 {
                    conn.execute(
                        "INSERT INTO main.batch_items (id, batch_id, sort_order, selected, title, project_id, source_asset_id, logo_asset_id, outro_asset_id, use_custom_settings, created_at, updated_at)
                         SELECT id, batch_id, sort_order, selected, title, project_id, source_asset_id, logo_asset_id, outro_asset_id, use_custom_settings, created_at, updated_at
                         FROM backup_src.batch_items",
                        [],
                    )?;
                }
                Ok(())
            })();

            match swap_res {
                Ok(()) => {
                    conn.execute_batch("COMMIT;")?;
                    Ok(())
                }
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    Err(e.into())
                }
            }
        })();

        let _ = conn.execute("DETACH DATABASE backup_src", []);
        let _ = conn.execute("PRAGMA foreign_keys = ON", []);

        restore_result?;

        let projects: i64 = conn.query_row(
            "SELECT COUNT(*) FROM projects WHERE owner_id = ?1",
            params![DEFAULT_OWNER_ID],
            |r| r.get(0),
        )?;
        let batches: i64 =
            conn.query_row("SELECT COUNT(*) FROM batches", [], |r| r.get(0))?;
        drop(conn);
        self.migrate_v2_settings_defaults()?;
        Ok((projects.max(0) as usize, batches.max(0) as usize))
    }
}
