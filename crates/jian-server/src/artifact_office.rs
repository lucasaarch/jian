//! The Office files an artifact is downloaded as, written here with no browser: a spreadsheet
//! (`xlsx`) from a sheet's CSV, a document (`docx`) from Markdown and slides (`pptx`) from a
//! deck.
//!
//! All three are a zip of XML parts, so they share [`pack`]. Each is the smallest package that
//! the Office programs open, with no style sheet and no picture: a document is drawn with
//! direct formatting, a sheet keeps its formulas as formulas (Excel works them out on opening),
//! and a slide is the *text* of its HTML. Slides are HTML that only a browser can draw, so a
//! picture of them is the job of the renderer a gateway may have (`ArtifactRenderer`).
//!
//! Every text that reaches an XML part goes through [`esc`], which also drops the characters XML
//! cannot hold at all: one stray control character in a title would make the file unreadable.

use std::fmt::Write as _;
use std::io::{Cursor, Write};

use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const RELS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";

/// Excel's own limits: a sheet has at most this many columns and rows.
const MAX_COLUMNS: usize = 16_384;
const MAX_ROWS: usize = 1_048_576;

/// Zips `parts`, in order (the content types first, as Office readers expect).
fn pack(parts: Vec<(String, String)>) -> Result<Vec<u8>, ZipError> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, body) in parts {
        zip.start_file(name, options)?;
        zip.write_all(body.as_bytes())?;
    }
    Ok(zip.finish()?.into_inner())
}

fn part(name: &str, body: impl AsRef<str>) -> (String, String) {
    (name.to_owned(), format!("{XML}{}", body.as_ref()))
}

/// What `write` appends for each of `items`, one after the other.
fn joined<T>(items: impl IntoIterator<Item = T>, mut write: impl FnMut(&mut String, T)) -> String {
    let mut out = String::new();
    for item in items {
        write(&mut out, item);
    }
    out
}

/// `text` as XML character data or an attribute value.
fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(c),
            // XML 1.0 has no room for these, even escaped.
            c if c < ' ' || c == '\u{fffe}' || c == '\u{ffff}' => {}
            c => out.push(c),
        }
    }
    out
}

fn content_types(defaults: &str, overrides: &[(String, &str)]) -> (String, String) {
    let overrides = joined(overrides, |out, (name, kind)| {
        let _ = write!(
            out,
            "<Override PartName=\"/{name}\" ContentType=\"{kind}\"/>"
        );
    });
    part(
        "[Content_Types].xml",
        format!(
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
             <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
             <Default Extension=\"xml\" ContentType=\"application/xml\"/>{defaults}{overrides}</Types>"
        ),
    )
}

/// A relationships part: `(id, type, target)` for each.
fn relationships(name: &str, rels: &[(String, &str, String)]) -> (String, String) {
    let rels = joined(rels, |out, (id, kind, target)| {
        let _ = write!(
            out,
            "<Relationship Id=\"{id}\" Type=\"{OFFICE_REL}/{kind}\" Target=\"{target}\"/>"
        );
    });
    part(
        name,
        format!("<Relationships xmlns=\"{RELS}\">{rels}</Relationships>"),
    )
}

fn root_rels(target: &str) -> (String, String) {
    relationships(
        "_rels/.rels",
        &[("rId1".to_owned(), "officeDocument", target.to_owned())],
    )
}

// ---- Spreadsheet --------------------------------------------------------------------------

/// The rows of a CSV: quoted fields may hold commas, quotes (doubled) and line breaks. The line
/// break at the very end ends a row and does not start another.
fn csv_rows(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let (mut quoted, mut open) = (false, false);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, quoted) {
            ('"', true) if chars.peek() == Some(&'"') => {
                chars.next();
                field.push('"');
            }
            ('"', true) => quoted = false,
            ('"', false) if field.is_empty() => {
                quoted = true;
                open = true;
            }
            (',', false) => {
                row.push(std::mem::take(&mut field));
                open = true;
            }
            ('\r', false) if chars.peek() == Some(&'\n') => {}
            ('\n' | '\r', false) => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                open = false;
            }
            (c, _) => {
                field.push(c);
                open = true;
            }
        }
    }
    if open || !field.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// `0` is `A`, `26` is `AA`.
fn column_name(mut index: usize) -> String {
    let mut name = Vec::new();
    loop {
        name.push(b'A' + (index % 26) as u8);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    name.reverse();
    String::from_utf8_lossy(&name).into_owned()
}

/// Whether Excel should hold `text` as a number: plain decimal syntax, and not something like a
/// code or a phone number that a number would change (`007` would lose its zeros).
fn is_number(text: &str) -> bool {
    let plain = text.strip_prefix('-').unwrap_or(text);
    let zeros = plain.len() > 1 && plain.starts_with('0') && !plain.starts_with("0.");
    text.chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | 'e' | 'E'))
        && !zeros
        && text.parse::<f64>().is_ok_and(f64::is_finite)
}

/// Excel's names for a sheet: at most 31 characters, none of `[]:*?/\`, not edged by `'`.
fn sheet_name(title: &str) -> String {
    let name: String = title
        .chars()
        .map(|c| {
            if "[]:*?/\\".contains(c) || c.is_control() {
                ' '
            } else {
                c
            }
        })
        .collect();
    let name: String = name.trim().trim_matches('\'').chars().take(31).collect();
    let name = name.trim().to_owned();
    if name.is_empty() {
        "Sheet1".to_owned()
    } else {
        name
    }
}

/// A sheet's CSV as an Excel file. A cell that starts with `=` stays a formula.
pub(crate) fn xlsx(title: &str, csv: &str) -> Result<Vec<u8>, ZipError> {
    let rows = csv_rows(csv);
    let mut widths: Vec<usize> = Vec::new();
    let mut data = String::new();
    for (r, row) in rows.iter().take(MAX_ROWS).enumerate() {
        let mut cells = String::new();
        for (c, text) in row.iter().take(MAX_COLUMNS).enumerate() {
            if text.is_empty() {
                continue;
            }
            let at = format!("{}{}", column_name(c), r + 1);
            let cell = if let Some(formula) = text.strip_prefix('=').filter(|f| !f.is_empty()) {
                format!("<c r=\"{at}\"><f>{}</f></c>", esc(formula))
            } else if is_number(text.trim()) {
                format!("<c r=\"{at}\"><v>{}</v></c>", text.trim())
            } else {
                format!(
                    "<c r=\"{at}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
                    esc(text)
                )
            };
            cells.push_str(&cell);
            if widths.len() <= c {
                widths.resize(c + 1, 0);
            }
            widths[c] = widths[c].max(text.chars().count().min(50));
        }
        let _ = write!(data, "<row r=\"{}\">{cells}</row>", r + 1);
    }
    let cols = joined(
        widths.iter().enumerate().filter(|(_, width)| **width > 0),
        |out, (c, width)| {
            let n = c + 1;
            let _ = write!(
                out,
                "<col min=\"{n}\" max=\"{n}\" width=\"{}\" customWidth=\"1\"/>",
                (width + 2).max(10)
            );
        },
    );
    let cols = if cols.is_empty() {
        cols
    } else {
        format!("<cols>{cols}</cols>")
    };
    let main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    pack(vec![
        content_types(
            "",
            &[
                (
                    "xl/workbook.xml".to_owned(),
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
                ),
                (
                    "xl/worksheets/sheet1.xml".to_owned(),
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
                ),
            ],
        ),
        root_rels("xl/workbook.xml"),
        part(
            "xl/workbook.xml",
            format!(
                "<workbook xmlns=\"{main}\" xmlns:r=\"{OFFICE_REL}\">\
                 <sheets><sheet name=\"{}\" sheetId=\"1\" r:id=\"rId1\"/></sheets>\
                 <calcPr fullCalcOnLoad=\"1\"/></workbook>",
                esc(&sheet_name(title))
            ),
        ),
        relationships(
            "xl/_rels/workbook.xml.rels",
            &[(
                "rId1".to_owned(),
                "worksheet",
                "worksheets/sheet1.xml".to_owned(),
            )],
        ),
        part(
            "xl/worksheets/sheet1.xml",
            format!("<worksheet xmlns=\"{main}\">{cols}<sheetData>{data}</sheetData></worksheet>"),
        ),
    ])
}

// ---- Document -----------------------------------------------------------------------------

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/// How a run of text looks: Word has no style sheet here, so each run says it.
#[derive(Clone, Copy, Default)]
struct Look {
    bold: bool,
    italic: bool,
    mono: bool,
    /// Half-points; 0 leaves it to Word's default.
    size: u32,
}

fn run(text: &str, look: Look) -> String {
    let mut props = String::new();
    if look.mono {
        props.push_str("<w:rFonts w:ascii=\"Courier New\" w:hAnsi=\"Courier New\"/>");
    }
    if look.bold {
        props.push_str("<w:b/>");
    }
    if look.italic {
        props.push_str("<w:i/>");
    }
    if look.size > 0 {
        let _ = write!(props, "<w:sz w:val=\"{}\"/>", look.size);
    }
    format!(
        "<w:r><w:rPr>{props}</w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",
        esc(text)
    )
}

/// `text` as runs, with `**bold**` and `` `code` `` honoured and their marks removed.
fn runs(text: &str, base: Look) -> String {
    let mut out = String::new();
    let mut look = base;
    let mut rest = text;
    while !rest.is_empty() {
        let next = rest
            .find("**")
            .map(|i| (i, 2))
            .into_iter()
            .chain(rest.find('`').map(|i| (i, 1)))
            .min();
        let Some((at, width)) = next else {
            out.push_str(&run(rest, look));
            break;
        };
        if at > 0 {
            out.push_str(&run(&rest[..at], look));
        }
        if width == 2 {
            look.bold = !look.bold || base.bold;
        } else {
            look.mono = !look.mono || base.mono;
        }
        rest = &rest[at + width..];
    }
    out
}

fn paragraph(content: &str, indent: bool) -> String {
    let indent = if indent {
        "<w:ind w:left=\"720\" w:hanging=\"360\"/>"
    } else {
        ""
    };
    format!("<w:p><w:pPr><w:spacing w:after=\"160\"/>{indent}</w:pPr>{content}</w:p>")
}

/// The list marker at the start of `line`, with the text after it.
fn list_item(line: &str) -> Option<(String, &str)> {
    if let Some(rest) = ["- ", "* ", "+ "].iter().find_map(|m| line.strip_prefix(m)) {
        return Some(("\u{2022} ".to_owned(), rest));
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    let rest = line[digits..]
        .strip_prefix(['.', ')'])
        .and_then(|r| r.strip_prefix(' '))?;
    (digits > 0).then(|| (format!("{}. ", &line[..digits]), rest))
}

/// Markdown as a Word document: headings, paragraphs, lists, quotes and code blocks. Tables and
/// images stay as the text they are written in.
pub(crate) fn docx(markdown: &str) -> Result<Vec<u8>, ZipError> {
    let mut body = String::new();
    let mut pending = String::new();
    let mut code = false;
    let flush = |body: &mut String, pending: &mut String| {
        if !pending.is_empty() {
            body.push_str(&paragraph(&runs(pending, Look::default()), false));
            pending.clear();
        }
    };
    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            flush(&mut body, &mut pending);
            code = !code;
            continue;
        }
        if code {
            let look = Look {
                mono: true,
                ..Look::default()
            };
            body.push_str(&paragraph(&run(line, look), false));
            continue;
        }
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        if trimmed.is_empty() {
            flush(&mut body, &mut pending);
        } else if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
            flush(&mut body, &mut pending);
            let size = [40, 32, 28, 26, 24, 22][hashes - 1];
            let look = Look {
                bold: true,
                size,
                ..Look::default()
            };
            body.push_str(&paragraph(&runs(trimmed[hashes..].trim(), look), false));
        } else if let Some((marker, text)) = list_item(trimmed) {
            flush(&mut body, &mut pending);
            let content = format!(
                "{}{}",
                run(&marker, Look::default()),
                runs(text, Look::default())
            );
            body.push_str(&paragraph(&content, true));
        } else if let Some(quote) = trimmed.strip_prefix('>') {
            flush(&mut body, &mut pending);
            let look = Look {
                italic: true,
                ..Look::default()
            };
            body.push_str(&paragraph(&runs(quote.trim(), look), true));
        } else if trimmed.len() >= 3 && trimmed.chars().all(|c| matches!(c, '-' | '*' | '_')) {
            flush(&mut body, &mut pending);
        } else {
            if !pending.is_empty() {
                pending.push(' ');
            }
            pending.push_str(trimmed);
        }
    }
    flush(&mut body, &mut pending);
    pack(vec![
        content_types(
            "",
            &[(
                "word/document.xml".to_owned(),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
            )],
        ),
        root_rels("word/document.xml"),
        part(
            "word/document.xml",
            format!("<w:document xmlns:w=\"{W}\"><w:body>{body}</w:body></w:document>"),
        ),
    ])
}

// ---- Slides -------------------------------------------------------------------------------

/// The text a slide's HTML shows, one entry per line: what is not shown (scripts, styles, the
/// head) is left out and the usual entities are read. The first line is the slide's heading in
/// the file.
pub(crate) fn slide_lines(html: &str) -> Vec<String> {
    const HIDDEN: [&str; 5] = ["script", "style", "head", "noscript", "template"];
    const BLOCKS: [&str; 14] = [
        "p",
        "div",
        "br",
        "li",
        "ul",
        "ol",
        "tr",
        "section",
        "article",
        "table",
        "h1",
        "h2",
        "h3",
        "blockquote",
    ];
    let lower = html.to_ascii_lowercase();
    let mut text = String::new();
    let mut at = 0;
    while at < html.len() {
        let Some(open) = html[at..].find('<').map(|i| at + i) else {
            text.push_str(&html[at..]);
            break;
        };
        text.push_str(&html[at..open]);
        if lower[open..].starts_with("<!--") {
            at = lower[open..]
                .find("-->")
                .map_or(html.len(), |i| open + i + 3);
            continue;
        }
        let close = lower[open..].find('>').map_or(html.len(), |i| open + i + 1);
        let tag = &lower[open + 1..close.saturating_sub(1).max(open + 1)];
        let closing = tag.starts_with('/');
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect();
        at = close;
        if !closing && HIDDEN.contains(&name.as_str()) {
            at = lower[close..]
                .find(&format!("</{name}"))
                .and_then(|i| lower[close + i..].find('>').map(|j| close + i + j + 1))
                .unwrap_or(html.len());
        } else if BLOCKS.contains(&name.as_str()) || (name.starts_with('h') && name.len() == 2) {
            text.push('\n');
            if name == "li" && !closing {
                text.push_str("\u{2022} ");
            }
        }
    }
    entities(&text)
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty() && line != "\u{2022}")
        .collect()
}

/// `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&nbsp;` and `&#NN;` / `&#xHH;`, once.
fn entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.find(';').filter(|e| *e <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let decoded = match &rest[1..end] {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            number => number
                .strip_prefix('#')
                .and_then(|n| match n.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => n.parse().ok(),
                })
                .and_then(char::from_u32),
        };
        if let Some(c) = decoded {
            out.push(c);
            rest = &rest[end + 1..];
        } else {
            out.push('&');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const SLIDE: &str = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const NS: &str = "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
    xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
    xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"";
const TREE: &str = "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\
    <p:grpSpPr/>";
const CLR_MAP: &str = "<p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" \
    accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" \
    accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>";

/// A text box at `(x, y)` of `(cx, cy)` EMU, one paragraph per line, at `size` hundredths of a
/// point.
fn text_box(
    id: u32,
    name: &str,
    geometry: [u32; 4],
    lines: &[String],
    size: u32,
    bold: bool,
) -> String {
    let [x, y, cx, cy] = geometry;
    let paragraphs = joined(lines, |out, line| {
        let _ = write!(
            out,
            "<a:p><a:r><a:rPr lang=\"en-US\" sz=\"{size}\" b=\"{}\">\
             <a:solidFill><a:srgbClr val=\"1F1F1F\"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r></a:p>",
            u8::from(bold),
            esc(line)
        );
    });
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{name}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr>\
         <p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
         <a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr>\
         <p:txBody><a:bodyPr wrap=\"square\"><a:normAutofit/></a:bodyPr><a:lstStyle/>{paragraphs}</p:txBody></p:sp>"
    )
}

fn slide_xml(html: &str) -> String {
    let lines = slide_lines(html);
    let mut shapes = String::new();
    if let Some((heading, rest)) = lines.split_first() {
        shapes.push_str(&text_box(
            2,
            "Title",
            [457_200, 342_900, 11_277_600, 1_000_000],
            std::slice::from_ref(heading),
            3200,
            true,
        ));
        if !rest.is_empty() {
            shapes.push_str(&text_box(
                3,
                "Text",
                [457_200, 1_500_000, 11_277_600, 4_800_000],
                rest,
                2000,
                false,
            ));
        }
    }
    format!(
        "<p:sld {NS}><p:cSld><p:spTree>{TREE}{shapes}</p:spTree></p:cSld>\
         <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
    )
}

fn theme() -> String {
    let fill = "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>";
    let line = "<a:ln w=\"9525\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln>";
    let colors = joined(
        [
            ("dk1", "000000"),
            ("lt1", "FFFFFF"),
            ("dk2", "1F1F1F"),
            ("lt2", "F2F2F2"),
            ("accent1", "4472C4"),
            ("accent2", "ED7D31"),
            ("accent3", "A5A5A5"),
            ("accent4", "FFC000"),
            ("accent5", "5B9BD5"),
            ("accent6", "70AD47"),
            ("hlink", "0563C1"),
            ("folHlink", "954F72"),
        ],
        |out, (name, value)| {
            let _ = write!(out, "<a:{name}><a:srgbClr val=\"{value}\"/></a:{name}>");
        },
    );
    let font = "<a:latin typeface=\"Arial\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/>";
    format!(
        "<a:theme xmlns:a=\"{A}\" name=\"Jian\"><a:themeElements>\
         <a:clrScheme name=\"Jian\">{colors}</a:clrScheme>\
         <a:fontScheme name=\"Jian\"><a:majorFont>{font}</a:majorFont><a:minorFont>{font}</a:minorFont></a:fontScheme>\
         <a:fmtScheme name=\"Jian\"><a:fillStyleLst>{fill}{fill}{fill}</a:fillStyleLst>\
         <a:lnStyleLst>{line}{line}{line}</a:lnStyleLst>\
         <a:effectStyleLst>{e}{e}{e}</a:effectStyleLst>\
         <a:bgFillStyleLst>{fill}{fill}{fill}</a:bgFillStyleLst></a:fmtScheme>\
         </a:themeElements></a:theme>",
        e = "<a:effectStyle><a:effectLst/></a:effectStyle>"
    )
}

/// A deck's slides as a `.pptx` file: one 16:9 slide each, with the text of its HTML (the
/// first line as the heading). No pictures and no layout: that takes the renderer.
pub(crate) fn pptx(slides: &[String]) -> Result<Vec<u8>, ZipError> {
    let mut overrides = vec![
        (
            "ppt/presentation.xml".to_owned(),
            "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
        ),
        (
            "ppt/slideMasters/slideMaster1.xml".to_owned(),
            "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
        ),
        (
            "ppt/slideLayouts/slideLayout1.xml".to_owned(),
            "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
        ),
        (
            "ppt/theme/theme1.xml".to_owned(),
            "application/vnd.openxmlformats-officedocument.theme+xml",
        ),
    ];
    let mut parts = Vec::new();
    let mut ids = String::new();
    let mut presentation_rels = vec![
        (
            "rId1".to_owned(),
            "slideMaster",
            "slideMasters/slideMaster1.xml".to_owned(),
        ),
        ("rId2".to_owned(), "theme", "theme/theme1.xml".to_owned()),
    ];
    for (i, html) in slides.iter().enumerate() {
        let n = i + 1;
        overrides.push((format!("ppt/slides/slide{n}.xml"), SLIDE));
        let _ = write!(ids, "<p:sldId id=\"{}\" r:id=\"rId{}\"/>", 255 + n, n + 2);
        presentation_rels.push((
            format!("rId{}", n + 2),
            "slide",
            format!("slides/slide{n}.xml"),
        ));
        parts.push(part(&format!("ppt/slides/slide{n}.xml"), slide_xml(html)));
        parts.push(relationships(
            &format!("ppt/slides/_rels/slide{n}.xml.rels"),
            &[(
                "rId1".to_owned(),
                "slideLayout",
                "../slideLayouts/slideLayout1.xml".to_owned(),
            )],
        ));
    }
    let mut files = vec![
        content_types("", &overrides),
        root_rels("ppt/presentation.xml"),
        part(
            "ppt/presentation.xml",
            format!(
                "<p:presentation {NS}><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>\
                 <p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx=\"12192000\" cy=\"6858000\"/>\
                 <p:notesSz cx=\"6858000\" cy=\"9144000\"/></p:presentation>"
            ),
        ),
        relationships("ppt/_rels/presentation.xml.rels", &presentation_rels),
        part(
            "ppt/slideMasters/slideMaster1.xml",
            format!(
                "<p:sldMaster {NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill>\
                 <a:effectLst/></p:bgPr></p:bg><p:spTree>{TREE}</p:spTree></p:cSld>{CLR_MAP}\
                 <p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst></p:sldMaster>"
            ),
        ),
        relationships(
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            &[
                (
                    "rId1".to_owned(),
                    "slideLayout",
                    "../slideLayouts/slideLayout1.xml".to_owned(),
                ),
                ("rId2".to_owned(), "theme", "../theme/theme1.xml".to_owned()),
            ],
        ),
        part(
            "ppt/slideLayouts/slideLayout1.xml",
            format!(
                "<p:sldLayout {NS} type=\"blank\" preserve=\"1\"><p:cSld name=\"Blank\"><p:spTree>{TREE}</p:spTree></p:cSld>\
                 <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
            ),
        ),
        relationships(
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
            &[(
                "rId1".to_owned(),
                "slideMaster",
                "../slideMasters/slideMaster1.xml".to_owned(),
            )],
        ),
        part("ppt/theme/theme1.xml", theme()),
    ];
    files.extend(parts);
    pack(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_keeps_quoted_commas_quotes_and_breaks() {
        let rows = csv_rows("a,\"b,\"\"c\"\"\"\r\n\"line\nbreak\",=SUM(A1:A2)\n");
        assert_eq!(
            rows,
            vec![
                vec!["a".to_owned(), "b,\"c\"".to_owned()],
                vec!["line\nbreak".to_owned(), "=SUM(A1:A2)".to_owned()],
            ]
        );
        assert_eq!(csv_rows(""), Vec::<Vec<String>>::new());
        assert_eq!(column_name(26), "AA");
    }

    #[test]
    fn a_slide_is_its_visible_text_and_nothing_of_its_code() {
        let html = "<html><head><title>no</title><style>p{}</style></head><body>\
                    <h1>Q3 &amp; Q4</h1><script>alert(1)</script><ul><li>one</li><li>two</li></ul>\
                    <!-- hidden --><p>a  b</p></body></html>";
        assert_eq!(
            slide_lines(html),
            ["Q3 & Q4", "\u{2022} one", "\u{2022} two", "a b"]
        );
    }
}
