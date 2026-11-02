// Notes and their [[links]] as a graph, resolved the same way the Rust index resolves links.

export interface GraphNote {
  path: string;
  title: string;
  links: string[];
  board?: boolean;
}

export interface GNode {
  id: string;
  title: string;
  /** Links in and out; drives the dot size. */
  degree: number;
  /** A link target with no note yet. */
  ghost: boolean;
  board: boolean;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface GLink {
  source: string | GNode;
  target: string | GNode;
}

const stem = (p: string) => p.replace(/\.age$/, "").replace(/\.md$/, "").toLowerCase();

export function resolver(notes: GraphNote[]) {
  const byTitle = new Map<string, string>();
  const byStem = new Map<string, string>();
  // Shortest path wins for a bare name, as in Obsidian.
  for (const n of [...notes].sort((a, b) => a.path.length - b.path.length)) {
    const key = n.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, n.path);
    byStem.set(stem(n.path), n.path);
  }
  return (link: string): string | null => {
    const l = link.trim().replace(/\.md$/i, "").toLowerCase();
    if (!l) return null;
    if (l.includes("/")) {
      const exact = byStem.get(l);
      if (exact) return exact;
      for (const [s, p] of byStem) if (s.endsWith("/" + l)) return p;
      return null;
    }
    return byTitle.get(l) ?? null;
  };
}

export function buildGraph(
  notes: GraphNote[],
  opts: { ghosts?: boolean; focus?: string | null; depth?: number } = {},
): { nodes: GNode[]; links: GLink[] } {
  const resolve = resolver(notes);
  const nodes = new Map<string, GNode>();
  for (const n of notes) nodes.set(n.path, { id: n.path, title: n.title, degree: 0, ghost: false, board: !!n.board });
  const seen = new Set<string>();
  const links: { source: string; target: string }[] = [];
  for (const n of notes) {
    for (const raw of n.links) {
      let target = resolve(raw);
      if (!target) {
        if (!opts.ghosts) continue;
        target = `ghost:${raw.trim().toLowerCase()}`;
        if (!nodes.has(target)) nodes.set(target, { id: target, title: raw.trim(), degree: 0, ghost: true, board: false });
      }
      if (target === n.path) continue;
      const key = n.path < target ? `${n.path}\n${target}` : `${target}\n${n.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: n.path, target });
      nodes.get(n.path)!.degree++;
      nodes.get(target)!.degree++;
    }
  }

  if (opts.focus && nodes.has(opts.focus)) {
    const depth = opts.depth ?? 1;
    const near = new Map<string, Set<string>>();
    for (const l of links) {
      (near.get(l.source) ?? near.set(l.source, new Set()).get(l.source)!).add(l.target);
      (near.get(l.target) ?? near.set(l.target, new Set()).get(l.target)!).add(l.source);
    }
    const keep = new Set([opts.focus]);
    let frontier = [opts.focus];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const id of frontier) for (const m of near.get(id) ?? []) if (!keep.has(m)) (keep.add(m), next.push(m));
      frontier = next;
    }
    return {
      nodes: [...nodes.values()].filter((n) => keep.has(n.id)),
      links: links.filter((l) => keep.has(l.source) && keep.has(l.target)),
    };
  }
  return { nodes: [...nodes.values()], links };
}
