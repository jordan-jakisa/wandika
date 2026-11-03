<script lang="ts">
  import { ExternalLink, FileText, ListPlus, X } from "@lucide/svelte";
  import { api, openUrl } from "../api";
  import { app } from "../app.svelte";
  import { mailUrl } from "../mailLinks";
  import { emailTask } from "../taskText";
  import type { MailBody } from "../types";

  /** One email, read in Wandika. Its HTML shows in a frame that runs no scripts and loads nothing
   *  from the web until you ask for images, so opening it tells no one you read it. */
  let dialogEl: HTMLDialogElement;
  let frame = $state<HTMLIFrameElement | null>(null);
  let mail = $state<MailBody | null>(null);
  let failed = $state<string | null>(null);
  let images = $state(false);
  let busy = $state<"task" | "note" | null>(null);
  let height = $state(240);

  const ref = $derived(app.reading);
  const webUrl = $derived(ref ? (mail?.url ?? ref.url) : null);
  const where = $derived(ref?.source === "microsoft" ? "Outlook" : "Gmail");
  const sender = $derived(mail ? mail.from.replace(/\s*<[^>]+>/, "").replace(/"/g, "") || mail.from : "");
  const address = $derived(mail?.from.match(/<([^>]+)>/)?.[1] ?? "");
  const when = $derived.by(() => {
    if (!mail?.date) return "";
    const d = new Date(mail.date);
    return Number.isNaN(d.getTime())
      ? mail.date
      : d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  });
  const remoteImages = $derived(!!mail?.html && /<img[^>]+src=["']?https?:/i.test(mail.html));

  $effect(() => {
    const r = app.reading;
    if (r && !dialogEl.open) {
      mail = null;
      failed = null;
      images = false;
      height = 240;
      api.mailRead(r.source, r.id).then(
        (m) => app.reading === r && (mail = m),
        (e) => app.reading === r && (failed = (e as Error).message),
      );
      dialogEl.showModal();
    } else if (!r && dialogEl.open) {
      dialogEl.close();
    }
  });

  /** The email's HTML as a page of its own: no scripts, and web images only when asked. */
  function page(html: string, allowImages: boolean) {
    const img = allowImages ? "data: cid: https: http:" : "data: cid:";
    const csp = `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{margin:0;padding:16px;font:15px/1.5 system-ui,sans-serif;color:#1c2320;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${html}</body></html>`;
  }

  /** Links inside the email open like any link in Wandika; the frame grows to fit, so the sheet scrolls once. */
  function wire() {
    const doc = frame?.contentDocument;
    if (!doc) return;
    doc.addEventListener("click", (e) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(href)) app.openLink(href);
    });
    height = Math.max(120, doc.documentElement.scrollHeight);
  }

  async function addTask() {
    if (!mail || !ref) return;
    busy = "task";
    await app.addTask(emailTask(mail.subject, mail.from, mailUrl(ref, webUrl)));
    busy = null;
  }

  async function saveNote() {
    if (!ref) return;
    busy = "note";
    try {
      const path = await api.mailToNote(ref.source, ref.id);
      await app.refreshFiles();
      app.reading = null;
      app.open(path);
      app.edited();
    } catch (e) {
      app.say((e as Error).message);
    } finally {
      busy = null;
    }
  }

  // Links in a plain-text email, as links.
  const pieces = (text: string) => text.split(/(https?:\/\/[^\s<>()]+)/g);
</script>

<dialog
  bind:this={dialogEl}
  class="reader"
  aria-label={mail?.subject || "Email"}
  onclose={() => (app.reading = null)}
  onclick={(e) => e.target === dialogEl && (app.reading = null)}
>
  <header>
    <h2>{mail ? mail.subject || "(No subject)" : failed ? "Couldn't open this email" : "Opening the email…"}</h2>
    <button class="icon-btn" onclick={() => (app.reading = null)} aria-label="Close"><X size={20} /></button>
  </header>

  {#if mail}
    <div class="from">
      <span class="who">{sender}</span>
      {#if address && address !== sender}<span class="muted">{address}</span>{/if}
      <span class="muted when">{when}</span>
    </div>
    <div class="actions">
      <button class="btn primary" onclick={addTask} disabled={busy === "task"}><ListPlus size={16} /> Add as task</button>
      <button class="btn" onclick={saveNote} disabled={busy === "note"}><FileText size={16} /> Save as note</button>
      {#if webUrl}
        <button class="btn quiet" onclick={() => openUrl(webUrl)}><ExternalLink size={16} /> Open in {where}</button>
      {/if}
    </div>
    <div class="body">
      {#if mail.html}
        {#if remoteImages && !images}
          <p class="images muted">
            Images from the web are hidden, so the sender can't tell you opened this.
            <button class="link-btn" onclick={() => (images = true)}>Show images</button>
          </p>
        {/if}
        {#key images}
          <iframe
            bind:this={frame}
            title="Email from {sender}"
            sandbox="allow-same-origin"
            srcdoc={page(mail.html, images)}
            style:height="{height}px"
            onload={wire}
          ></iframe>
        {/key}
      {:else}
        <p class="text">{#each pieces(mail.text) as p, i (i)}{#if i % 2}<button class="inline-link" onclick={() => app.openLink(p)}>{p}</button>{:else}{p}{/if}{/each}</p>
      {/if}
    </div>
  {:else if failed}
    <div class="body">
      <p class="muted" role="alert">{failed}</p>
      {#if webUrl}
        <button class="btn" onclick={() => openUrl(webUrl)}><ExternalLink size={16} /> Open in {where}</button>
      {/if}
    </div>
  {:else}
    <div class="body" aria-busy="true"><div class="skeleton"></div><div class="skeleton short"></div></div>
  {/if}
</dialog>

<style>
  .reader {
    width: min(760px, calc(100vw - 32px));
    height: min(860px, calc(100dvh - 48px));
    padding: 0;
    border: 1px solid var(--rule);
    border-radius: var(--radius-lg);
    background: var(--sheet);
    color: var(--ink);
    box-shadow: var(--shadow-modal);
  }
  .reader[open] {
    display: flex;
    flex-direction: column;
    animation: pop-in var(--dur-quick) var(--ease-out);
  }
  .reader::backdrop {
    background: var(--scrim);
  }
  :global(html[data-platform="ios"]) .reader[open],
  :global(html[data-platform="android"]) .reader[open] {
    width: 100vw;
    max-width: 100vw;
    height: 100dvh;
    max-height: 100dvh;
    margin: 0;
    border: 0;
    border-radius: 0;
    padding: var(--safe-top) 0 0;
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-5) var(--space-3) 0 var(--space-6);
  }
  h2 {
    flex: 1;
    margin: 6px 0 0;
    font-size: var(--text-xl);
    font-weight: 650;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }
  .from {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px var(--space-3);
    padding: var(--space-2) var(--space-6) 0;
  }
  .who {
    font-weight: 600;
  }
  .when {
    margin-left: auto;
  }
  .muted {
    color: var(--graphite);
    font-size: var(--small);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-6);
    border-bottom: 1px solid var(--rule);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-4) var(--space-6) calc(var(--space-6) + var(--safe-bottom));
  }
  .images {
    margin: 0 0 var(--space-3);
  }
  iframe {
    display: block;
    width: 100%;
    border: 0;
    border-radius: var(--radius);
    /* Emails are written for a white page; it stays white in dark mode too. */
    background: #fff;
  }
  .text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.6;
    max-width: 70ch;
  }
  .inline-link {
    display: inline;
    padding: 0;
    border: 0;
    background: none;
    color: var(--papyrus);
    font: inherit;
    text-align: left;
    text-decoration: underline;
    text-underline-offset: 2px;
    overflow-wrap: anywhere;
  }
  .skeleton {
    height: 14px;
    margin: 10px 0;
    border-radius: var(--radius-xs);
    background: var(--rule);
  }
  .skeleton.short {
    width: 60%;
  }
</style>
