// Markdown as plain words, for one-line excerpts: links show their text, marks go.

export function plainText(md: string): string {
  return md
    .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/!?\[\[([^\]#|]+)(#[^\]]*)?\]\]/g, (_, target: string) => target.split("/").pop()!)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/g, "$2")
    .trim();
}
