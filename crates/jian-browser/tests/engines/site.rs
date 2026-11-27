//! A web server on loopback that the tests point the browsers at, and that remembers what it was
//! asked for.

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct Site {
    pub port: u16,
    hits: Arc<Mutex<Vec<String>>>,
}

impl Site {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&hits);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let seen = Arc::clone(&seen);
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    // A connection that sends nothing is a speculative one (Chromium opens
                    // them ahead): not a request, so not a hit.
                    if n == 0 {
                        return;
                    }
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    seen.lock().unwrap().push(path.clone());
                    let (headers, body) = page(&path);
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n{headers}\r\n{body}",
                        body.len()
                    );
                    drop(socket.write_all(response.as_bytes()).await);
                    drop(socket.shutdown().await);
                });
            }
        });
        Self { port, hits }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    /// The paths asked for so far.
    pub fn hits(&self) -> Vec<String> {
        self.hits.lock().unwrap().clone()
    }
}

fn page(path: &str) -> (&'static str, &'static str) {
    match path {
        "/" => (
            "",
            "<html><head><title>Home</title></head><body><h1>Hello readable world</h1>\
             <p>This is a local test page with enough words to be useful.</p></body></html>",
        ),
        // A cookie from the server and one from a script, and a value in local storage.
        "/set" => (
            "set-cookie: tenant=A; Path=/\r\n",
            "<html><body><p id=o>set</p><script>document.cookie='js=1; path=/';\
             try{localStorage.setItem('k','A')}catch(e){}</script></body></html>",
        ),
        "/read" => (
            "",
            "<html><body><p id=o>reading</p><script>var s='none';\
             try{s=localStorage.getItem('k')||'none'}catch(e){s='n/a'}\
             document.getElementById('o').textContent='cookie=['+document.cookie+'] storage='+s;\
             </script></body></html>",
        ),
        "/big" => (
            "",
            "<html><body style='margin:0'><div style='width:4000px;height:5000px;background:#36c;color:#fff'>\
             big page</div></body></html>",
        ),
        _ => ("", "<html><body>pixel</body></html>"),
    }
}
