//! The gateway binary for a server. The desktop app embeds jian-server instead.

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let addr = std::env::var("JIAN_ADDR").unwrap_or_else(|_| "127.0.0.1:4410".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("jian listening on {addr}");
    axum::serve(listener, jian_server::router()).await
}
