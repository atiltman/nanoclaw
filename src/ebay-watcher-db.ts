/**
 * eBay Watcher DB layer.
 * Opens its own connection to store/messages.db (WAL mode).
 * Safe to import from both NanoClaw process and standalone daemon.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'store', 'messages.db');

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS ebay_watches (
      id          TEXT PRIMARY KEY,
      chat_jid    TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      user_name   TEXT NOT NULL,
      keywords    TEXT NOT NULL,
      exclude     TEXT,
      min_price   REAL,
      max_price   REAL,
      location    TEXT NOT NULL DEFAULT 'au',
      sort        TEXT NOT NULL DEFAULT 'new',
      every_mins  INTEGER NOT NULL DEFAULT 15,
      feedback    INTEGER NOT NULL,
      ratings     INTEGER NOT NULL,
      category    TEXT,
      dm_enabled  INTEGER NOT NULL DEFAULT 1,
      expires_at  TEXT,
      last_run_at TEXT,
      created_at  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS ebay_watch_seen (
      watch_id    TEXT NOT NULL,
      listing_id  TEXT NOT NULL,
      seen_at     TEXT NOT NULL,
      PRIMARY KEY (watch_id, listing_id)
    );
    CREATE TABLE IF NOT EXISTS ebay_watch_threads (
      watch_id    TEXT NOT NULL,
      chat_jid    TEXT NOT NULL,
      thread_id   TEXT NOT NULL,
      PRIMARY KEY (watch_id, chat_jid)
    );
  `);
  return _db;
}

export interface EbayWatch {
  id: string;
  chat_jid: string;
  user_id: string;
  user_name: string;
  keywords: string;
  exclude: string | null;
  min_price: number | null;
  max_price: number | null;
  location: string;
  sort: string;
  every_mins: number;
  feedback: number;
  ratings: number;
  category: string | null;
  dm_enabled: number;
  expires_at: string | null;
  last_run_at: string | null;
  created_at: string;
  status: string;
}

export interface CreateEbayWatch {
  chat_jid: string;
  user_id: string;
  user_name: string;
  keywords: string;
  exclude?: string;
  min_price?: number;
  max_price?: number;
  location?: string;
  sort?: string;
  every_mins?: number;
  feedback: number;
  ratings: number;
  category?: string;
  dm_enabled?: boolean;
  expires_at?: string;
}

export function createWatch(params: CreateEbayWatch): EbayWatch {
  const db = getDb();
  const id = randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ebay_watches (
      id, chat_jid, user_id, user_name, keywords, exclude,
      min_price, max_price, location, sort, every_mins,
      feedback, ratings, category, dm_enabled, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, params.chat_jid, params.user_id, params.user_name,
    params.keywords, params.exclude ?? null,
    params.min_price ?? null, params.max_price ?? null,
    params.location ?? 'au', params.sort ?? 'new',
    params.every_mins ?? 15,
    params.feedback, params.ratings,
    params.category ?? null,
    params.dm_enabled !== false ? 1 : 0,
    params.expires_at ?? null, now,
  );
  return db.prepare('SELECT * FROM ebay_watches WHERE id = ?').get(id) as EbayWatch;
}

export function getWatch(id: string): EbayWatch | undefined {
  return getDb().prepare('SELECT * FROM ebay_watches WHERE id = ?').get(id) as EbayWatch | undefined;
}

export function listWatchesByUser(userId: string): EbayWatch[] {
  return getDb()
    .prepare(`SELECT * FROM ebay_watches WHERE user_id = ? AND status != 'deleted' ORDER BY created_at DESC`)
    .all(userId) as EbayWatch[];
}

export function listAllActiveWatches(): EbayWatch[] {
  return getDb()
    .prepare(`SELECT * FROM ebay_watches WHERE status = 'active' ORDER BY created_at DESC`)
    .all() as EbayWatch[];
}

export function getDueWatches(): EbayWatch[] {
  const db = getDb();
  const now = new Date();
  const all = db
    .prepare(`SELECT * FROM ebay_watches WHERE status = 'active'`)
    .all() as EbayWatch[];
  return all.filter(w => {
    if (!w.last_run_at) return true; // never run → run now
    const elapsed = (now.getTime() - new Date(w.last_run_at).getTime()) / 60000;
    return elapsed >= w.every_mins;
  });
}

export function setWatchStatus(id: string, status: 'active' | 'paused' | 'deleted'): void {
  getDb().prepare('UPDATE ebay_watches SET status = ? WHERE id = ?').run(status, id);
}

export function markWatchRun(id: string): void {
  getDb()
    .prepare('UPDATE ebay_watches SET last_run_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

export function getSeenIds(watchId: string): Set<string> {
  const rows = getDb()
    .prepare('SELECT listing_id FROM ebay_watch_seen WHERE watch_id = ?')
    .all(watchId) as Array<{ listing_id: string }>;
  return new Set(rows.map(r => r.listing_id));
}

export function markSeen(watchId: string, ids: string[]): void {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO ebay_watch_seen (watch_id, listing_id, seen_at) VALUES (?, ?, ?)',
  );
  const now = new Date().toISOString();
  const insert = db.transaction(() => ids.forEach(id => stmt.run(watchId, id, now)));
  insert();
}

export function getThread(watchId: string, chatJid: string): string | undefined {
  const row = getDb()
    .prepare('SELECT thread_id FROM ebay_watch_threads WHERE watch_id = ? AND chat_jid = ?')
    .get(watchId, chatJid) as { thread_id: string } | undefined;
  return row?.thread_id;
}

export function setThread(watchId: string, chatJid: string, threadId: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO ebay_watch_threads (watch_id, chat_jid, thread_id) VALUES (?, ?, ?)')
    .run(watchId, chatJid, threadId);
}

export function buildEbayUrl(watch: EbayWatch): string {
  // Build keyword string: user keywords + exclusions
  let nkw = watch.keywords;
  if (watch.exclude) {
    const excl = watch.exclude.trim();
    if (excl.startsWith('(')) {
      // eBay group syntax: -(dell,optiplex)
      nkw += ` -${excl}`;
    } else {
      // Comma-separated: dell,optiplex → -dell -optiplex
      const terms = excl.split(',').map(t => t.trim()).filter(Boolean);
      nkw += ' ' + terms.map(t => `-${t}`).join(' ');
    }
  }

  const params = new URLSearchParams();
  params.set('_nkw', nkw);
  if (watch.min_price !== null) params.set('_udlo', watch.min_price.toFixed(2));
  if (watch.max_price !== null) params.set('_udhi', watch.max_price.toFixed(2));
  if (watch.category) params.set('_sacat', watch.category);
  if (watch.location === 'au') params.set('LH_PrefLoc', '1');
  params.set('_sop', watch.sort === 'cheap' ? '15' : '10');
  params.set('_svsrch', '1');

  return `https://www.ebay.com.au/sch/i.html?${params.toString()}`;
}
