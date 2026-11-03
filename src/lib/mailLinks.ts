// Links to an email in Gmail or Outlook on the web, so Wandika can open the email itself.

export interface MailRef {
  source: "google" | "microsoft";
  id: string;
}

export function mailRef(url: string): MailRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname === "mail.google.com") {
    // https://mail.google.com/mail/u/0/#inbox/18c2f… (the id is the last part of the hash)
    const id = u.hash.split("/").pop() ?? "";
    return /^[0-9a-f]{10,}$/i.test(id) ? { source: "google", id } : null;
  }
  if (/(^|\.)outlook\.(office365|office|live)\.com$/.test(u.hostname)) {
    const id = u.searchParams.get("ItemID");
    return id ? { source: "microsoft", id } : null;
  }
  return null;
}

/** A link to one message (not its thread), so it reopens that email in Wandika and in Gmail. */
export function mailUrl(ref: MailRef, fallback: string | null): string | null {
  return ref.source === "google" ? `https://mail.google.com/mail/u/0/#all/${ref.id}` : fallback;
}
