#!/usr/bin/env node
/**
 * eBay listing monitor.
 * Fetches a search URL, detects new listings, and sends Discord notifications.
 * Run hourly via systemd timer (nanoclaw-ebay-monitor.timer).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORE_DIR = path.join(PROJECT_ROOT, 'store');
const SEEN_FILE = path.join(STORE_DIR, 'ebay-monitor-seen.json');
const THREAD_FILE = path.join(STORE_DIR, 'ebay-monitor-thread.json');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');

const EBAY_URL =
  'https://www.ebay.com.au/sch/i.html?_udlo=200.00&_nkw=%28%223090%22%2C%223090ti%22%2C%223090+ti%22%29+-dell+-optiplex+-hitachi+-motorola&_sacat=58058&LH_PrefLoc=1&_udhi=1900.00&_sop=10&_svsrch=1';
const DISCORD_CHANNEL_ID = '1484059619671281684';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      return v;
    }
  } catch {
    // .env not found — fall through to process.env
  }
  return process.env[key] ?? '';
}

// ---------------------------------------------------------------------------
// eBay HTML parser
// ---------------------------------------------------------------------------

interface Listing {
  id: string;
  title: string;
  price: string;
  priceValue: number | null; // numeric AU$ for comparison
  isTi: boolean;
  sellerFeedback: string; // e.g. "100% positive (115)"
  isTrustedSeller: boolean; // ≥95% positive with >50 ratings
  url: string;
}

function parseListings(html: string): Listing[] {
  const listings: Listing[] = [];
  const seenIds = new Set<string>();

  // eBay uses data-listingid attribute on each result card.
  // Each unique occurrence marks a new listing block.
  const idRe = /data-listingid=(\d+)/g;
  let m: RegExpExecArray | null;

  while ((m = idRe.exec(html)) !== null) {
    const id = m[1];
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const url = `https://www.ebay.com.au/itm/${id}`;

    // Grab the next 15000 chars of the card block to find title and price
    const block = html.slice(m.index, m.index + 15000);

    // Title: aria-label="watch <Title>" on the watch button
    // Strip the "watch " prefix that eBay prepends.
    const titleMatch = block.match(/aria-label="watch ([^"]{5,200})"/);
    const title = titleMatch ? titleMatch[1].trim() : 'Unknown';

    // Is this a Ti model?
    const isTi = /3090\s*ti/i.test(title);

    // Location: "from Australia" — skip non-AU listings
    const locationMatch = block.match(
      /su-styled-text secondary large">from ([^<]+)<\/span>/,
    );
    const location = locationMatch ? locationMatch[1].trim() : '';
    if (location && location !== 'Australia') continue;

    // Price: inside s-card__price span
    const priceMatch = block.match(
      /s-card__price">(AU \$[\d,]+\.?\d*)<\/span>/,
    );
    const price = priceMatch ? priceMatch[1] : '';
    const priceValue = price
      ? parseFloat(price.replace(/[^0-9.]/g, ''))
      : null;

    // Seller feedback: "100% positive (115)"
    const feedbackMatch = block.match(/(\d+)% positive \((\d+)\)/);
    const feedbackPct = feedbackMatch ? parseInt(feedbackMatch[1], 10) : null;
    const feedbackCount = feedbackMatch ? parseInt(feedbackMatch[2], 10) : null;
    const sellerFeedback = feedbackMatch
      ? `${feedbackMatch[1]}% positive (${feedbackMatch[2]} ratings)`
      : '';
    const isTrustedSeller =
      feedbackPct !== null &&
      feedbackCount !== null &&
      feedbackPct >= 95 &&
      feedbackCount > 50;

    listings.push({ id, title, price, priceValue, isTi, sellerFeedback, isTrustedSeller, url });
  }

  return listings;
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

async function discordRequest(
  token: string,
  method: string,
  path: string,
  body?: object,
): Promise<unknown> {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${res.status} ${method} ${path}: ${text}`);
  }
  return res.json();
}

/** Get or create the persistent 'eBay finds' thread in the channel. */
async function getOrCreateThread(token: string): Promise<string> {
  // Return cached thread ID if we have one
  try {
    const data = JSON.parse(fs.readFileSync(THREAD_FILE, 'utf-8')) as { threadId: string };
    if (data.threadId) return data.threadId;
  } catch {
    // No cache yet
  }

  // Create a new public thread in the channel
  const thread = await discordRequest(token, 'POST', `/channels/${DISCORD_CHANNEL_ID}/threads`, {
    name: 'eBay finds',
    type: 11, // PUBLIC_THREAD
    auto_archive_duration: 10080, // 7 days — won't auto-archive between checks
  }) as { id: string };

  fs.writeFileSync(THREAD_FILE, JSON.stringify({ threadId: thread.id }, null, 2));
  console.log(`Created thread: eBay finds (${thread.id})`);
  return thread.id;
}

async function sendDiscordMessage(
  token: string,
  threadId: string,
  content: string,
): Promise<void> {
  await discordRequest(token, 'POST', `/channels/${threadId}/messages`, { content });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  fs.mkdirSync(STORE_DIR, { recursive: true });

  const token = readEnvKey('DISCORD_BOT_TOKEN');
  if (!token) {
    console.error('Error: DISCORD_BOT_TOKEN not set in .env');
    process.exit(1);
  }

  // Load previously seen listing IDs
  let seenIds: Set<string>;
  try {
    const raw = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8')) as string[];
    seenIds = new Set(raw);
  } catch {
    seenIds = new Set();
  }

  const isFirstRun = seenIds.size === 0;

  // Fetch eBay search page
  console.log(`Fetching: ${EBAY_URL}`);
  const res = await fetch(EBAY_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-AU,en;q=0.9',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!res.ok) {
    console.error(`Failed to fetch eBay page: HTTP ${res.status}`);
    process.exit(1);
  }

  const html = await res.text();
  const listings = parseListings(html);
  console.log(`Parsed ${listings.length} listings (${seenIds.size} seen before)`);

  if (isFirstRun) {
    // Seed without notifying so we only alert on genuinely new items going forward
    console.log('First run — seeding seen IDs, no notifications sent.');
  } else {
    const newListings = listings.filter((l) => !seenIds.has(l.id));
    console.log(`${newListings.length} new listing(s)`);

    if (newListings.length > 0) {
      const threadId = await getOrCreateThread(token);
      for (const listing of newListings) {
      const titleLine = listing.isTi
        ? `🔥 **New eBay listing (3090 Ti!): ${listing.title}**`
        : `**New eBay listing: ${listing.title}**`;

      const isCheap = listing.priceValue !== null && listing.priceValue < 1500;
      const allGood = isCheap && listing.isTrustedSeller;

      const priceLine = listing.price
        ? allGood
          ? `💰 **Price: ${listing.price} — UNDER $1500!**`
          : `Price: ${listing.price}`
        : '';

      const feedbackLine = listing.sellerFeedback
        ? allGood
          ? `💵 Seller: ${listing.sellerFeedback}`
          : `Seller: ${listing.sellerFeedback}`
        : '';

      const msg = [titleLine, priceLine, feedbackLine, listing.url]
        .filter(Boolean)
        .join('\n');

        await sendDiscordMessage(token, threadId, msg);
        console.log(`  Notified: [${listing.id}] ${listing.title} — ${listing.price}`);
      }
    }
  }

  // Persist seen IDs (keep only the IDs from this fetch to avoid unbounded growth)
  const updatedSeen = new Set([...seenIds, ...listings.map((l) => l.id)]);
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...updatedSeen], null, 2));
}

main().catch((err) => {
  console.error('ebay-monitor error:', err);
  process.exit(1);
});
