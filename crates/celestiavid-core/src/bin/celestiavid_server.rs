use celestiavid_core::{http_server::build_router, CelestiaEngine};
use std::path::PathBuf;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,celestiavid_core=info")),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8000);
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());

    let sample_dir = std::env::var("CELESTIAVID_SAMPLE_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            let cwd_sample = PathBuf::from("sample");
            if cwd_sample.is_dir() {
                Some(cwd_sample)
            } else {
                None
            }
        });

    let engine = CelestiaEngine::open_default(sample_dir)?;
    let router = build_router(engine.clone());

    let bind_addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    info!(
        addr = %bind_addr,
        data_dir = %engine.data_dir.display(),
        "celestiavid_rust_server_listening"
    );

    axum::serve(listener, router).await?;
    Ok(())
}
