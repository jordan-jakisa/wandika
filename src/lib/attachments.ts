// Turning embedded files into something an <img> can show. Files are read once per session and
// kept as blob URLs; a vault switch drops them all.

import { api } from "./api";

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  heic: "image/heic",
};

const ext = (name: string) => name.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
export const isImage = (target: string) => ext(target) in TYPES;

const cache = new Map<string, Promise<string>>();
/** URLs already loaded, so a redrawn image shows at once instead of blinking. */
const ready = new Map<string, string>();

export function readyUrl(target: string, from: string) {
  return /^(https?:|data:)/i.test(target) ? target : ready.get(`${from}\n${target}`);
}

/** A URL for the image `target` embedded in the note `from`. Web images pass straight through. */
export function imageUrl(target: string, from: string): Promise<string> {
  if (/^(https?:|data:)/i.test(target)) return Promise.resolve(target);
  const key = `${from}\n${target}`;
  let url = cache.get(key);
  if (!url) {
    url = api.attachmentRead(target, from).then((buf) => {
      const u = URL.createObjectURL(new Blob([buf], { type: TYPES[ext(target)] }));
      ready.set(key, u);
      return u;
    });
    url.catch(() => cache.delete(key));
    cache.set(key, url);
  }
  return url;
}

export function forgetImages() {
  for (const url of cache.values()) url.then(URL.revokeObjectURL, () => {});
  cache.clear();
  ready.clear();
}

/** Obsidian's name for a pasted picture: "Pasted image 20261103094512.png". */
export function pastedName(file: File) {
  const generic = !file.name || /^image\.\w+$/i.test(file.name);
  if (!generic) return file.name;
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  const kind = Object.entries(TYPES).find(([, type]) => type === file.type)?.[0] ?? "png";
  return `Pasted image ${stamp}.${kind}`;
}
