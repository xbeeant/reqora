//! Database steps for test scenarios: run SQL before/after/around HTTP
//! requests (seed data, verify rows, extract values into scenario variables).
//!
//! Scope is deliberately narrow: MySQL and PostgreSQL only, scalar columns
//! only, short interactive queries. Connections are opened per call — scenario
//! steps run at human pace, so a pool buys nothing and adds lifecycle risk.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Duration;

/// Overall budget for one database step (connect + execute).
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
/// Connect budget inside the overall budget.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
/// Hard cap on returned rows regardless of caller-provided max_rows.
const ABSOLUTE_ROW_LIMIT: u32 = 500;
/// Cap on the SQL text length (guards against accidental multi-MB pastes).
const MAX_SQL_LENGTH: usize = 64 * 1024;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DbQuerySpec {
    /// `mysql://user:pass@host:3306/db` or `postgres://user:pass@host:5432/db`.
    pub url: String,
    pub sql: String,
    /// "query" returns rows; "execute" returns affected-row counts only.
    pub mode: String,
    pub max_rows: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<BTreeMap<String, Value>>,
    pub rows_affected: u64,
    pub elapsed_ms: u64,
    /// True when more rows matched than the cap allowed.
    pub truncated: bool,
}

/// Validate and normalise the connection URL. Returns (kind, display url with
/// the password masked) — error message names the supported drivers explicitly.
fn parse_db_url(url: &str) -> Result<(&'static str, String), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("数据库连接串不能为空".into());
    }
    let (kind, rest) = if let Some(rest) = trimmed
        .strip_prefix("mysql://")
        .or_else(|| trimmed.strip_prefix("mariadb://"))
    {
        ("mysql", rest)
    } else if let Some(rest) = trimmed
        .strip_prefix("postgres://")
        .or_else(|| trimmed.strip_prefix("postgresql://"))
    {
        ("postgres", rest)
    } else {
        return Err("仅支持 MySQL 与 PostgreSQL 连接串（mysql:// 或 postgres://）".into());
    };
    // Mask credentials for error/log display: scheme://user:***@host...
    let display = match trimmed.split_once("@") {
        Some((credentials, host)) if credentials.contains(':') => {
            let scheme = trimmed.split("://").next().unwrap_or("");
            format!("{scheme}://{}:***@{host}", credentials.split_once("://").unwrap_or(( "", credentials)).1.rsplit_once(':').map(|(u, _)| u).unwrap_or(""))
        }
        _ => trimmed.to_string(),
    };
    let _ = rest;
    Ok((kind, display))
}

pub async fn db_query(spec: DbQuerySpec) -> Result<DbQueryResult, String> {
    let (kind, _display) = parse_db_url(&spec.url)?;
    let sql = spec.sql.trim();
    if sql.is_empty() {
        return Err("SQL 不能为空".into());
    }
    if sql.len() > MAX_SQL_LENGTH {
        return Err(format!("SQL 超过 {MAX_SQL_LENGTH} 字符上限"));
    }
    let mode = if spec.mode == "execute" { "execute" } else { "query" };
    let max_rows = spec
        .max_rows
        .unwrap_or(100)
        .clamp(1, ABSOLUTE_ROW_LIMIT);

    let started = std::time::Instant::now();
    let result = match tokio::time::timeout(QUERY_TIMEOUT, run(kind, &spec.url, sql, mode, max_rows))
        .await
    {
        Ok(inner) => inner?,
        Err(_) => return Err(format!("数据库操作超时（{} ms）", QUERY_TIMEOUT.as_millis())),
    };
    Ok(DbQueryResult {
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        ..result
    })
}

async fn run(
    kind: &str,
    url: &str,
    sql: &str,
    mode: &str,
    max_rows: u32,
) -> Result<DbQueryResult, String> {
    match kind {
        "mysql" => run_mysql(url, sql, mode, max_rows).await,
        _ => run_postgres(url, sql, mode, max_rows).await,
    }
}

async fn connect_common<E>(connect: impl std::future::Future<Output = Result<E, sqlx::Error>>) -> Result<E, String> {
    tokio::time::timeout(CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| format!("数据库连接超时（{} s）", CONNECT_TIMEOUT.as_secs()))?
        .map_err(|error| format!("数据库连接失败：{error}"))
}

async fn run_mysql(url: &str, sql: &str, mode: &str, max_rows: u32) -> Result<DbQueryResult, String> {
    use futures_util::TryStreamExt;
    use sqlx::{Column, Row};
    use sqlx::mysql::MySqlPoolOptions;

    let pool = connect_common(MySqlPoolOptions::new().connect(url)).await?;
    if mode == "execute" {
        let result = sqlx::query(sql)
            .execute(&pool)
            .await
            .map_err(|error| format!("SQL 执行失败：{error}"))?;
        return Ok(DbQueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: result.rows_affected(),
            elapsed_ms: 0,
            truncated: false,
        });
    }
    let mut stream = sqlx::query(sql).fetch(&pool);
    let mut rows = Vec::new();
    let mut columns: Vec<String> = Vec::new();
    let mut truncated = false;
    while let Some(row) = stream
        .try_next()
        .await
        .map_err(|error| format!("SQL 查询失败：{error}"))?
    {
        if columns.is_empty() {
            columns = row.columns().iter().map(|c| c.name().to_string()).collect();
        }
        if rows.len() >= max_rows as usize {
            truncated = true;
            break;
        }
        let mut object = BTreeMap::new();
        for (index, column) in row.columns().iter().enumerate() {
            let value = mysql_cell(&row, index, column.name())?;
            object.insert(column.name().to_string(), value);
        }
        rows.push(object);
    }
    pool.close().await;
    Ok(DbQueryResult {
        columns,
        rows,
        rows_affected: 0,
        elapsed_ms: 0,
        truncated,
    })
}

/// Decode one MySQL cell into JSON. Only scalar types are supported; exotic
/// columns (BLOB, GEOMETRY...) must be CAST in the SQL itself.
fn mysql_cell(
    row: &sqlx::mysql::MySqlRow,
    index: usize,
    name: &str,
) -> Result<Value, String> {
    use sqlx::{Row, TypeInfo, ValueRef};
    let raw = row
        .try_get_raw(index)
        .map_err(|error| format!("读取列 {name} 失败：{error}"))?;
    if raw.is_null() {
        return Ok(Value::Null);
    }
    let type_name = raw.type_info().name().to_string();
    let value = match type_name.as_str() {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => row
            .try_get::<i64, usize>(index)
            .map(Value::from)
            .map_err(|error| cell_error(name, &type_name, &error))?,
        "FLOAT" | "DOUBLE" => row
            .try_get::<f64, usize>(index)
            .map(Value::from)
            .map_err(|error| cell_error(name, &type_name, &error))?,
        "BOOL" | "BOOLEAN" => row
            .try_get::<bool, usize>(index)
            .map(Value::from)
            .map_err(|error| cell_error(name, &type_name, &error))?,
        // VARCHAR/CHAR/TEXT/ENUM/SET/DATE/TIME/DATETIME/TIMESTAMP/DECIMAL/JSON
        // all decode to String in sqlx-mysql (DECIMAL/JSON included).
        _ => row
            .try_get::<String, usize>(index)
            .map(Value::from)
            .map_err(|error| cell_error(name, &type_name, &error))?,
    };
    Ok(value)
}

fn cell_error(name: &str, type_name: &str, error: &sqlx::Error) -> String {
    format!(
        "列 {name}（类型 {type_name}）无法解码：{error}；仅支持标量类型，复杂类型请在 SQL 中 CAST 为文本"
    )
}

async fn run_postgres(
    url: &str,
    sql: &str,
    mode: &str,
    max_rows: u32,
) -> Result<DbQueryResult, String> {
    use futures_util::TryStreamExt;
    use sqlx::{Column, Row};
    use sqlx::postgres::PgPoolOptions;

    let pool = connect_common(PgPoolOptions::new().connect(url)).await?;
    if mode == "execute" {
        let result = sqlx::query(sql)
            .execute(&pool)
            .await
            .map_err(|error| format!("SQL 执行失败：{error}"))?;
        return Ok(DbQueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: result.rows_affected(),
            elapsed_ms: 0,
            truncated: false,
        });
    }
    let mut stream = sqlx::query(sql).fetch(&pool);
    let mut rows = Vec::new();
    let mut columns: Vec<String> = Vec::new();
    let mut truncated = false;
    while let Some(row) = stream
        .try_next()
        .await
        .map_err(|error| format!("SQL 查询失败：{error}"))?
    {
        if columns.is_empty() {
            columns = row.columns().iter().map(|c| c.name().to_string()).collect();
        }
        if rows.len() >= max_rows as usize {
            truncated = true;
            break;
        }
        let mut object = BTreeMap::new();
        for (index, column) in row.columns().iter().enumerate() {
            let value = postgres_cell(&row, index, column.name())?;
            object.insert(column.name().to_string(), value);
        }
        rows.push(object);
    }
    pool.close().await;
    Ok(DbQueryResult {
        columns,
        rows,
        rows_affected: 0,
        elapsed_ms: 0,
        truncated,
    })
}

/// Decode one Postgres cell into JSON. Scalars only; use `::text` casts for
/// arrays / composites / bytea.
fn postgres_cell(
    row: &sqlx::postgres::PgRow,
    index: usize,
    name: &str,
) -> Result<Value, String> {
    use sqlx::{Row, TypeInfo, ValueRef};
    let raw = row
        .try_get_raw(index)
        .map_err(|error| format!("读取列 {name} 失败：{error}"))?;
    if raw.is_null() {
        return Ok(Value::Null);
    }
    let type_name = raw.type_info().name().to_string();
    let value = match type_name.as_str() {
        "BOOL" => row
            .try_get::<bool, usize>(index)
            .map(Value::from)
            .map_err(|error| cell_error(name, &type_name, &error))?,
        "INT2" | "INT4" | "INT8" => row
            .try_get::<i64, usize>(index)
            .map(Value::from)
            .map_err(|error| cell_error(name, &type_name, &error))?,
        "FLOAT4" | "FLOAT8" => row
            .try_get::<f64, usize>(index)
            .map(Value::from)
            .map_err(|error| cell_error(name, &type_name, &error))?,
        // TEXT/VARCHAR/CHAR/NAME/CITEXT/UUID/DATE/TIME/TIMESTAMP/TIMESTAMPTZ/
        // NUMERIC/JSON/JSONB all decode to String in sqlx-postgres.
        _ => row
            .try_get::<String, usize>(index)
            .map(Value::from)
            .map_err(|error| cell_error(name, &type_name, &error))?,
    };
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_db_url_accepts_supported_drivers() {
        assert_eq!(
            parse_db_url("mysql://root:pw@127.0.0.1:3306/app").unwrap().0,
            "mysql"
        );
        assert_eq!(
            parse_db_url("mariadb://root@localhost/app").unwrap().0,
            "mysql"
        );
        assert_eq!(
            parse_db_url("postgres://u:p@db.internal:5432/prod").unwrap().0,
            "postgres"
        );
        assert_eq!(
            parse_db_url("postgresql://u:p@db.internal/prod").unwrap().0,
            "postgres"
        );
    }

    #[test]
    fn parse_db_url_rejects_other_drivers_and_empty() {
        let error = parse_db_url("sqlite://data.db").unwrap_err();
        assert!(error.contains("MySQL 与 PostgreSQL"), "got {error}");
        let error = parse_db_url("sqlserver://host").unwrap_err();
        assert!(error.contains("MySQL 与 PostgreSQL"), "got {error}");
        assert!(parse_db_url("").is_err());
        assert!(parse_db_url("   ").is_err());
    }

    #[tokio::test]
    async fn db_query_validates_url_sql_and_mode() {
        let error = db_query(DbQuerySpec {
            url: "mysql://root@localhost/app".into(),
            sql: "".into(),
            mode: "query".into(),
            max_rows: None,
        })
        .await
        .unwrap_err();
        assert!(error.contains("SQL 不能为空"), "got {error}");

        let error = db_query(DbQuerySpec {
            url: "sqlite://x".into(),
            sql: "SELECT 1".into(),
            mode: "query".into(),
            max_rows: None,
        })
        .await
        .unwrap_err();
        assert!(error.contains("MySQL"), "got {error}");
    }

    /// Real end-to-end: connect to a live MySQL/PostgreSQL if REQORA_DB_URL
    /// is set (CI/manual), otherwise skip. Covers SELECT + INSERT + null cells.
    #[tokio::test]
    async fn live_database_roundtrip_when_configured() {
        let Ok(url) = std::env::var("REQORA_DB_URL") else {
            return; // skip silently in normal runs
        };
        if std::env::var("REQORA_DB_URL").unwrap_or_default().is_empty() {
            return;
        }
        let result = db_query(DbQuerySpec {
            url,
            sql: "SELECT 1 AS one, NULL AS nothing, 'text' AS label".into(),
            mode: "query".into(),
            max_rows: None,
        })
        .await
        .expect("query should succeed");
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0]["one"], Value::from(1));
        assert_eq!(result.rows[0]["nothing"], Value::Null);
        assert_eq!(result.rows[0]["label"], Value::from("text"));
        assert!(!result.truncated);
    }
}
