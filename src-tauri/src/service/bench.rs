//! 并发基准测试（性能压测）。
//!
//! 与单次发送共用 `HttpService::execute`（变量替换 / 鉴权 / Cookie 全部一致），
//! 用信号量限制并发度，聚合出延迟分位数与状态分布。测试在 0 延迟的本地
//! echo 服务上做，避免真实网络抖动让断言不可靠。

use reqora_core::models::RequestSpec;
use reqora_core::service::http::HttpService;
use futures_util::future::join_all;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Semaphore;

/// 单轮压测的请求总数上限。
pub const MAX_BENCH_TOTAL: usize = 1_000;
/// 并发度上限：过高会耗尽文件描述符，64 已远超常规调试场景。
pub const MAX_BENCH_CONCURRENCY: usize = 64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyStats {
    pub min_ms: f64,
    pub avg_ms: f64,
    pub p50_ms: f64,
    pub p90_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkReport {
    pub total: usize,
    pub success: usize,
    pub failed: usize,
    pub time_ms: u64,
    pub rps: f64,
    pub latency: LatencyStats,
    /// 状态码 → 次数；传输层失败记为 0。
    pub statuses: BTreeMap<u16, usize>,
    /// 去重后的错误样本（最多 5 条）。
    pub errors: Vec<String>,
    pub error_count: usize,
}

/// 单个请求的结果，聚合的最小单元。
struct BenchOutcome {
    status: u16,
    ok: bool,
    time_ms: u64,
    error: Option<String>,
}

fn percentile(sorted: &[u64], ratio: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    // 最近邻秩（ceil）分位数，与常见压测工具口径一致。
    let index = ((sorted.len() as f64) * ratio).ceil() as usize;
    let index = index.clamp(1, sorted.len());
    sorted[index - 1] as f64
}

fn aggregate(outcomes: &[BenchOutcome], elapsed_ms: u64) -> BenchmarkReport {
    let total = outcomes.len();
    let mut latencies: Vec<u64> = outcomes.iter().map(|outcome| outcome.time_ms).collect();
    latencies.sort_unstable();
    let sum: u64 = latencies.iter().sum();
    let avg = if total > 0 { sum as f64 / total as f64 } else { 0.0 };

    let mut statuses: BTreeMap<u16, usize> = BTreeMap::new();
    let mut errors: Vec<String> = Vec::new();
    let mut success = 0usize;
    let mut error_count = 0usize;
    for outcome in outcomes {
        let entry = statuses.entry(outcome.status).or_insert(0);
        *entry += 1;
        if outcome.ok {
            success += 1;
        } else {
            error_count += 1;
            if let Some(message) = &outcome.error {
                let message = message.clone();
                if errors.len() < 5 && !errors.contains(&message) {
                    errors.push(message);
                }
            }
        }
    }

    let time_ms = elapsed_ms.max(1);
    BenchmarkReport {
        total,
        success,
        failed: total - success,
        time_ms,
        rps: (total as f64) / (time_ms as f64 / 1000.0),
        latency: LatencyStats {
            min_ms: latencies.first().map(|v| *v as f64).unwrap_or(0.0),
            avg_ms: (avg * 100.0).round() / 100.0,
            p50_ms: percentile(&latencies, 0.50),
            p90_ms: percentile(&latencies, 0.90),
            p95_ms: percentile(&latencies, 0.95),
            p99_ms: percentile(&latencies, 0.99),
            max_ms: latencies.last().map(|v| *v as f64).unwrap_or(0.0),
        },
        statuses,
        errors,
        error_count,
    }
}

/// 并发执行 `total` 次请求（同时最多 `concurrency` 个在途），聚合报告。
/// 每次执行使用独立请求 id（`bench-<n>`），日志可区分但语义与单发一致。
pub async fn run(
    http: &HttpService,
    spec: &RequestSpec,
    total: usize,
    concurrency: usize,
) -> BenchmarkReport {
    let total = total.clamp(1, MAX_BENCH_TOTAL);
    let concurrency = concurrency.clamp(1, MAX_BENCH_CONCURRENCY);
    let semaphore = Arc::new(Semaphore::new(concurrency));
    let started = Instant::now();

    let futures = (0..total).map(|index| {
        let semaphore = semaphore.clone();
        let mut task_spec = spec.clone();
        task_spec.id = format!("bench-{}", index);
        async move {
            let _permit = semaphore.acquire_owned().await.expect("semaphore closed");
            match http.execute(task_spec, &format!("bench-{}", index)).await {
                Ok(response) => BenchOutcome {
                    status: response.status,
                    ok: response.ok,
                    time_ms: response.time_ms,
                    error: None,
                },
                Err(error) => BenchOutcome {
                    status: 0,
                    ok: false,
                    time_ms: 0,
                    error: Some(error.to_string()),
                },
            }
        }
    });

    let outcomes: Vec<BenchOutcome> = join_all(futures).await;
    aggregate(&outcomes, started.elapsed().as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqora_core::config::Config;
    use reqora_core::models::{AuthSpec, BodySpec};
    use std::collections::BTreeMap;

    fn outcome(status: u16, ok: bool, time_ms: u64, error: Option<&str>) -> BenchOutcome {
        BenchOutcome {
            status,
            ok,
            time_ms,
            error: error.map(String::from),
        }
    }

    #[test]
    fn aggregate_computes_percentiles_and_status_distribution() {
        // 100 个请求：97 个成功（延迟 1..=97），3 个失败（延迟都是 1）。
        // 排序后延迟序列：1,1,1,1,2,3,…,97。
        let mut outcomes = Vec::new();
        for ms in 1..=97 {
            outcomes.push(outcome(200, true, ms, None));
        }
        outcomes.push(outcome(500, false, 1, Some("boom")));
        outcomes.push(outcome(0, false, 1, Some("连接被拒绝")));
        outcomes.push(outcome(0, false, 1, Some("连接被拒绝"))); // 去重后错误样本不增加

        let report = aggregate(&outcomes, 1000);
        assert_eq!(report.total, 100);
        assert_eq!(report.success, 97);
        assert_eq!(report.failed, 3);
        assert_eq!(report.rps, 100.0);
        assert_eq!(report.latency.min_ms, 1.0);
        assert_eq!(report.latency.max_ms, 97.0);
        assert_eq!(report.latency.p50_ms, 47.0); // ceil(100*0.5)=50 → 第 50 个值
        assert_eq!(report.latency.p99_ms, 96.0); // ceil(100*0.99)=99 → 第 99 个值（=96）
        assert_eq!(report.latency.avg_ms, 47.56); // (Σ1..97 + 3) / 100
        assert_eq!(report.statuses.get(&200), Some(&97));
        assert_eq!(report.statuses.get(&500), Some(&1));
        assert_eq!(report.statuses.get(&0), Some(&2));
        assert_eq!(report.errors, vec!["boom".to_string(), "连接被拒绝".to_string()]);
        assert_eq!(report.error_count, 3);
    }

    #[test]
    fn aggregate_handles_empty_and_tiny_runs() {
        let report = aggregate(&[], 0);
        assert_eq!(report.total, 0);
        assert_eq!(report.rps, 0.0);
        assert_eq!(report.latency.p50_ms, 0.0);

        let report = aggregate(&[outcome(200, true, 5, None)], 10);
        assert_eq!(report.rps, 100.0);
        assert_eq!(report.latency.p50_ms, 5.0);
        assert_eq!(report.latency.avg_ms, 5.0);
    }

    #[tokio::test]
    async fn run_against_local_server_reports_counts() {
        // 本地 echo 服务：2xx 返回，统计应全部成功。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { break };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 2048];
                    let _ = socket.read(&mut buf).await;
                    let _ = socket
                        .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
                        .await;
                });
            }
        });

        let http = HttpService {
            config: Config::defaults(),
            cookies: Arc::new(std::sync::Mutex::new(
                reqora_core::service::cookies::CookieStore::default(),
            )),
        };
        let spec = RequestSpec {
            id: "bench".into(),
            name: "bench".into(),
            method: "GET".into(),
            url: format!("http://{address}/ping"),
            headers: vec![],
            query: vec![],
            body: BodySpec::None,
            auth: AuthSpec::None,
            variables: BTreeMap::new(),
            timeout_secs: Some(5),
            follow_redirects: Some(false),
            verify_tls: Some(true),
            proxy_url: None,
            use_cookies: None,
            http_version: None,
        };

        let report = run(&http, &spec, 20, 8).await;
        assert_eq!(report.total, 20);
        assert_eq!(report.success, 20, "report: {report:?}");
        assert_eq!(report.failed, 0);
        assert_eq!(report.statuses.get(&200), Some(&20));
        assert!(report.rps > 0.0);
        server.abort();
    }
}
