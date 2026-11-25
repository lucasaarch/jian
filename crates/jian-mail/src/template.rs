//! The invitation e-mail.

use std::fmt::Write as _;

use crate::{Mailbox, Message};

/// What the invitation says.
#[derive(Clone, Copy, Debug)]
pub struct InviteMail<'a> {
    /// The sender.
    pub from: &'a Mailbox,
    /// The invited address.
    pub to: &'a str,
    /// The workspace they are asked to join. Typed by a person: escaped here.
    pub workspace: &'a str,
    /// Who invited them, when known. Typed by a person: escaped here.
    pub inviter: Option<&'a str>,
    /// Where to accept: the whole link, token included.
    pub link: &'a str,
    /// When the link stops working, as the text should show it (UTC).
    pub expires_at: &'a str,
}

/// The invitation as a message: plain text and HTML that say the same.
///
/// `workspace` and `inviter` come from people, so in the text they lose control characters
/// (no line break to start a fake paragraph or header) and in the HTML they are escaped.
#[must_use]
pub fn invite_message(mail: &InviteMail<'_>) -> Message {
    let workspace = plain(mail.workspace);
    let inviter = mail.inviter.map(plain);
    let who = inviter.as_deref().map_or_else(
        || "You have been invited".to_owned(),
        |inviter| format!("{inviter} invited you"),
    );
    let subject = format!("You are invited to {workspace} on Jian");
    let text = format!(
        "{who} to join {workspace} on Jian.\n\n\
         Accept the invitation: {link}\n\n\
         The link works once and stops working on {expires} (UTC). \
         If you were not expecting this, ignore this message.\n",
        link = mail.link,
        expires = plain(mail.expires_at),
    );
    let mut html = String::new();
    // Writing to a String cannot fail.
    let _ = write!(
        html,
        "<p>{} to join <strong>{}</strong> on Jian.</p>\
         <p><a href=\"{link}\">Accept the invitation</a></p>\
         <p>Or paste this link into your browser:<br>{link}</p>\
         <p>The link works once and stops working on {} (UTC). \
         If you were not expecting this, ignore this message.</p>",
        escape_html(&who),
        escape_html(&workspace),
        escape_html(&plain(mail.expires_at)),
        link = escape_html(mail.link),
    );
    Message {
        from: mail.from.clone(),
        to: mail.to.to_owned(),
        subject,
        text,
        html,
    }
}

/// Control characters (line breaks above all) become spaces.
fn plain(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_owned()
}

fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail(workspace: &str, inviter: Option<&str>) -> Message {
        let from = Mailbox::parse("Jian <invites@example.com>").unwrap();
        invite_message(&InviteMail {
            from: &from,
            to: "new@example.com",
            workspace,
            inviter,
            link: "https://jian.example.com/invite#token=ji_abc",
            expires_at: "2026-12-02T10:00:00Z",
        })
    }

    #[test]
    fn it_names_the_workspace_the_inviter_the_deadline_and_the_link() {
        let message = mail("Acme", Some("Ana"));
        assert_eq!(message.subject, "You are invited to Acme on Jian");
        for body in [&message.text, &message.html] {
            assert!(body.contains("Ana invited you"), "{body}");
            assert!(body.contains("Acme"));
            assert!(body.contains("2026-12-02T10:00:00Z"));
            assert!(body.contains("https://jian.example.com/invite#token=ji_abc"));
        }
        assert!(mail("Acme", None).text.contains("You have been invited"));
    }

    #[test]
    fn what_people_typed_cannot_inject_markup_or_new_lines() {
        let message = mail(
            "<script>alert(1)</script>\r\nBcc: x@y.test",
            Some("\"><img src=x onerror=alert(1)>"),
        );
        assert!(!message.html.contains("<script"), "{}", message.html);
        assert!(!message.html.contains("<img"), "{}", message.html);
        assert!(message.html.contains("&lt;script&gt;"));
        assert!(!message.subject.contains(['\r', '\n']));
        assert!(message.text.lines().count() < 8, "{}", message.text);
        assert!(!message.text.contains('\r'));
    }
}
