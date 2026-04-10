/**
 * eBay Watcher command handler.
 * Intercepts !ebay commands in Discord before routing to the agent.
 */

import { ChannelType, Message, TextChannel } from 'discord.js';
import { runEbaySearch } from './ebay-watcher-runner.js';
import { readEnvFile } from './env.js';
import {
  createWatch,
  getWatch,
  getThread,
  setThread,
  listWatchesByUser,
  listAllActiveWatches,
  setWatchStatus,
  buildEbayUrl,
  EbayWatch,
} from './ebay-watcher-db.js';
import { logger } from './logger.js';

// ── Command token parser ───────────────────────────────────────────────────────

const FLAG_RE =
  /^(min|max|loc|sort|every|feedback|ratings|exclude|cat|dm|expires):/i;

interface ParsedArgs {
  keywords: string;
  exclude?: string;
  min?: number;
  max?: number;
  loc?: string;
  sort?: string;
  every?: number;
  feedback?: number;
  ratings?: number;
  cat?: string;
  dm?: boolean;
  expires?: number; // hours
}

function parseArgs(input: string): ParsedArgs {
  const tokens = input.trim().split(/\s+/);
  const keywordTokens: string[] = [];
  const flags: Record<string, string> = {};

  for (const token of tokens) {
    const m = token.match(
      /^(min|max|loc|sort|every|feedback|ratings|exclude|cat|dm|expires):(.*)$/i,
    );
    if (m) {
      flags[m[1].toLowerCase()] = m[2];
    } else {
      keywordTokens.push(token);
    }
  }

  return {
    keywords: keywordTokens.join(' ').trim(),
    exclude: flags.exclude,
    min: flags.min !== undefined ? parseFloat(flags.min) : undefined,
    max: flags.max !== undefined ? parseFloat(flags.max) : undefined,
    loc: flags.loc?.toLowerCase(),
    sort: flags.sort?.toLowerCase(),
    every: flags.every !== undefined ? parseInt(flags.every, 10) : undefined,
    feedback:
      flags.feedback !== undefined ? parseInt(flags.feedback, 10) : undefined,
    ratings:
      flags.ratings !== undefined ? parseInt(flags.ratings, 10) : undefined,
    cat: flags.cat,
    dm: flags.dm !== undefined ? flags.dm.toLowerCase() !== 'off' : undefined,
    expires:
      flags.expires !== undefined ? parseInt(flags.expires, 10) : undefined,
  };
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

function watchSummary(w: EbayWatch): string {
  const lines: string[] = [];
  lines.push(
    `**[${w.id}]** ${w.keywords}${w.exclude ? ` | Exclude: ${w.exclude}` : ''}`,
  );

  const priceStr =
    w.min_price !== null || w.max_price !== null
      ? `$${w.min_price ?? '0'} – $${w.max_price ?? 'any'}`
      : 'any price';
  const locStr = w.location === 'au' ? 'Australia' : 'Worldwide';
  const sortStr = w.sort === 'cheap' ? 'Cheapest first' : 'Newly listed';
  lines.push(`${priceStr} | ${locStr} | ${sortStr} | Every ${w.every_mins}min`);
  lines.push(
    `Feedback: ≥${w.feedback}% / ${w.ratings}+ ratings | Status: ${w.status}`,
  );
  if (w.status !== 'deleted') {
    const thread = getWatchThread(w);
    if (thread) lines.push(`Thread: <#${thread}>`);
  }
  lines.push(`Created by: ${w.user_name}`);
  return lines.join('\n');
}

function getWatchThread(w: EbayWatch): string | undefined {
  try {
    return getThread(w.id, w.chat_jid);
  } catch {
    return undefined;
  }
}

const HELP_TEXT = `**eBay Watcher Commands**

\`!ebay add <keywords> [options]\` — Create a new search
\`!ebay list\` — List your searches
\`!ebay list all\` — List all active searches
\`!ebay stop <id>\` — Stop a search permanently
\`!ebay pause <id>\` — Pause a search
\`!ebay resume <id>\` — Resume a paused search
\`!ebay test <id>\` — Run a search immediately
\`!ebay help\` — Show this help

**Options for \`!ebay add\`** (ratings is required):
\`min:<price>\` \`max:<price>\` — Price range in AU$
\`feedback:<pct>\` — Minimum seller feedback percentage (default: 95%)
\`ratings:<count>\` — Minimum seller rating count
\`exclude:<terms>\` — e.g. \`exclude:dell,optiplex\` or \`exclude:(dell,optiplex)\`
\`loc:worldwide\` — Search worldwide (default: Australia)
\`sort:cheap\` — Cheapest first (default: newly listed)
\`every:<minutes>\` — Check interval, 5–1440 min (default: 15)
\`cat:<id>\` — eBay category ID (e.g. \`cat:58058\` for GPUs)
\`dm:off\` — Disable DM notifications for this search
\`expires:<hours>\` — Auto-stop after N hours

**Keyword syntax:** supports eBay grouping, e.g. \`RTX (3090,4090,5090)\``;

// ── Main handler ───────────────────────────────────────────────────────────────

/**
 * Handle an !ebay command. Returns true if the message was consumed.
 */
export async function handleEbayCommand(
  message: Message,
  content: string,
): Promise<boolean> {
  if (!content.trimStart().toLowerCase().startsWith('!ebay')) return false;

  const parts = content.trim().split(/\s+/);
  const sub = parts[1]?.toLowerCase() ?? '';
  const rest = parts.slice(2).join(' ');
  const userId = message.author.id;
  const userName =
    message.member?.displayName ||
    message.author.displayName ||
    message.author.username;
  const chatJid = `dc:${message.channelId}`;

  try {
    switch (sub) {
      // ── !ebay add ────────────────────────────────────────────────────────────
      case 'add': {
        if (!rest.trim()) {
          await message.reply(
            'Usage: `!ebay add <keywords> [options]`\n' +
              'Example: `!ebay add RTX (3090,4090) min:200 max:1900 feedback:90 ratings:50`\n\n' +
              'Type `!ebay help` for all options.',
          );
          return true;
        }

        const args = parseArgs(rest);

        // Validate required params
        const missing: string[] = [];
        if (!args.keywords) missing.push('`keywords` (the search terms)');
        if (args.ratings === undefined)
          missing.push(
            '`ratings:<count>` — minimum seller rating count, e.g. `ratings:50`',
          );

        if (missing.length > 0) {
          const kw = args.keywords || 'RTX 3090';
          const example = `!ebay add ${kw} ratings:50${args.min !== undefined ? ` min:${args.min}` : ''}${args.max !== undefined ? ` max:${args.max}` : ''}`;
          await message.reply(
            `Missing required parameter${missing.length > 1 ? 's' : ''}:\n` +
              missing.map((m) => `  - ${m}`).join('\n') +
              `\n\nExample: \`${example}\``,
          );
          return true;
        }

        if (args.every !== undefined && (args.every < 5 || args.every > 1440)) {
          await message.reply('`every` must be between 5 and 1440 minutes.');
          return true;
        }
        if (args.feedback !== undefined && (args.feedback < 0 || args.feedback > 100)) {
          await message.reply('`feedback` must be between 0 and 100.');
          return true;
        }

        let expiresAt: string | undefined;
        if (args.expires !== undefined && args.expires > 0) {
          expiresAt = new Date(
            Date.now() + args.expires * 3600 * 1000,
          ).toISOString();
        }

        const watch = createWatch({
          chat_jid: chatJid,
          user_id: userId,
          user_name: userName,
          keywords: args.keywords!,
          exclude: args.exclude,
          min_price: args.min,
          max_price: args.max,
          location: args.loc === 'worldwide' ? 'worldwide' : 'au',
          sort: args.sort === 'cheap' ? 'cheap' : 'new',
          every_mins: args.every ?? 15,
          feedback: args.feedback ?? 95,
          ratings: args.ratings!,
          category: args.cat,
          dm_enabled: args.dm !== false,
          expires_at: expiresAt,
        });

        const previewUrl = buildEbayUrl(watch);
        const priceStr =
          watch.min_price !== null || watch.max_price !== null
            ? `$${watch.min_price ?? '0'} – $${watch.max_price ?? 'any'}`
            : 'any price';

        // Create the thread immediately
        let threadMention = '';
        try {
          const textChannel = message.channel as TextChannel;
          const thread = await textChannel.threads.create({
            name: `eBay: ${watch.keywords.slice(0, 80)}`,
            type: ChannelType.PublicThread,
            autoArchiveDuration: 10080, // 7 days
          });
          setThread(watch.id, watch.chat_jid, thread.id);
          await thread.send(
            `**eBay Watch [${watch.id}]** — ${watch.keywords}\n` +
              `Price: ${priceStr} | ${watch.location === 'au' ? 'Australia' : 'Worldwide'} | ${watch.sort === 'cheap' ? 'Cheapest first' : 'Newly listed'}\n` +
              `Feedback: ≥${watch.feedback}% with ${watch.ratings}+ ratings | Every ${watch.every_mins} minutes\n` +
              `Search URL: ${previewUrl}`,
          );
          threadMention = ` Thread: <#${thread.id}>`;
        } catch (err) {
          logger.warn(
            { err, watchId: watch.id },
            'Failed to create eBay watch thread',
          );
        }

        await message.reply(
          `Search created — ID: \`${watch.id}\`\n` +
            `Keywords: ${watch.keywords}${watch.exclude ? ` | Exclude: ${watch.exclude}` : ''}\n` +
            `Price: ${priceStr} | ${watch.location === 'au' ? 'Australia' : 'Worldwide'} | ${watch.sort === 'cheap' ? 'Cheapest first' : 'Newly listed'}\n` +
            `Feedback: ≥${watch.feedback}% with ${watch.ratings}+ ratings | Every ${watch.every_mins} minutes\n` +
            (expiresAt
              ? `Expires: ${new Date(expiresAt).toLocaleString('en-AU')}\n`
              : '') +
            threadMention,
        );

        // Run an immediate search and post results to the thread
        try {
          const secrets = readEnvFile(['DISCORD_BOT_TOKEN']);
          const token =
            process.env.DISCORD_BOT_TOKEN || secrets.DISCORD_BOT_TOKEN || '';
          const result = await runEbaySearch(watch, token);
          if (result.newCount === 0) {
            // Post "no results" to the thread so it's not silent
            const threadId = getThread(watch.id, watch.chat_jid);
            if (threadId) {
              try {
                const ch = await message.client.channels.fetch(threadId);
                if (ch && 'send' in ch) {
                  await (ch as TextChannel).send(
                    `No listings found matching your criteria right now. Will check again every ${watch.every_mins} minutes.`,
                  );
                }
              } catch {
                /* non-fatal */
              }
            }
          }
        } catch (err) {
          logger.warn({ err, watchId: watch.id }, 'Initial eBay search failed');
        }

        logger.info(
          { watchId: watch.id, userId, keywords: watch.keywords },
          'eBay watch created',
        );
        return true;
      }

      // ── !ebay list ───────────────────────────────────────────────────────────
      case 'list': {
        const showAll = rest.trim().toLowerCase() === 'all';
        const watches = showAll
          ? listAllActiveWatches()
          : listWatchesByUser(userId);

        if (watches.length === 0) {
          await message.reply(
            showAll
              ? 'No active searches.'
              : 'You have no active searches. Use `!ebay add` to create one.',
          );
          return true;
        }

        const header = showAll
          ? `**All active searches (${watches.length}):**\n`
          : `**Your searches (${watches.length}):**\n`;

        // Post in chunks of 5 to stay under Discord's 2000-char limit
        await message.reply(header);
        for (let i = 0; i < watches.length; i += 3) {
          const chunk = watches
            .slice(i, i + 3)
            .map(watchSummary)
            .join('\n\n');
          await message.reply(chunk);
        }
        return true;
      }

      // ── !ebay stop ───────────────────────────────────────────────────────────
      case 'stop': {
        const id = rest.trim();
        if (!id) {
          await message.reply('Usage: `!ebay stop <id>`');
          return true;
        }
        const watch = getWatch(id);
        if (!watch) {
          await message.reply(`Search \`${id}\` not found.`);
          return true;
        }
        if (watch.user_id !== userId) {
          await message.reply('You can only stop your own searches.');
          return true;
        }
        setWatchStatus(id, 'deleted');
        await message.reply(`Search \`${id}\` stopped.`);
        return true;
      }

      // ── !ebay pause ──────────────────────────────────────────────────────────
      case 'pause': {
        const id = rest.trim();
        if (!id) {
          await message.reply('Usage: `!ebay pause <id>`');
          return true;
        }
        const watch = getWatch(id);
        if (!watch) {
          await message.reply(`Search \`${id}\` not found.`);
          return true;
        }
        if (watch.user_id !== userId) {
          await message.reply('You can only pause your own searches.');
          return true;
        }
        if (watch.status === 'paused') {
          await message.reply(`Search \`${id}\` is already paused.`);
          return true;
        }
        setWatchStatus(id, 'paused');
        await message.reply(
          `Search \`${id}\` paused. Use \`!ebay resume ${id}\` to resume.`,
        );
        return true;
      }

      // ── !ebay resume ─────────────────────────────────────────────────────────
      case 'resume': {
        const id = rest.trim();
        if (!id) {
          await message.reply('Usage: `!ebay resume <id>`');
          return true;
        }
        const watch = getWatch(id);
        if (!watch) {
          await message.reply(`Search \`${id}\` not found.`);
          return true;
        }
        if (watch.user_id !== userId) {
          await message.reply('You can only resume your own searches.');
          return true;
        }
        if (watch.status === 'active') {
          await message.reply(`Search \`${id}\` is already active.`);
          return true;
        }
        setWatchStatus(id, 'active');
        await message.reply(`Search \`${id}\` resumed.`);
        return true;
      }

      // ── !ebay test ───────────────────────────────────────────────────────────
      case 'test': {
        const id = rest.trim();
        if (!id) {
          await message.reply('Usage: `!ebay test <id>`');
          return true;
        }
        const watch = getWatch(id);
        if (!watch) {
          await message.reply(`Search \`${id}\` not found.`);
          return true;
        }
        if (watch.user_id !== userId) {
          await message.reply('You can only test your own searches.');
          return true;
        }

        await message.reply(`Running search \`${id}\` now...`);

        const secrets = readEnvFile(['DISCORD_BOT_TOKEN']);
        const token =
          process.env.DISCORD_BOT_TOKEN || secrets.DISCORD_BOT_TOKEN || '';

        const result = await runEbaySearch(watch, token);
        if (result.newCount === 0) {
          await message.reply(
            `Search \`${id}\`: no new listings found (or first run — seeding seen IDs).`,
          );
        } else {
          await message.reply(
            `Search \`${id}\`: found ${result.newCount} new listing(s). Check the thread.`,
          );
        }
        return true;
      }

      // ── !ebay help / unknown ─────────────────────────────────────────────────
      case 'help':
      default: {
        await message.reply(HELP_TEXT);
        return true;
      }
    }
  } catch (err) {
    logger.error({ err }, 'eBay command error');
    await message.reply('An error occurred. Check logs for details.');
    return true;
  }
}
