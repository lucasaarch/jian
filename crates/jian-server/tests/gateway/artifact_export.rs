//! Downloads of artifacts through the gateway: each kind's files, the Office files read back, a
//! format the kind does not have, the drawn ones with no renderer, and that a download has the
//! access rules of a read (a member who does not see it, a link that needs a password or a
//! sign-in, another workspace).

use std::io::{Cursor, Read};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::accounts::{open_settings, start};
use super::artifact_sharing::{header, link_of, pass_of, put, set_password, unlock};
use super::artifacts::{call, earn, id};
use super::support::Gateway;

/// A GET, as a member (`bearer`) or a reader of a link (`cookie`): the status, the head and the
/// body bytes.
async fn fetch(
    gateway: &Gateway,
    path: &str,
    bearer: Option<&str>,
    cookie: Option<&str>,
) -> (u16, String, Vec<u8>) {
    earn(gateway);
    let mut stream = TcpStream::connect(gateway.addr).await.unwrap();
    let auth = bearer.map_or_else(String::new, |t| format!("Authorization: Bearer {t}\r\n"));
    let cookie = cookie.map_or_else(String::new, |c| format!("Cookie: {c}\r\n"));
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: test\r\n{auth}{cookie}Connection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.unwrap();
    let split = answer.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&answer[..split]).into_owned();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    (status, head, answer[split + 4..].to_vec())
}

async fn make(gateway: &Gateway, session: &str, kind: &str, title: &str, content: &str) -> String {
    let body = json!({ "kind": kind, "title": title, "content": content });
    let (status, made) = call(gateway, "POST", "/v1/artifacts", session, Some(body)).await;
    assert_eq!(status, 201, "{made}");
    id(&made["artifact"])
}

async fn export(
    gateway: &Gateway,
    session: &str,
    artifact: &str,
    format: &str,
) -> (u16, String, Vec<u8>) {
    let path = format!("/v1/artifacts/{artifact}/export?format={format}");
    fetch(gateway, &path, Some(session), None).await
}

/// The text of one part of an Office file, which proves it is a zip that reads back.
fn part(file: &[u8], name: &str) -> String {
    let mut zip = zip::ZipArchive::new(Cursor::new(file)).expect("a zip");
    let mut text = String::new();
    zip.by_name(name)
        .unwrap_or_else(|e| panic!("{name}: {e}"))
        .read_to_string(&mut text)
        .unwrap();
    text
}

fn body_of(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or(Value::Null)
}

#[tokio::test]
async fn each_kind_downloads_as_the_files_it_has_and_nothing_else() {
    let (gateway, tenants) = start(open_settings()).await;
    let member = &tenants.a.member_session;

    // The source as written: the bytes of the content, and an attachment named for the title.
    for (kind, content, format, mime) in [
        ("html", "<h1>hi</h1>", "html", "text/html"),
        ("react", "export default () => null;", "tsx", "text/plain"),
        ("markdown", "# Plan\n\ntext", "md", "text/markdown"),
        ("mermaid", "graph TD; A-->B", "mmd", "text/plain"),
        ("diagram", "{\"nodes\":[]}", "json", "application/json"),
        ("sheet", "a,b\n1,2\n", "csv", "text/csv"),
    ] {
        let artifact = make(&gateway, member, kind, "Q3 plan: São Paulo", content).await;
        let (status, head, body) = export(&gateway, member, &artifact, format).await;
        assert_eq!(status, 200, "{kind}");
        assert_eq!(body, content.as_bytes(), "{kind}");
        assert!(
            header(&head, "content-type").unwrap().starts_with(mime),
            "{head}"
        );
        assert_eq!(
            header(&head, "content-disposition").unwrap(),
            format!(
                "attachment; filename=\"Q3-plan-S-o-Paulo.{format}\"; \
                 filename*=UTF-8''Q3-plan-S%C3%A3o-Paulo.{format}"
            )
        );
        assert_eq!(
            header(&head, "x-content-type-options").as_deref(),
            Some("nosniff")
        );
        assert_eq!(header(&head, "cache-control").as_deref(), Some("no-store"));
        // A file the kind does not have, a missing one and an unknown one are 400s that say
        // what it has.
        for bad in ["exe", "pptx", ""] {
            let (status, _, body) = export(&gateway, member, &artifact, bad).await;
            assert_eq!(status, 400, "{kind} as {bad:?}");
            assert!(
                body_of(&body)["message"].as_str().unwrap().contains(format),
                "{kind}"
            );
        }
    }

    // A document: a Word file whose text is the Markdown's, and a PDF that needs a renderer.
    let notes = make(
        &gateway,
        member,
        "markdown",
        "Notes",
        "# Heading\n\nSome **bold** & <b>.\n\n- one\n- two\n",
    )
    .await;
    let (status, head, file) = export(&gateway, member, &notes, "docx").await;
    assert_eq!(status, 200);
    assert!(
        header(&head, "content-type")
            .unwrap()
            .ends_with("wordprocessingml.document")
    );
    assert!(file.starts_with(b"PK"), "a zip");
    let xml = part(&file, "word/document.xml");
    for text in [
        "Heading",
        "Some ",
        "bold",
        "&amp; &lt;b&gt;.",
        "\u{2022} ",
        "one",
        "two",
    ] {
        assert!(xml.contains(text), "{text} in {xml}");
    }
    assert!(!xml.contains("**"), "{xml}");
    assert!(part(&file, "[Content_Types].xml").contains("wordprocessingml.document.main+xml"));
    let (status, _, body) = export(&gateway, member, &notes, "pdf").await;
    assert_eq!(status, 501);
    assert_eq!(body_of(&body)["error"], "render_unavailable");

    // A sheet: formulas stay formulas, numbers are numbers, text is text, and a stray control
    // character does not make the file unreadable.
    let sheet = make(
        &gateway,
        member,
        "sheet",
        "Sales: 2026",
        "item,qty\n\"wid,get\",3\nfee\u{1},007\ntotal,=SUM(B2:B3)\n",
    )
    .await;
    let (status, head, file) = export(&gateway, member, &sheet, "xlsx").await;
    assert_eq!(status, 200);
    assert!(
        header(&head, "content-type")
            .unwrap()
            .ends_with("spreadsheetml.sheet")
    );
    let xml = part(&file, "xl/worksheets/sheet1.xml");
    for text in [
        "<c r=\"A1\" t=\"inlineStr\">",
        ">wid,get<",
        "<c r=\"B2\"><v>3</v></c>",
        ">007<",
        "<c r=\"B4\"><f>SUM(B2:B3)</f></c>",
    ] {
        assert!(xml.contains(text), "{text} in {xml}");
    }
    assert!(part(&file, "xl/workbook.xml").contains("name=\"Sales  2026\""));
    assert_eq!(export(&gateway, member, &sheet, "docx").await.0, 400);

    // A deck: a slide each, with the text of its HTML and none of its code.
    let slides = json!({ "slides": [
        "<style>h1{}</style><h1>One &amp; all</h1><p>first</p><script>alert(1)</script>",
        "<h1>Two</h1><ul><li>a</li><li>b</li></ul>",
    ]});
    let deck = make(&gateway, member, "deck", "Launch", &slides.to_string()).await;
    let (status, head, file) = export(&gateway, member, &deck, "pptx").await;
    assert_eq!(status, 200);
    assert!(
        header(&head, "content-type")
            .unwrap()
            .ends_with("presentationml.presentation")
    );
    let first = part(&file, "ppt/slides/slide1.xml");
    assert!(
        first.contains("One &amp; all") && first.contains("first"),
        "{first}"
    );
    assert!(
        !first.contains("alert") && !first.contains("h1{}"),
        "{first}"
    );
    assert!(part(&file, "ppt/slides/slide2.xml").contains("\u{2022} a"));
    assert_eq!(
        part(&file, "ppt/presentation.xml")
            .matches("<p:sldId ")
            .count(),
        2
    );
    for needed in [
        "ppt/slideMasters/slideMaster1.xml",
        "ppt/slideLayouts/slideLayout1.xml",
        "ppt/theme/theme1.xml",
    ] {
        part(&file, needed);
    }
    for drawn in ["pdf", "png"] {
        assert_eq!(
            export(&gateway, member, &deck, drawn).await.0,
            501,
            "{drawn}"
        );
    }
    assert_eq!(export(&gateway, member, &deck, "csv").await.0, 400);
    // A deck whose content is not slides is not something to download as slides.
    let broken = make(&gateway, member, "deck", "Broken", "not json").await;
    assert_eq!(export(&gateway, member, &broken, "pptx").await.0, 422);
    gateway.stop().await;
}

#[tokio::test]
async fn a_download_is_for_whoever_may_read_the_artifact() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    let (admin, x, y) = (
        &side.admin_session,
        &side.member_session,
        &side.peer_session,
    );
    let artifact = make(&gateway, x, "markdown", "Private", "secret").await;

    // Private to its owner: nobody else, an admin included, gets the file or even a 400.
    assert_eq!(export(&gateway, x, &artifact, "md").await.0, 200);
    for other in [y, admin] {
        for format in ["md", "nonsense"] {
            assert_eq!(export(&gateway, other, &artifact, format).await.0, 404);
        }
    }
    assert_eq!(
        fetch(
            &gateway,
            &format!("/v1/artifacts/{artifact}/export?format=md"),
            None,
            None
        )
        .await
        .0,
        401
    );

    // Shared with the workspace: every member, still not without a sign-in.
    assert_eq!(
        put(
            &gateway,
            x,
            &artifact,
            "visibility",
            json!({ "visibility": "workspace" })
        )
        .await,
        200
    );
    assert_eq!(export(&gateway, y, &artifact, "md").await.0, 200);
    assert_eq!(export(&gateway, admin, &artifact, "docx").await.0, 200);

    // Its link: a member who sees it gets the file, anyone else a 401 or a 404.
    let link = link_of(&gateway, x, &artifact).await;
    let path = format!("/v1/public/artifacts/{link}/export?format=md");
    assert_eq!(fetch(&gateway, &path, Some(y), None).await.0, 200);
    assert_eq!(fetch(&gateway, &path, None, None).await.0, 401);
    assert_eq!(
        put(
            &gateway,
            x,
            &artifact,
            "visibility",
            json!({ "visibility": "owner" })
        )
        .await,
        200
    );
    assert_eq!(fetch(&gateway, &path, Some(y), None).await.0, 404);
    assert_eq!(fetch(&gateway, &path, Some(x), None).await.0, 200);

    // External with a password: the file waits for the pass, as the page does, and without it
    // says nothing of the title.
    assert_eq!(
        put(
            &gateway,
            x,
            &artifact,
            "visibility",
            json!({ "visibility": "external" })
        )
        .await,
        200
    );
    assert_eq!(
        set_password(&gateway, x, &artifact, json!("s3cret")).await,
        200
    );
    let (status, head, body) = fetch(&gateway, &path, None, None).await;
    assert_eq!(status, 401);
    assert_eq!(body_of(&body)["error"], "password_required");
    assert!(
        !head.to_lowercase().contains("content-disposition")
            && !String::from_utf8_lossy(&body).contains("Private")
    );
    let (_, head) = unlock(&gateway, &link, "s3cret").await;
    let pass = pass_of(&head);
    let (status, head, body) = fetch(&gateway, &path, None, Some(&pass)).await;
    assert_eq!(status, 200);
    assert_eq!(body, b"secret");
    assert!(
        header(&head, "content-disposition")
            .unwrap()
            .contains("Private.md")
    );
    // The kind's files only, and the drawn ones wait for a renderer, here as well.
    let docx = format!("/v1/public/artifacts/{link}/export?format=docx");
    assert_eq!(fetch(&gateway, &docx, None, Some(&pass)).await.0, 200);
    let pdf = format!("/v1/public/artifacts/{link}/export?format=pdf");
    assert_eq!(fetch(&gateway, &pdf, None, Some(&pass)).await.0, 501);
    let xlsx = format!("/v1/public/artifacts/{link}/export?format=xlsx");
    assert_eq!(fetch(&gateway, &xlsx, None, Some(&pass)).await.0, 400);
    // A new password ends the pass; taking it away opens the file to all.
    assert_eq!(
        set_password(&gateway, x, &artifact, json!("abcd")).await,
        200
    );
    assert_eq!(fetch(&gateway, &path, None, Some(&pass)).await.0, 401);
    assert_eq!(set_password(&gateway, x, &artifact, Value::Null).await, 200);
    assert_eq!(fetch(&gateway, &path, None, None).await.0, 200);
    gateway.stop().await;
}

#[tokio::test]
async fn exports_of_artifacts_stay_inside_their_own_tenant() {
    let (gateway, tenants) = start(open_settings()).await;
    for (actor, victim) in tenants.crossings() {
        let theirs = make(
            &gateway,
            &victim.admin_session,
            "markdown",
            "Theirs",
            "theirs",
        )
        .await;
        let who = &actor.admin_session;
        // The other workspace's admin cannot download it, in any format.
        for format in ["md", "docx", "pdf", "nonsense"] {
            assert_eq!(
                export(&gateway, who, &theirs, format).await.0,
                404,
                "{format}"
            );
        }
        // Nor through its link when it is not external: signed in elsewhere is a 404.
        assert_eq!(
            put(
                &gateway,
                &victim.admin_session,
                &theirs,
                "visibility",
                json!({ "visibility": "workspace" })
            )
            .await,
            200
        );
        let link = link_of(&gateway, &victim.admin_session, &theirs).await;
        let path = format!("/v1/public/artifacts/{link}/export?format=md");
        assert_eq!(fetch(&gateway, &path, Some(who), None).await.0, 404);
        assert_eq!(fetch(&gateway, &path, None, None).await.0, 401);
        // The link of one's own workspace gives the file of one's own artifact.
        let mine = make(&gateway, who, "markdown", "Mine", "mine").await;
        assert_eq!(
            put(
                &gateway,
                who,
                &mine,
                "visibility",
                json!({ "visibility": "external" })
            )
            .await,
            200
        );
        let mine_link = link_of(&gateway, who, &mine).await;
        let path = format!("/v1/public/artifacts/{mine_link}/export?format=md");
        let (status, _, body) = fetch(&gateway, &path, None, None).await;
        assert_eq!((status, body.as_slice()), (200, b"mine".as_slice()));
    }
    gateway.stop().await;
}
