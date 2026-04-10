#!/usr/bin/env node
/**
 * eBay Watcher daemon.
 * Runs as a systemd oneshot every 5 minutes.
 * Loads due watches and executes them.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDueWatches } from '../src/ebay-watcher-db.js';
import { runEbaySearch } from '../src/ebay-watcher-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');

function readEnvKey(key: string): string {
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      if (k !== key) continue;
      let v = trimmed.slice(eqIdx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v;
    }
  } catch { /* fall through */ }
  return process.env[key] ?? '';
}

async function main(): Promise<void> {
  const token = readEnvKey('DISCORD_BOT_TOKEN');
  if (!token) {
    console.error('DISCORD_BOT_TOKEN not set in .env');
    process.exit(1);
  }

  const due = getDueWatches();
  if (due.length === 0) {
    console.log('eBay watcher: no searches due');
    return;
  }

  console.log(`eBay watcher: running ${due.length} search(es)`);

  const results = await Promise.allSettled(
    due.map(async watch => {
      const result = await runEbaySearch(watch, token);
      console.log(`  [${watch.id}] "${watch.keywords}" — ${result.newCount} new listing(s)`);
      return result;
    }),
  );

  const errors = results.filter(r => r.status === 'rejected');
  if (errors.length > 0) {
    console.error(`  ${errors.length} search(es) failed`);
    errors.forEach(e => console.error(' ', (e as PromiseRejectedResult).reason));
  }
}

main().catch(err => {
  console.error('ebay-watcher-daemon error:', err);
  process.exit(1);
});
