import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { digest, hash } from './files.mjs';

const TERMINAL = new Set(['passed', 'failed', 'cancelled', 'invalidated']);
const transitions = {
  implement: ['implementing', 'blocked', 'cancelled'],
  implementing: ['verify', 'blocked', 'cancelled'],
  verify: ['verifying', 'blocked', 'cancelled'],
  verifying: ['passed', 'repair', 'failed', 'blocked', 'cancelled'],
  repair: ['repairing', 'blocked', 'cancelled'],
  repairing: ['verify', 'blocked', 'cancelled'],
  blocked: ['implement', 'repair', 'verify', 'cancelled'],
  passed: ['invalidated'],
  failed: [], cancelled: [], invalidated: [],
};
export class Store {
  constructor(root) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = resolve(root);
    this.db = new DatabaseSync(resolve(root, 'delivery.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(hash TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks(workspace TEXT PRIMARY KEY, pid INTEGER NOT NULL, host TEXT NOT NULL, token TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(id, kind, data = {}) {
    this.db.prepare('INSERT INTO events(run,at,kind,data) VALUES(?,?,?,?)').run(id, new Date().toISOString(), kind, JSON.stringify(data));
  }
  create({ owner, workspace, objective, contract, files }) {
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT data FROM runs WHERE workspace=?').all(workspace).map(r => JSON.parse(r.data));
      if (previous.some(r => !TERMINAL.has(r.state))) throw new Error('Workspace has an unfinished delivery; resume or cancel it first');
      const run = { id: randomUUID(), owner, workspace, objective, contract, state: 'implement', repairCount: 0,
        workerCalls: 0, verifyCalls: 0, snapshot: this.snapshot(files), baseSnapshot: digest(files), evidence: [], version: 0,
        contractHash: hash(JSON.stringify(contract)) };
      this.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(run.id, owner, workspace, JSON.stringify(run));
      this.event(run.id, 'created', run);
      return run;
    });
  }
  snapshot(files) {
    const id = digest(files);
    this.db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?)').run(id, JSON.stringify(files));
    return id;
  }
  files(id) {
    const row = this.db.prepare('SELECT data FROM snapshots WHERE hash=?').get(id);
    if (!row) throw new Error('Snapshot missing');
    const files = JSON.parse(row.data);
    if (digest(files) !== id) throw new Error('Snapshot integrity failure');
    return files;
  }
  get(id, owner) {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id);
    if (!row || (owner !== undefined && JSON.parse(row.data).owner !== owner)) throw new Error('Delivery not found in this session');
    return JSON.parse(row.data);
  }
  list(owner) { return this.db.prepare('SELECT data FROM runs WHERE owner=? ORDER BY rowid DESC').all(owner).map(r => JSON.parse(r.data)); }
  history(id) { return this.db.prepare('SELECT seq,at,kind,data FROM events WHERE run=? ORDER BY seq').all(id).map(e => ({ ...e, data: JSON.parse(e.data) })); }
  move(run, state, patch = {}, kind = state) {
    return this.transaction(() => {
      const current = this.get(run.id);
      if (current.version !== run.version) throw new Error('Concurrent delivery update');
      if (!transitions[current.state]?.includes(state)) throw new Error(`Invalid transition ${current.state} -> ${state}`);
      if (state === 'passed' && (current.state !== 'verifying' || !patch.evidence?.length
        || patch.evidence.length !== current.contract.checks.length
        || patch.evidence.some((e, i) => e.id !== current.contract.checks[i].id || e.exitCode !== 0
          || e.kind !== 'passed' || e.snapshot !== current.snapshot))) throw new Error('Missing current verification evidence');
      if (state === 'repair' && current.state === 'verifying'
        && (patch.repairCount !== current.repairCount + 1 || patch.repairCount > current.contract.maxRepairs)) throw new Error('Repair budget exceeded');
      const next = { ...current, ...patch, state, version: current.version + 1 };
      this.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(next), run.id);
      this.event(run.id, kind, { from: current.state, to: state, version: next.version, ...patch });
      Object.assign(run, next);
      return run;
    });
  }
  lock(workspace) {
    const token = randomUUID();
    this.transaction(() => {
      const lock = this.db.prepare('SELECT * FROM locks WHERE workspace=?').get(workspace);
      if (lock) {
        if (lock.host !== hostname()) throw new Error('Another host owns this workspace; manual recovery required');
        let live = true;
        try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') live = false; }
        if (live) throw new Error('Delivery is already running for this workspace');
        this.db.prepare('DELETE FROM locks WHERE workspace=?').run(workspace);
      }
      this.db.prepare('INSERT INTO locks VALUES(?,?,?,?)').run(workspace, process.pid, hostname(), token);
    });
    return () => this.db.prepare('DELETE FROM locks WHERE workspace=? AND token=?').run(workspace, token);
  }
}
