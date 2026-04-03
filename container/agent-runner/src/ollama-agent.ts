/**
 * Ollama Agentic Loop
 *
 * Runs Ollama as the primary LLM with access to:
 *   - NanoClaw IPC tools  (send_message, schedule_task, list_tasks, etc.)
 *   - Brave Search        (if /workspace/group/ollama-mcp is present + BRAVE_API_KEY)
 *
 * Called by index.ts for every message that does NOT start with /claude.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import path from 'path';

const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:4b-instruct';
const OLLAMA_HOST  = process.env.OLLAMA_HOST  || 'http://host.docker.internal:11434';
const MAX_ITER     = 15;

function log(msg: string): void {
  process.stderr.write(`[ollama-agent] ${msg}\n`);
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

interface OllamaTool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

interface ToolEntry {
  name: string;
  client: Client;
}

// ── Ollama REST helper ────────────────────────────────────────────────────────

async function ollamaChat(messages: OllamaMessage[], tools: OllamaTool[], think: boolean): Promise<OllamaMessage> {
  const keepAliveRaw = process.env.OLLAMA_KEEP_ALIVE ?? '5m';
  const keepAlive = /^-?\d+$/.test(keepAliveRaw) ? parseInt(keepAliveRaw, 10) : keepAliveRaw;
  const body = JSON.stringify({ model: OLLAMA_MODEL, messages, tools, stream: false, think, keep_alive: keepAlive });
  const headers = { 'Content-Type': 'application/json' };

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_HOST}/api/chat`, { method: 'POST', headers, body });
  } catch {
    // Fallback: host.docker.internal → localhost
    res = await fetch('http://localhost:11434/api/chat', { method: 'POST', headers, body });
  }

  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as { message: OllamaMessage };
  return data.message;
}

// ── Conversation history ──────────────────────────────────────────────────────

const MAX_HISTORY_TURNS = 20; // keep last 20 user/assistant pairs

interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

const HISTORY_FILE = '/workspace/group/ollama-history.json';
const SETTINGS_FILE = '/workspace/group/ollama-settings.json';

function loadThinkSetting(): boolean {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as { think?: boolean };
      return s.think === true;
    }
  } catch { /* ignore */ }
  return true;
}

function loadHistory(): HistoryEntry[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')) as HistoryEntry[];
    }
  } catch { /* ignore corrupt file */ }
  return [];
}

function saveHistory(history: HistoryEntry[]): void {
  const trimmed = history.slice(-MAX_HISTORY_TURNS * 2);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
}

// ── Brave API key loader ──────────────────────────────────────────────────────

function loadBraveApiKey(): string | undefined {
  if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY;
  const envPath = '/workspace/group/ollama-mcp/.env';
  if (fs.existsSync(envPath)) {
    const match = fs.readFileSync(envPath, 'utf-8').match(/^BRAVE_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  }
  return undefined;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runOllamaAgent(
  userText: string,
  mcpServerPath: string,
  containerInput: { chatJid: string; groupFolder: string; isMain: boolean },
): Promise<string> {

  // ── Connect to NanoClaw IPC MCP server ────────────────────────────────────
  const ipcClient = new Client({ name: 'ollama-ipc', version: '1.0.0' }, { capabilities: {} });
  await ipcClient.connect(new StdioClientTransport({
    command: 'node',
    args: [mcpServerPath],
    env: {
      ...process.env,
      NANOCLAW_CHAT_JID:     containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN:      containerInput.isMain ? '1' : '0',
    },
  }));
  log('IPC MCP connected');

  // ── Optionally connect to Brave Search MCP ────────────────────────────────
  const braveServerPath = '/workspace/group/ollama-mcp/src/brave-search-server.js';
  const braveKey = loadBraveApiKey();
  let braveClient: Client | null = null;

  if (fs.existsSync(braveServerPath) && braveKey) {
    try {
      braveClient = new Client({ name: 'ollama-brave', version: '1.0.0' }, { capabilities: {} });
      await braveClient.connect(new StdioClientTransport({
        command: 'node',
        args: [braveServerPath],
        env: { ...process.env, BRAVE_API_KEY: braveKey },
      }));
      log('Brave Search MCP connected');
    } catch (err) {
      log(`Brave Search unavailable: ${err instanceof Error ? err.message : String(err)}`);
      braveClient = null;
    }
  }

  // ── Discover tools from all connected MCP servers ─────────────────────────
  const [{ tools: ipcTools }, { tools: braveTools }] = await Promise.all([
    ipcClient.listTools(),
    braveClient ? braveClient.listTools() : Promise.resolve({ tools: [] }),
  ]);

  const toolRegistry: ToolEntry[] = [
    ...ipcTools.map(t => ({ name: t.name, client: ipcClient })),
    ...braveTools.map(t => ({ name: t.name, client: braveClient! })),
  ];

  const ollamaTools: OllamaTool[] = [...ipcTools, ...braveTools].map(t => ({
    type: 'function' as const,
    function: {
      name:        t.name,
      description: t.description ?? '',
      parameters:  t.inputSchema,
    },
  }));

  log(`Tools available: ${toolRegistry.map(t => t.name).join(', ')}`);

  // ── Agentic loop ───────────────────────────────────────────────────────────
  const now = new Date();
  const nowStr = now.toLocaleString('en-AU', { timeZone: process.env.TZ || 'Australia/Melbourne', dateStyle: 'full', timeStyle: 'long' });
  const systemParts = [
    'You are a helpful assistant based in Melbourne, Australia.',
    `The current date and time is ${nowStr}. When asked about the current date or time, always use this value — never say you do not have access to the current time.`,
    'You have access to tools — use them proactively to give accurate, up-to-date answers.',
  ];
  if (braveClient) {
    systemParts.push(
      'You have Brave Search available as a tool. Use it automatically and without asking whenever a question could benefit from current information, recent events, prices, or any facts you are uncertain about. Never tell the user you cannot search — just search. IMPORTANT: Do NOT say "I will search" or "I\'ll look that up" or announce any intention — emit the tool call directly as your first action. Never describe what you are about to do; just do it.',
    );
  }

  const think = loadThinkSetting();
  log(`Think mode: ${think}`);

  const history = loadHistory();
  const messages: OllamaMessage[] = [
    { role: 'system', content: systemParts.join(' ') },
    ...history,
    { role: 'user', content: `[${nowStr}] ${userText}` },
  ];
  let finalAnswer = '';

  for (let iter = 0; iter < MAX_ITER; iter++) {
    log(`Iter ${iter + 1}: calling ${OLLAMA_MODEL}...`);
    const response = await ollamaChat(messages, ollamaTools, think);
    messages.push(response);

    if (!response.tool_calls?.length) {
      finalAnswer = response.content ?? '';
      log(`Finished — ${finalAnswer.length} chars`);
      break;
    }

    log(`Tool calls: ${response.tool_calls.map(tc => tc.function.name).join(', ')}`);

    for (const tc of response.tool_calls) {
      const entry = toolRegistry.find(t => t.name === tc.function.name);
      let result: string;

      try {
        if (!entry) {
          result = JSON.stringify({ error: `Unknown tool: ${tc.function.name}` });
        } else {
          const toolResult = await entry.client.callTool({
            name:      tc.function.name,
            arguments: tc.function.arguments,
          });
          type ContentBlock = { type: string; text?: string };
          result = (toolResult.content as ContentBlock[])
            ?.find(c => c.type === 'text')?.text ?? '{}';
        }
      } catch (err) {
        result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }

      log(`  ${tc.function.name} → ${result.slice(0, 120)}`);
      messages.push({ role: 'tool', content: result });
    }
  }

  // ── Persist history ────────────────────────────────────────────────────────
  if (finalAnswer) {
    const updatedHistory = [
      ...history,
      { role: 'user' as const, content: userText },
      { role: 'assistant' as const, content: finalAnswer },
    ];
    saveHistory(updatedHistory);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  try { await ipcClient.close(); }  catch { /* ignore */ }
  try { if (braveClient) await braveClient.close(); } catch { /* ignore */ }

  return finalAnswer;
}
