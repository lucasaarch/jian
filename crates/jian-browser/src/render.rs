//! An artifact drawn as a PDF or a PNG by a [`Browser`].
//!
//! The artifact becomes one HTML document and the browser opens it as a `data:` address, so no
//! file is written and the page has no host of its own. Under [`NetworkPolicy::PublicOnly`] it
//! still cannot reach a private network, whatever the (agent-written) slides ask for; and the
//! document carries a content policy that allows no script and no request, so a slide is drawn
//! and does nothing else.

use std::fmt::Write as _;

use futures_util::future::BoxFuture;
use jian_core::ArtifactKind;

use crate::{Browser, BrowserError};

/// What a document is drawn as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    /// Every page of the document.
    Pdf,
    /// The first screen: for a deck, its first slide.
    Png,
}

/// Draws `content` (the source of an artifact of `kind`) with `browser`.
///
/// # Errors
/// [`BrowserError::Blocked`] for a kind that is not drawn, and what the browser says.
pub fn render<'a>(
    browser: &'a dyn Browser,
    kind: ArtifactKind,
    title: &'a str,
    content: &'a str,
    format: Format,
) -> BoxFuture<'a, Result<Vec<u8>, BrowserError>> {
    Box::pin(async move {
        let html = document(kind, title, content)?;
        let mut session = browser.open().await?;
        let drawn = async {
            session.navigate(&data_url(&html)).await?;
            match format {
                Format::Pdf => session.pdf().await,
                Format::Png => session.screenshot().await,
            }
        }
        .await;
        session.close().await;
        drawn
    })
}

const STYLE: &str = "body{font:16px/1.5 system-ui,sans-serif;margin:2rem;color:#111}\
    .slide{box-sizing:border-box;width:1280px;height:720px;overflow:hidden;position:relative;\
    page-break-after:always;break-after:page}body.deck{margin:0}";

/// A policy that allows styles in the document and images inside it, and nothing else.
const POLICY: &str = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

fn document(kind: ArtifactKind, title: &str, content: &str) -> Result<String, BrowserError> {
    let (class, body) = match kind {
        ArtifactKind::Markdown => ("doc", markdown(content)),
        ArtifactKind::Deck => ("deck", slides(content)?),
        other => {
            return Err(BrowserError::Blocked(format!(
                "a {} is not drawn as a PDF or a PNG",
                other.as_str()
            )));
        }
    };
    Ok(format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
         <meta http-equiv=\"Content-Security-Policy\" content=\"{POLICY}\">\
         <title>{}</title><style>{STYLE}</style></head><body class=\"{class}\">{body}</body></html>",
        escape(title)
    ))
}

fn slides(content: &str) -> Result<String, BrowserError> {
    let value: serde_json::Value = serde_json::from_str(content)
        .map_err(|_| BrowserError::Blocked("the deck is not readable".to_owned()))?;
    let slides = value
        .get("slides")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| BrowserError::Blocked("the deck has no slides".to_owned()))?;
    let mut out = String::new();
    for html in slides.iter().filter_map(serde_json::Value::as_str) {
        out.push_str("<section class=\"slide\">");
        out.push_str(html);
        out.push_str("</section>");
    }
    Ok(out)
}

/// `<name>text</name>`, the text escaped.
fn element(out: &mut String, name: &str, text: &str) {
    out.push('<');
    out.push_str(name);
    out.push('>');
    out.push_str(&escape(text));
    out.push_str("</");
    out.push_str(name);
    out.push('>');
}

/// Markdown as HTML: headings, bullet lists and paragraphs, every character escaped. It is a
/// reading copy, not a full renderer: anything else is shown as the text it is.
fn markdown(source: &str) -> String {
    let mut out = String::new();
    let mut in_list = false;
    let mut paragraph: Vec<&str> = Vec::new();
    let flush = |out: &mut String, paragraph: &mut Vec<&str>| {
        if !paragraph.is_empty() {
            element(out, "p", &paragraph.join(" "));
            paragraph.clear();
        }
    };
    for line in source.lines() {
        let trimmed = line.trim();
        let item = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "));
        if item.is_none() && in_list {
            out.push_str("</ul>");
            in_list = false;
        }
        if trimmed.is_empty() {
            flush(&mut out, &mut paragraph);
        } else if let Some(item) = item {
            flush(&mut out, &mut paragraph);
            if !in_list {
                out.push_str("<ul>");
                in_list = true;
            }
            element(&mut out, "li", item);
        } else if let Some(level) = heading(trimmed) {
            flush(&mut out, &mut paragraph);
            let text = trimmed.trim_start_matches('#').trim();
            element(&mut out, &format!("h{level}"), text);
        } else {
            paragraph.push(trimmed);
        }
    }
    flush(&mut out, &mut paragraph);
    if in_list {
        out.push_str("</ul>");
    }
    out
}

/// The level of a `#` heading line, 1 to 6.
fn heading(line: &str) -> Option<usize> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    (1..=6)
        .contains(&hashes)
        .then_some(hashes)
        .filter(|n| line[*n..].starts_with(' '))
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `html` as a `data:` address: every byte but an unreserved character is percent-encoded.
fn data_url(html: &str) -> String {
    let mut url = String::from("data:text/html;charset=utf-8,");
    for byte in html.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            url.push(char::from(byte));
        } else {
            write!(url, "%{byte:02X}").ok();
        }
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_is_escaped_and_shaped() {
        let html = markdown("# Plan <b>\n\n- one & two\n- three\n\nlast line");
        assert_eq!(
            html,
            "<h1>Plan &lt;b&gt;</h1><ul><li>one &amp; two</li><li>three</li></ul><p>last line</p>"
        );
    }

    #[test]
    fn a_deck_slide_cannot_add_a_script_the_policy_allows() {
        let html = document(
            ArtifactKind::Deck,
            "Q1",
            r#"{"slides":["<h1>One</h1>","<h1>Two</h1>"]}"#,
        )
        .unwrap();
        assert_eq!(html.matches("class=\"slide\"").count(), 2);
        assert!(html.contains("default-src 'none'"));
    }

    #[test]
    fn a_kind_that_is_not_drawn_is_refused() {
        assert!(document(ArtifactKind::Sheet, "t", "a,b").is_err());
    }

    #[test]
    fn the_address_holds_no_raw_character() {
        let url = data_url("<a href=\"x\">é#</a>");
        assert!(url.starts_with("data:text/html;charset=utf-8,%3Ca"));
        assert!(!url.contains(['#', '"', '<', ' ']));
    }
}
