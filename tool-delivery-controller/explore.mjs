import { randomUUID } from 'node:crypto';
import { safePath } from './files.mjs';

function integer(value, fallback, max) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('Invalid offset/limit');
  return value;
}

// In-memory capabilities are revoked after each worker, including failed starts.
export class SnapshotExplorer {
  sessions = new Map();
  open(files, parent, signal) {
    const token = randomUUID();
    const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => {
      const buffer = Buffer.from(data, 'base64');
      const text = buffer.toString('utf8');
      const binary = text.includes('\0') || !buffer.equals(Buffer.from(text));
      return { path, bytes: buffer.length, binary, text: binary ? null : text };
    });
    this.sessions.set(token, { entries, parent: parent.session.id, signal, child: null });
    return { token, fileCount: entries.length };
  }
  close(token) { this.sessions.delete(token); }
  execute(args, exec) {
    const session = this.sessions.get(args.token);
    if (!session || session.signal.aborted || exec.agent.session.header.parentSession !== session.parent)
      throw new Error('Snapshot access denied or expired');
    const child = exec.agent.session.id;
    if (session.child !== null && session.child !== child) throw new Error('Snapshot belongs to another worker');
    session.child = child;
    exec.signal?.throwIfAborted();
    const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER);
    const entries = session.entries;
    if (args.action === 'read') {
      safePath(args.path);
      const entry = entries.find(entry => entry.path === args.path);
      if (!entry) throw new Error('File not in snapshot');
      if (entry.binary) throw new Error('Binary file cannot be read as text');
      const limit = integer(args.limit, 4000, 4000);
      if (!limit) throw new Error('limit must be positive');
      const content = entry.text.slice(offset, offset + limit);
      return { path: entry.path, content, offset, nextOffset: offset + content.length < entry.text.length ? offset + content.length : null };
    }
    const limit = integer(args.limit, 20, 20);
    if (!limit) throw new Error('limit must be positive');
    if (args.action === 'list') {
      const selected = entries.filter(entry => !args.path || entry.path.startsWith(args.path));
      return { entries: selected.slice(offset, offset + limit).map(({ text, ...entry }) => entry),
        nextOffset: offset + limit < selected.length ? offset + limit : null };
    }
    if (args.action !== 'search' || typeof args.query !== 'string' || !args.query || args.query.length > 256)
      throw new Error('search requires a literal query of 1..256 characters');
    const hits = [];
    let matched = 0;
    for (const entry of entries) {
      if (entry.binary || (args.path && !entry.path.startsWith(args.path))) continue;
      const lines = entry.text.split('\n');
      for (let index = 0, lineOffset = 0; index < lines.length; lineOffset += lines[index].length + 1, index++) {
        const column = lines[index].indexOf(args.query);
        if (column < 0) continue;
        if (matched++ < offset) continue;
        if (hits.length === limit) return { hits, nextOffset: offset + limit };
        const snippetStart = Math.max(0, column - 80);
        hits.push({ path: entry.path, line: index + 1, readOffset: lineOffset + snippetStart, column: column + 1,
          snippet: lines[index].slice(snippetStart, snippetStart + 320) });
      }
    }
    return { hits, nextOffset: null };
  }
}

export function registerExplorer(ctx, explorer, workspaces) {
  ctx.tools.register({
    name: 'snapshot_explore',
    description: 'Explore the current immutable delivery snapshot. list: path prefix, 20 files/page. search: literal query, optional path prefix, 20 matching lines/page with readOffset for direct reading. read: exact path, offset/limit in UTF-16 characters, up to 4000/page. Continue with nextOffset until null. No host filesystem access.',
    parameters: { type: 'object', properties: {
      token: { type: 'string' }, action: { type: 'string', enum: ['list', 'search', 'read'] },
      path: { type: 'string' }, query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 4000 },
    }, required: ['token', 'action'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const result = explorer.execute(args, exec);
      if (args.action === 'read' && workspaces) workspaces.find(exec).execution?.push({ tool: 'snapshot_explore', path: args.path, ok: true, at: new Date().toISOString() });
      return JSON.stringify(result);
    },
  });
}
