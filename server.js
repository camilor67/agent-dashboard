const http = require('http');
const fs = require('fs');
const path = require('path');
const { watch } = require('chokidar');
const { WebSocketServer } = require('ws');
const { execSync } = require('child_process');

const PORT = 3456;
const HOME = require('os').homedir();
const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');
const RECENT_THRESHOLD_MS = 4 * 60 * 60 * 1000;

// ── Claude.ai Usage Config ──────────────────────────────────
function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const [key, ...rest] = line.split('=');
      const val = rest.join('=').trim();
      if (key && val) process.env[key.trim()] = val;
    }
  } catch {}
}
loadEnv();

const CLAUDE_ORG_ID = process.env.CLAUDE_ORG_ID || '';
const CLAUDE_SESSION_KEY = process.env.CLAUDE_SESSION_KEY || '';
let CLAUDE_COOKIE = process.env.CLAUDE_COOKIE || '';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
let CLAUDE_USER_AGENT = process.env.CLAUDE_USER_AGENT || DEFAULT_USER_AGENT;

// Timer constants (inspired by pixel-agents)
const PERMISSION_TIMER_MS = 7000;  // tool_use without result = probably waiting approval
const TEXT_IDLE_MS = 5000;         // text-only response, no more data = waiting input

// ── Active Process Detection ─────────────────────────────────

let activeCwds = new Set();

function refreshActiveProcesses() {
  try {
    // Get cwds of running claude processes
    const output = execSync(
      `ps -eo pid,command 2>/dev/null | grep -E "^\\s*[0-9]+\\s+claude" | grep -v grep | awk '{print $1}'`,
      { encoding: 'utf-8' }
    );
    const pids = output.trim().split('\n').filter(Boolean);
    activeCwds = new Set();
    for (const pid of pids) {
      try {
        const cwd = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep "^n/" | grep "cwd" || true`, { encoding: 'utf-8' });
        if (cwd) activeCwds.add(cwd.replace(/^n/, '').trim());
      } catch {}
    }
    // Fallback: just check if any claude process exists
    if (pids.length > 0) activeCwds.add('__has_processes__');
  } catch {
    activeCwds = new Set();
  }
}

function hasActiveClaudeProcesses() {
  return activeCwds.has('__has_processes__') || activeCwds.size > 0;
}

refreshActiveProcesses();
setInterval(refreshActiveProcesses, 5000);

// ── Session State Tracking ───────────────────────────────────

// Per-session state for timer-based detection
const sessionStates = new Map(); // sessionId -> { activeTools, lastType, lastToolUseTime, ... }

function getOrCreateSessionTracking(sessionId) {
  if (!sessionStates.has(sessionId)) {
    sessionStates.set(sessionId, {
      activeToolIds: new Set(),
      activeToolNames: new Map(), // toolId -> toolName
      hadToolsInTurn: false,
      lastAssistantText: '',
      lastToolName: null,
    });
  }
  return sessionStates.get(sessionId);
}

// ── Tool display formatting ──────────────────────────────────

const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);

function formatToolStatus(toolName, input) {
  const base = (p) => typeof p === 'string' ? path.basename(p) : '';
  switch (toolName) {
    case 'Read': return `Leyendo ${base(input?.file_path)}`;
    case 'Edit': return `Editando ${base(input?.file_path)}`;
    case 'Write': return `Escribiendo ${base(input?.file_path)}`;
    case 'Bash': {
      const cmd = (input?.command || '').slice(0, 40);
      return `Ejecutando: ${cmd}${(input?.command || '').length > 40 ? '...' : ''}`;
    }
    case 'Glob': return 'Buscando archivos';
    case 'Grep': return 'Buscando en codigo';
    case 'WebFetch': return 'Descargando web';
    case 'WebSearch': return 'Buscando en la web';
    case 'Agent': return 'Lanzando sub-agente';
    case 'Task': return 'Ejecutando sub-tarea';
    case 'AskUserQuestion': return 'Esperando tu respuesta';
    default: return `Usando ${toolName}`;
  }
}

// ── Security: sanitize data before sending to browser ────────

// Patterns that might contain secrets
const SECRET_PATTERNS = /(?:token|password|secret|key|auth|bearer|api[_-]?key|credential|private)[\s=:"']+\S+/gi;
const URL_WITH_AUTH = /https?:\/\/[^@\s]*:[^@\s]*@/gi;
const ENV_VAR_VALUES = /(?:export\s+)?[A-Z_]+=["']?[^\s"']+/g;

function sanitizeDetail(detail) {
  if (!detail) return '';
  // For tool status, only keep the tool name + safe file basenames
  // Strip anything that looks like a secret
  let safe = detail
    .replace(SECRET_PATTERNS, '[REDACTED]')
    .replace(URL_WITH_AUTH, 'https://[REDACTED]@');
  // Truncate bash commands to just the command name
  if (safe.startsWith('Ejecutando: ')) {
    const cmd = safe.slice(12).split(/\s/)[0]; // just the binary name
    safe = `Ejecutando: ${cmd}...`;
  }
  return safe.slice(0, 500);
}

function sanitizePurpose(purpose) {
  if (!purpose) return '';
  return purpose
    .replace(SECRET_PATTERNS, '[...]')
    .replace(URL_WITH_AUTH, 'https://[...]@')
    .slice(0, 120);
}

// ── JSONL Parsing ────────────────────────────────────────────

function getSessionState(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    let sessionId = null;
    let slug = null;
    let cwd = null;
    let initialCwd = null;
    let lastActivity = null;
    let purpose = null;

    // Extract initial cwd from first lines
    for (const line of lines.slice(0, 10)) {
      try {
        const entry = JSON.parse(line);
        if (entry.cwd) { initialCwd = entry.cwd; break; }
      } catch {}
    }

    // Extract purpose from LAST real human message (most recent prompt)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'user' && entry.userType === 'external' && entry.message?.role === 'user') {
          const c = entry.message.content;
          let text = '';
          if (typeof c === 'string') text = c;
          else if (Array.isArray(c)) {
            for (const block of c) {
              if (block.type === 'text' && block.text) { text = block.text; break; }
            }
          }
          if (text && !text.startsWith('{') && !text.startsWith('[') && !text.startsWith('<') && text.length > 3) {
            purpose = text.slice(0, 120).replace(/\n/g, ' ').trim();
            if (text.length > 120) purpose += '...';
            break;
          }
        }
      } catch {}
    }

    // Process last 80 lines for state detection (more context than before)
    const recentLines = lines.slice(-80);
    const tracking = { activeToolIds: new Set(), activeToolNames: new Map(), hadToolsInTurn: false, lastAssistantText: '', lastToolName: null, lastModel: null };

    let lastEntry = null;
    let lastAssistantEntry = null;

    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId) sessionId = entry.sessionId;
        if (entry.slug) slug = entry.slug;
        if (entry.cwd) { cwd = entry.cwd; if (!initialCwd) initialCwd = entry.cwd; }
        if (entry.timestamp) lastActivity = entry.timestamp;

        if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
          if (entry.message.model) tracking.lastModel = entry.message.model;
          lastAssistantEntry = entry;
          const blocks = entry.message.content;
          const hasToolUse = blocks.some(b => b.type === 'tool_use');

          if (hasToolUse) {
            tracking.hadToolsInTurn = true;
            for (const block of blocks) {
              if (block.type === 'tool_use' && block.id) {
                tracking.activeToolIds.add(block.id);
                tracking.activeToolNames.set(block.id, block.name || '');
                tracking.lastToolName = block.name;
              }
            }
          }

          // Extract last text
          for (const block of blocks) {
            if (block.type === 'text' && block.text) {
              tracking.lastAssistantText = block.text;
            }
          }
        }

        if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
          const blocks = entry.message.content;
          const hasToolResult = blocks.some(b => b.type === 'tool_result');
          if (hasToolResult) {
            for (const block of blocks) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                tracking.activeToolIds.delete(block.tool_use_id);
                tracking.activeToolNames.delete(block.tool_use_id);
              }
            }
            if (tracking.activeToolIds.size === 0) {
              tracking.hadToolsInTurn = false;
            }
          } else {
            // New human message = new turn
            tracking.activeToolIds.clear();
            tracking.activeToolNames.clear();
            tracking.hadToolsInTurn = false;
          }
        }

        if (entry.type === 'system' && entry.subtype === 'turn_duration') {
          tracking.activeToolIds.clear();
          tracking.activeToolNames.clear();
          tracking.hadToolsInTurn = false;
        }

        lastEntry = entry;
      } catch {}
    }

    if (!lastEntry || !sessionId) return null;

    // ── Determine state ──────────────────────────────

    const activityAge = lastActivity ? Date.now() - new Date(lastActivity).getTime() : Infinity;
    const isRecent = activityAge < 5 * 60 * 1000;
    const hasProcesses = hasActiveClaudeProcesses();
    const lastType = lastEntry.type;
    const lastSubtype = lastEntry.subtype;

    let state = 'offline';
    let detail = '';
    let currentTool = null;

    // Question detection heuristic
    function looksLikeQuestion(text) {
      if (!text) return false;
      const lastLines = text.trim().split('\n').slice(-4).join(' ');
      return /\?\s*$/.test(lastLines) ||
        /quieres|deseas|prefieres|te parece|confirma|aprueba|should I|want me|shall I|would you|do you want|proceed|continuar/i.test(lastLines);
    }

    if (lastType === 'system' && lastSubtype === 'turn_duration') {
      // Turn completed definitively
      if (!isRecent && !hasProcesses) {
        state = 'offline';
        detail = 'Sesion cerrada';
      } else if (looksLikeQuestion(tracking.lastAssistantText)) {
        state = 'needs_input';
        const lastLine = tracking.lastAssistantText.trim().split('\n').pop();
        detail = lastLine ? lastLine.slice(0, 100) : 'Esperando tu respuesta';
      } else {
        state = 'completed';
        const lastLines = tracking.lastAssistantText.trim().split('\n').filter(l => l.trim()).slice(-6).join('\n');
        detail = lastLines || 'Turno completado';
      }
    } else if (lastType === 'assistant') {
      const blocks = lastEntry.message?.content || [];
      const hasToolUseNow = blocks.some(b => b.type === 'tool_use');
      const hasText = blocks.some(b => b.type === 'text' && b.text?.trim());

      if (hasToolUseNow) {
        // Active tool use
        const toolBlock = blocks.find(b => b.type === 'tool_use');
        const toolName = toolBlock?.name || '';
        currentTool = toolName;

        if (toolName === 'AskUserQuestion') {
          state = 'needs_input';
          detail = 'Te hizo una pregunta';
        } else {
          // Check if tool has been pending too long (permission wait)
          if (activityAge > PERMISSION_TIMER_MS && tracking.activeToolIds.size > 0) {
            state = 'needs_permission';
            detail = `Necesita aprobacion para: ${toolName}`;
          } else {
            state = 'working';
            detail = formatToolStatus(toolName, toolBlock?.input);
          }
        }
      } else if (hasText) {
        if (!isRecent && !hasProcesses) {
          state = 'offline';
          detail = 'Sesion cerrada';
        } else if (looksLikeQuestion(tracking.lastAssistantText)) {
          state = 'needs_input';
          const lastLine = tracking.lastAssistantText.trim().split('\n').pop();
          detail = lastLine ? lastLine.slice(0, 100) : 'Esperando tu respuesta';
        } else if (activityAge > TEXT_IDLE_MS) {
          state = 'completed';
          const lastLines = tracking.lastAssistantText.trim().split('\n').filter(l => l.trim()).slice(-6).join('\n');
          detail = lastLines || 'Respondio — listo';
        } else {
          state = 'working';
          const lastLines = tracking.lastAssistantText.trim().split('\n').filter(l => l.trim()).slice(-6).join('\n');
          detail = lastLines || 'Generando respuesta...';
        }
      }
    } else if (lastType === 'user') {
      const blocks = lastEntry.message?.content || [];
      const isToolResult = Array.isArray(blocks) && blocks.some(b => b.type === 'tool_result');

      if (isToolResult) {
        state = 'working';
        // Show what tool just completed
        const lastTool = tracking.lastToolName;
        detail = lastTool ? formatToolStatus(lastTool, null) : 'Procesando...';
        currentTool = lastTool;
      } else {
        if (!isRecent && !hasProcesses) {
          state = 'offline';
          detail = 'Sesion cerrada';
        } else {
          state = 'thinking';
          detail = 'Recibio tu mensaje...';
        }
      }
    } else if (lastType === 'progress') {
      state = 'working';
      detail = 'En progreso...';
    } else {
      if (!isRecent && !hasProcesses) {
        state = 'offline';
        detail = 'Sesion cerrada';
      }
    }

    const project = initialCwd ? path.basename(initialCwd) : (cwd ? path.basename(cwd) : 'unknown');

    // ── Security: sanitize output ──────────────────
    // Never expose full paths, session UUIDs, or message content
    const safeDetail = sanitizeDetail(detail);
    const safePurpose = purpose ? sanitizePurpose(purpose) : 'Sin contexto';

    return {
      id: slug || sessionId.slice(0, 8), // use slug, never full sessionId
      slug: slug || sessionId.slice(0, 8),
      project,
      purpose: safePurpose,
      cwd: cwd ? cwd.replace(HOME, '~') : '', // replace home dir with ~
      state,
      detail: safeDetail,
      currentTool: currentTool || null,
      isReading: currentTool ? READING_TOOLS.has(currentTool) : false,
      model: tracking.lastModel ? tracking.lastModel.replace('claude-', '').replace(/-\d{8}$/, '') : null,
      lastActivity,
      activityAge: Math.round(activityAge / 1000),
    };
  } catch {
    return null;
  }
}

function getAllSessions() {
  const sessions = [];

  function scanDir(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'subagents') {
          scanDir(fullPath);
        } else if (entry.name.endsWith('.jsonl') && !fullPath.includes('/subagents/')) {
          const stat = fs.statSync(fullPath);
          const age = Date.now() - stat.mtimeMs;
          if (age < RECENT_THRESHOLD_MS) {
            const session = getSessionState(fullPath);
            if (session) sessions.push(session);
          }
        }
      }
    } catch {}
  }

  scanDir(CLAUDE_DIR);
  sessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
  return sessions;
}

// ── Usage Stats ──────────────────────────────────────────────

function getUsageStats() {
  const byModel = {};    // model -> { input, cache_create, cache_read, output, calls }
  const bySession = {};  // sessionId -> { model, project, input, output, calls }
  let totalInput = 0, totalOutput = 0, totalCalls = 0;

  function scanDir(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'subagents') {
          scanDir(fullPath);
        } else if (entry.name.endsWith('.jsonl') && !fullPath.includes('/subagents/')) {
          const stat = fs.statSync(fullPath);
          const age = Date.now() - stat.mtimeMs;
          if (age < 24 * 60 * 60 * 1000) { // last 24h
            parseUsageFromFile(fullPath);
          }
        }
      }
    } catch {}
  }

  function parseUsageFromFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      let sessionId = null;
      let cwd = null;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.sessionId) sessionId = entry.sessionId;
          if (entry.cwd) cwd = entry.cwd;

          if (entry.type === 'assistant' && entry.message?.model && entry.message?.usage) {
            const model = entry.message.model;
            const usage = entry.message.usage;
            const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
            const output = usage.output_tokens || 0;

            // By model
            if (!byModel[model]) byModel[model] = { input: 0, cache_create: 0, cache_read: 0, output: 0, calls: 0 };
            byModel[model].input += usage.input_tokens || 0;
            byModel[model].cache_create += usage.cache_creation_input_tokens || 0;
            byModel[model].cache_read += usage.cache_read_input_tokens || 0;
            byModel[model].output += output;
            byModel[model].calls++;

            // By session
            const sid = sessionId || path.basename(filePath, '.jsonl').slice(0, 8);
            if (!bySession[sid]) bySession[sid] = { model, project: cwd ? path.basename(cwd) : 'unknown', input: 0, output: 0, calls: 0 };
            bySession[sid].input += input;
            bySession[sid].output += output;
            bySession[sid].calls++;

            totalInput += input;
            totalOutput += output;
            totalCalls++;
          }
        } catch {}
      }
    } catch {}
  }

  scanDir(CLAUDE_DIR);

  return {
    total: { input: totalInput, output: totalOutput, calls: totalCalls },
    byModel,
    bySession,
    period: '24h',
  };
}

// ── Claude.ai Plan Usage ─────────────────────────────────────

let cachedPlanUsage = null;
let planUsageFetchedAt = 0;
const PLAN_CACHE_MS = 60 * 1000; // cache for 1 minute

async function fetchPlanUsage() {
  if (!CLAUDE_ORG_ID || !CLAUDE_COOKIE) {
    return { error: 'Missing CLAUDE_ORG_ID or CLAUDE_COOKIE in .env' };
  }

  // Return cache if fresh
  if (cachedPlanUsage && (Date.now() - planUsageFetchedAt) < PLAN_CACHE_MS) {
    return cachedPlanUsage;
  }

  try {
    const url = `https://claude.ai/api/organizations/${CLAUDE_ORG_ID}/usage`;
    const res = await fetch(url, {
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Cookie': CLAUDE_COOKIE,
        'User-Agent': CLAUDE_USER_AGENT,
        'Referer': 'https://claude.ai/settings/usage',
        'Origin': 'https://claude.ai',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
    });

    if (!res.ok) {
      return { error: `HTTP ${res.status}: ${res.statusText}` };
    }

    const data = await res.json();
    cachedPlanUsage = data;
    planUsageFetchedAt = Date.now();
    return data;
  } catch (err) {
    return { error: err.message };
  }
}

// ── HTTP Server ──────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  } else if (req.url === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getAllSessions()));
  } else if (req.url === '/api/projects') {
    // Return unique project directories from known sessions
    const sessions = getAllSessions();
    const dirs = new Map();
    for (const s of sessions) {
      if (s.cwd) {
        const fullCwd = s.cwd.replace('~', HOME);
        const project = s.project || path.basename(fullCwd);
        if (!dirs.has(fullCwd)) {
          dirs.set(fullCwd, project);
        }
      }
    }
    const projects = [...dirs.entries()].map(([cwd, project]) => ({ cwd, project }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(projects));
  } else if (req.url === '/api/new-agent' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { cwd, prompt } = JSON.parse(body);
        const targetDir = (cwd || '').replace('~', HOME);

        // Validate the directory exists
        if (!targetDir || !fs.existsSync(targetDir)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Directorio no existe: ' + targetDir }));
          return;
        }

        const { exec } = require('child_process');

        // Build the command to run in the new tab
        const escapedDir = targetDir.replace(/'/g, "'\\''");
        const claudeCmd = prompt
          ? `cd '${escapedDir}' && claude '${prompt.replace(/'/g, "'\\''")}'`
          : `cd '${escapedDir}' && claude`;

        // AppleScript: open new iTerm tab and run claude
        const script = `
tell application "iTerm2"
  activate
  tell current window
    create tab with default profile
    tell current session of current tab
      write text "${claudeCmd.replace(/"/g, '\\"')}"
    end tell
  end tell
end tell`;
        exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          }
        });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  } else if (req.url === '/api/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getUsageStats()));
  } else if (req.url === '/api/plan-usage') {
    fetchPlanUsage().then(data => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  } else if (req.url?.startsWith('/api/focus-terminal') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { cwd: targetCwd } = JSON.parse(body);
        const { exec, execSync } = require('child_process');

        // Find TTY of claude process running in this cwd
        let targetTty = null;
        try {
          const psOut = execSync(
            `ps -eo pid,tty,command 2>/dev/null | grep -E "^\\s*[0-9]+\\s+ttys.*claude" | grep -v grep`,
            { encoding: 'utf-8' }
          );
          for (const line of psOut.trim().split('\n')) {
            const match = line.trim().match(/^(\d+)\s+(ttys\d+)/);
            if (!match) continue;
            const [, pid, tty] = match;
            try {
              const cwdOut = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep "^n/" | head -1`, { encoding: 'utf-8' });
              const processCwd = cwdOut.replace(/^n/, '').trim();
              if (processCwd && targetCwd) {
                const target = targetCwd.replace('~', HOME);
                if (processCwd.startsWith(target) || target.startsWith(processCwd)) {
                  targetTty = '/dev/' + tty;
                  break;
                }
              }
            } catch {}
          }
        } catch {}

        if (!targetTty) {
          exec('open -a iTerm');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, found: false }));
          return;
        }

        // AppleScript: find iTerm2 session by TTY and focus it
        const script = `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${targetTty}" then
          select t
          tell w to select s
          activate
          return "found"
        end if
      end repeat
    end repeat
  end repeat
  activate
  return "not_found"
end tell`;
        exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err, stdout) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, found: (stdout || '').trim() === 'found', tty: targetTty }));
        });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  } else if (req.url === '/api/update-cookie' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { cookie, userAgent } = JSON.parse(body);
        if (!cookie || !cookie.includes('sessionKey=')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cookie invalido, debe contener sessionKey' }));
          return;
        }
        const envPath = path.join(__dirname, '.env');
        let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
        if (envContent.includes('CLAUDE_COOKIE=')) {
          envContent = envContent.replace(/CLAUDE_COOKIE=.*/,  'CLAUDE_COOKIE=' + cookie);
        } else {
          envContent += (envContent.endsWith('\n') || !envContent ? '' : '\n') + 'CLAUDE_COOKIE=' + cookie + '\n';
        }
        if (userAgent && userAgent.trim()) {
          const ua = userAgent.trim();
          if (envContent.includes('CLAUDE_USER_AGENT=')) {
            envContent = envContent.replace(/CLAUDE_USER_AGENT=.*/, 'CLAUDE_USER_AGENT=' + ua);
          } else {
            envContent += (envContent.endsWith('\n') ? '' : '\n') + 'CLAUDE_USER_AGENT=' + ua + '\n';
          }
          process.env.CLAUDE_USER_AGENT = ua;
          CLAUDE_USER_AGENT = ua;
        }
        fs.writeFileSync(envPath, envContent);
        process.env.CLAUDE_COOKIE = cookie;
        CLAUDE_COOKIE = cookie;
        cachedPlanUsage = null;
        planUsageFetchedAt = 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  } else if (req.url?.startsWith('/sprites/')) {
    // Serve static sprite files (PNG only, from sprites/ directory)
    const safeName = path.basename(req.url);
    if (!safeName.endsWith('.png')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const filePath = path.join(__dirname, 'sprites', safeName);
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ── WebSocket ────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ── File Watcher ─────────────────────────────────────────────

const watcher = watch(CLAUDE_DIR, {
  ignored: /(^|[\/\\])\..(?!claude)/,
  persistent: true,
  ignoreInitial: true,
  depth: 3,
});

let debounceTimer = null;

function onFileChange(filePath) {
  if (!filePath.endsWith('.jsonl') || filePath.includes('/subagents/')) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    broadcast({ type: 'update', sessions: getAllSessions() });
  }, 300);
}

watcher.on('change', onFileChange);
watcher.on('add', onFileChange);

// ── Start ────────────────────────────────────────────────────

// Bind ONLY to localhost — not accessible from network
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Dashboard running at http://localhost:${PORT} (localhost only)`);
});
