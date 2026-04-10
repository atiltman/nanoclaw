/**
 * eBay Watcher runner.
 * Fetches an eBay search URL, finds new listings, posts to Discord thread and DMs creator.
 */

import {
  EbayWatch,
  buildEbayUrl,
  getSeenIds,
  markSeen,
  markWatchRun,
  setWatchStatus,
  getThread,
  setThread,
} from './ebay-watcher-db.js';
import { logger } from './logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Listing {
  id: string;
  title: string;
  price: string;
  priceValue: number | null;
  sellerFeedback: string;
  feedbackPct: number | null;
  feedbackCount: number | null;
  isSketchySeller: boolean;
  url: string;
}

// ── eBay HTML parser (adapted from ebay-monitor.ts) ───────────────────────────

function parseListings(html: string, filterAustralia: boolean): Listing[] {
  const listings: Listing[] = [];
  const seenIds = new Set<string>();
  const idRe = /data-listingid=(\d+)/g;
  let m: RegExpExecArray | null;

  while ((m = idRe.exec(html)) !== null) {
    const id = m[1];
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const url = `https://www.ebay.com.au/itm/${id}`;
    const block = html.slice(m.index, m.index + 15000);

    const titleMatch = block.match(/aria-label="watch ([^"]{5,200})"/);
    const title = titleMatch ? titleMatch[1].trim() : 'Unknown';

    if (filterAustralia) {
      const locationMatch = block.match(/su-styled-text secondary large">from ([^<]+)<\/span>/);
      const location = locationMatch ? locationMatch[1].trim() : '';
      if (location && location !== 'Australia') continue;
    }

    const priceMatch = block.match(/s-card__price">(AU \$[\d,]+\.?\d*)<\/span>/);
    const price = priceMatch ? priceMatch[1] : '';
    const priceValue = price ? parseFloat(price.replace(/[^0-9.]/g, '')) : null;

    const feedbackMatch = block.match(/(\d+)% positive \((\d+)\)/);
    const feedbackPct = feedbackMatch ? parseInt(feedbackMatch[1], 10) : null;
    const feedbackCount = feedbackMatch ? parseInt(feedbackMatch[2], 10) : null;
    const sellerFeedback = feedbackMatch
      ? `${feedbackMatch[1]}% positive (${feedbackMatch[2]} ratings)`
      : '';
    const isSketchySeller = feedbackPct === 0 || feedbackCount === 0;

    listings.push({ id, title, price, priceValue, sellerFeedback, feedbackPct, feedbackCount, isSketchySeller, url });
  }

  return listings;
}

// ── Discord REST helpers ───────────────────────────────────────────────────────

async function discordRequest(token: string, method: string, path: string, body?: object): Promise<unknown> {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${res.status} ${method} ${path}: ${text}`);
  }
  return res.json();
}

async function resolveThread(token: string, watch: EbayWatch): Promise<string> {
  const existing = getThread(watch.id, watch.chat_jid);
  if (existing) return existing;

  const channelId = watch.chat_jid.replace('dc:', '');
  const name = `eBay: ${watch.keywords.slice(0, 80)}`;
  const thread = await discordRequest(token, 'POST', `/channels/${channelId}/threads`, {
    name,
    type: 11, // PUBLIC_THREAD
    auto_archive_duration: 10080,
  }) as { id: string };

  setThread(watch.id, watch.chat_jid, thread.id);
  logger.info({ watchId: watch.id, threadId: thread.id }, 'eBay watch thread created');
  return thread.id;
}

async function sendToThread(token: string, threadId: string, content: string): Promise<void> {
  const MAX = 2000;
  for (let i = 0; i < content.length; i += MAX) {
    await discordRequest(token, 'POST', `/channels/${threadId}/messages`, {
      content: content.slice(i, i + MAX),
    });
  }
}

async function sendDm(token: string, userId: string, content: string): Promise<void> {
  try {
    const dm = await discordRequest(token, 'POST', `/users/@me/channels`, { recipient_id: userId }) as { id: string };
    await sendToThread(token, dm.id, content);
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to send eBay watcher DM');
  }
}

// ── Listing filter ─────────────────────────────────────────────────────────────

function meetsSellerCriteria(listing: Listing, watch: EbayWatch): boolean {
  if (listing.feedbackPct === null || listing.feedbackCount === null) return false;
  return listing.feedbackPct >= watch.feedback && listing.feedbackCount >= watch.ratings;
}

function formatListing(listing: Listing): string {
  const lines = [`New eBay listing: ${listing.title}`];
  if (listing.price) lines.push(`Price: ${listing.price}`);
  if (listing.sellerFeedback) {
    lines.push(listing.isSketchySeller
      ? `WARNING - Seller: ${listing.sellerFeedback}`
      : `Seller: ${listing.sellerFeedback}`);
  }
  lines.push(listing.url);
  return lines.join('\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runEbaySearch(
  watch: EbayWatch,
  botToken: string,
): Promise<{ newCount: number }> {
  const url = buildEbayUrl(watch);
  logger.info({ watchId: watch.id, keywords: watch.keywords }, 'Running eBay watch');

  // Fetch eBay
  let html: string;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-AU,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      logger.error({ watchId: watch.id, status: res.status }, 'eBay fetch failed');
      return { newCount: 0 };
    }
    html = await res.text();
  } catch (err) {
    logger.error({ watchId: watch.id, err }, 'eBay fetch error');
    return { newCount: 0 };
  }

  const filterAustralia = watch.location === 'au';
  const listings = parseListings(html, filterAustralia);
  const seenIds = getSeenIds(watch.id);
  const newListings = listings.filter(l => !seenIds.has(l.id));
  const qualified = newListings.filter(l => meetsSellerCriteria(l, watch));

  logger.info({
    watchId: watch.id,
    total: listings.length,
    newRaw: newListings.length,
    qualified: qualified.length,
  }, 'eBay watch results');

  if (qualified.length > 0) {
    const threadId = await resolveThread(botToken, watch);
    for (const listing of qualified) {
      const msg = formatListing(listing);
      await sendToThread(botToken, threadId, msg);
      if (watch.dm_enabled) {
        await sendDm(botToken, watch.user_id, `eBay watch [${watch.id}] — new result:\n${msg}`);
      }
    }
  }

  // Persist seen IDs (all listings, not just new ones)
  markSeen(watch.id, listings.map(l => l.id));
  markWatchRun(watch.id);

  // Check expiry
  if (watch.expires_at && new Date(watch.expires_at) <= new Date()) {
    setWatchStatus(watch.id, 'deleted');
    logger.info({ watchId: watch.id }, 'eBay watch expired');
  }

  return { newCount: qualified.length };
}
