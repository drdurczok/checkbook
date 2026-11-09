use std::{
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

use axum::{
    body::Body,
    extract::Request,
    http::{HeaderValue, header},
    middleware::Next,
    response::Response,
};

#[derive(Default)]
struct Metrics {
    http_requests: AtomicU64,
    http_errors: AtomicU64,
    http_in_flight: AtomicU64,
    http_duration_micros: AtomicU64,
    storage_errors: AtomicU64,
    data_load_operations_completed: AtomicU64,
    data_load_operations_failed: AtomicU64,
    pdf_renders_completed: AtomicU64,
    pdf_renders_failed: AtomicU64,
    pdf_render_duration_micros: AtomicU64,
    backups_completed: AtomicU64,
    backups_failed: AtomicU64,
    maintenance_completed: AtomicU64,
    maintenance_failed: AtomicU64,
    maintenance_changes: AtomicU64,
}

fn metrics() -> &'static Metrics {
    static INSTANCE: OnceLock<Metrics> = OnceLock::new();
    INSTANCE.get_or_init(Metrics::default)
}

pub async fn record_request(request: Request<Body>, next: Next) -> Response {
    let metrics = metrics();
    metrics.http_in_flight.fetch_add(1, Ordering::Relaxed);
    let started = Instant::now();
    let response = next.run(request).await;
    metrics.http_in_flight.fetch_sub(1, Ordering::Relaxed);
    metrics.http_requests.fetch_add(1, Ordering::Relaxed);
    metrics.http_duration_micros.fetch_add(
        u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX),
        Ordering::Relaxed,
    );
    if response.status().is_client_error() || response.status().is_server_error() {
        metrics.http_errors.fetch_add(1, Ordering::Relaxed);
    }
    response
}

pub async fn endpoint() -> Response {
    let metrics = metrics();
    let requests = metrics.http_requests.load(Ordering::Relaxed);
    let duration_seconds =
        metrics.http_duration_micros.load(Ordering::Relaxed) as f64 / 1_000_000.0;
    let body = format!(
        "# TYPE checkbook_http_requests_total counter\n\
         checkbook_http_requests_total {requests}\n\
         # TYPE checkbook_http_errors_total counter\n\
         checkbook_http_errors_total {}\n\
         # TYPE checkbook_http_in_flight gauge\n\
         checkbook_http_in_flight {}\n\
         # TYPE checkbook_http_request_duration_seconds_sum counter\n\
         checkbook_http_request_duration_seconds_sum {duration_seconds:.6}\n\
         # TYPE checkbook_storage_errors_total counter\n\
         checkbook_storage_errors_total {}\n\
         # TYPE checkbook_data_load_operations_completed_total counter\n\
         checkbook_data_load_operations_completed_total {}\n\
         # TYPE checkbook_data_load_operations_failed_total counter\n\
         checkbook_data_load_operations_failed_total {}\n\
         # TYPE checkbook_pdf_renders_completed_total counter\n\
         checkbook_pdf_renders_completed_total {}\n\
         # TYPE checkbook_pdf_renders_failed_total counter\n\
         checkbook_pdf_renders_failed_total {}\n\
         # TYPE checkbook_pdf_render_duration_seconds_sum counter\n\
         checkbook_pdf_render_duration_seconds_sum {:.6}\n\
         # TYPE checkbook_backups_completed_total counter\n\
         checkbook_backups_completed_total {}\n\
         # TYPE checkbook_backups_failed_total counter\n\
         checkbook_backups_failed_total {}\n\
         # TYPE checkbook_maintenance_completed_total counter\n\
         checkbook_maintenance_completed_total {}\n\
         # TYPE checkbook_maintenance_failed_total counter\n\
         checkbook_maintenance_failed_total {}\n\
         # TYPE checkbook_maintenance_changes_total counter\n\
         checkbook_maintenance_changes_total {}\n",
        metrics.http_errors.load(Ordering::Relaxed),
        metrics.http_in_flight.load(Ordering::Relaxed),
        metrics.storage_errors.load(Ordering::Relaxed),
        metrics
            .data_load_operations_completed
            .load(Ordering::Relaxed),
        metrics.data_load_operations_failed.load(Ordering::Relaxed),
        metrics.pdf_renders_completed.load(Ordering::Relaxed),
        metrics.pdf_renders_failed.load(Ordering::Relaxed),
        metrics.pdf_render_duration_micros.load(Ordering::Relaxed) as f64 / 1_000_000.0,
        metrics.backups_completed.load(Ordering::Relaxed),
        metrics.backups_failed.load(Ordering::Relaxed),
        metrics.maintenance_completed.load(Ordering::Relaxed),
        metrics.maintenance_failed.load(Ordering::Relaxed),
        metrics.maintenance_changes.load(Ordering::Relaxed),
    );
    let mut response = Response::new(Body::from(body));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
    );
    response
}

pub fn observe_storage_error() {
    metrics().storage_errors.fetch_add(1, Ordering::Relaxed);
}

pub fn observe_data_load_operation(success: bool) {
    let counter = if success {
        &metrics().data_load_operations_completed
    } else {
        &metrics().data_load_operations_failed
    };
    counter.fetch_add(1, Ordering::Relaxed);
}

pub fn observe_pdf_render(success: bool, duration: std::time::Duration) {
    let metrics = metrics();
    let counter = if success {
        &metrics.pdf_renders_completed
    } else {
        &metrics.pdf_renders_failed
    };
    counter.fetch_add(1, Ordering::Relaxed);
    metrics.pdf_render_duration_micros.fetch_add(
        u64::try_from(duration.as_micros()).unwrap_or(u64::MAX),
        Ordering::Relaxed,
    );
}

pub fn observe_backup(success: bool) {
    let counter = if success {
        &metrics().backups_completed
    } else {
        &metrics().backups_failed
    };
    counter.fetch_add(1, Ordering::Relaxed);
}

pub fn observe_maintenance(success: bool, changes: u64) {
    let metrics = metrics();
    let counter = if success {
        &metrics.maintenance_completed
    } else {
        &metrics.maintenance_failed
    };
    counter.fetch_add(1, Ordering::Relaxed);
    metrics
        .maintenance_changes
        .fetch_add(changes, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;

    use super::{endpoint, observe_backup, observe_data_load_operation, observe_maintenance};

    #[tokio::test]
    async fn exposes_prometheus_text_format() -> anyhow::Result<()> {
        observe_data_load_operation(true);
        observe_backup(false);
        observe_maintenance(true, 7);
        let response = endpoint().await;
        let body = to_bytes(response.into_body(), 64 * 1024).await?;
        let body = std::str::from_utf8(&body)?;
        assert!(body.contains("# TYPE checkbook_http_requests_total counter"));
        assert!(body.contains("checkbook_data_load_operations_completed_total"));
        assert!(body.contains("checkbook_pdf_render_duration_seconds_sum"));
        assert!(body.contains("checkbook_maintenance_changes_total"));
        Ok(())
    }
}
