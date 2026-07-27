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
const RECENT_CONV_MS = 5 * 60 * 1000;   // ventana general de "sesion reciente" (contra convAge)
const OFFLINE_GRACE_MS = 2 * 60 * 1000; // gracia antes de offline en ramas terminales (crash/Ctrl-C)

// Algunas tools legitimamente tardan mas que PERMISSION_TIMER_MS sin ser un
// permiso pendiente (Bash largo, sub-agentes). Umbral por tool antes de
// asumir needs_permission.
const TOOL_PERMISSION_GRACE_MS = {
  Bash: 60000,
  Task: 1800000,
  Agent: 1800000,
  Skill: 1800000,
  WebFetch: 30000,
  WebSearch: 30000,
};
const SUBAGENT_ACTIVE_MS = 3 * 60 * 1000; // mtime reciente en subagents/*.jsonl = "trabajando"

// ── Active Process Detection (por sesion) ────────────────────

// Candidatos: comando "claude" (binario en PATH o ruta completa) o una
// version instalada bajo .local/share/claude/versions/<ver>. Se excluyen
// los procesos permanentes del daemon/spawner y los helpers de Claude.app
// (contienen "claude" en minusculas en algunas rutas internas).
const CLAUDE_PROCESS_RE = /(^|\/)claude(\s|$)/;
const CLAUDE_VERSIONED_RE = /\.local\/share\/claude\/versions\/[\d.]+/;
const PROCESS_EXCLUDE_RE = /daemon run|bg-pty-host|bg-spare|--chrome-native-host|Claude\.app/;

let activeCwds = new Set();        // cwds absolutos con un proceso claude vivo
let activeCwdsExtracted = false;   // true si lsof pudo extraer al menos un cwd
let hadCandidateProcesses = false; // true si hubo procesos candidatos (aunque lsof falle)

function refreshActiveProcesses() {
  try {
    const output = execSync(`ps -eo pid,command 2>/dev/null`, { encoding: 'utf-8' });
    const pids = [];
    for (const line of output.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      const [, pid, command] = m;
      if (PROCESS_EXCLUDE_RE.test(command)) continue;
      if (CLAUDE_PROCESS_RE.test(command) || CLAUDE_VERSIONED_RE.test(command)) pids.push(pid);
    }

    hadCandidateProcesses = pids.length > 0;
    const newCwds = new Set();
    let extracted = false;

    if (pids.length > 0) {
      try {
        // Batch: pares "p<pid>" / "n<path>" (con "fcwd" entre medio, se ignora)
        const lsofOut = execSync(`lsof -a -p ${pids.join(',')} -d cwd -Fn 2>/dev/null`, { encoding: 'utf-8' });
        for (const l of lsofOut.split('\n')) {
          if (l.startsWith('p')) continue;
          if (l.startsWith('n')) {
            newCwds.add(l.slice(1));
            extracted = true;
          }
        }
      } catch {}
    }

    activeCwds = newCwds;
    activeCwdsExtracted = extracted;
  } catch {
    activeCwds = new Set();
    activeCwdsExtracted = false;
    hadCandidateProcesses = false;
  }
}

// Match exacto o por prefijo de directorio en ambos sentidos. Si hay
// procesos candidatos pero lsof no pudo extraer ningun cwd, degrada al
// comportamiento global (fallback) en vez de marcar todo offline.
function isCwdActive(cwd) {
  if (!hadCandidateProcesses) return false;
  if (!activeCwdsExtracted) return true;
  if (!cwd) return false;
  for (const active of activeCwds) {
    if (active === cwd) return true;
    if (active.startsWith(cwd + '/') || cwd.startsWith(active + '/')) return true;
  }
  return false;
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

// Whitelist (no blacklist) de tipos de entrada "conversacionales": el CLI
// intercala muchos otros tipos (attachment, last-prompt, mode,
// permission-mode, ai-title, agent-name, queue-operation, pr-link,
// file-history-*, system:away_summary/stop_hook_summary, ...) que no deben
// decidir el estado. system solo cuenta si es turn_duration.
const CONVERSATIONAL_TYPES = new Set(['user', 'assistant', 'progress']);
function isConversational(entry) {
  return CONVERSATIONAL_TYPES.has(entry.type) || (entry.type === 'system' && entry.subtype === 'turn_duration');
}

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

// ── Turn window (ventana anclada, no lineas fijas) ────────────

const TURN_WINDOW_CAP = 400;

// Misma frontera que "nuevo turno" en el tracking de tools: un mensaje
// humano real (user con contenido array sin tool_result) o el cierre
// explicito de turno.
function isTurnBoundary(entry) {
  if (entry.type === 'system' && entry.subtype === 'turn_duration') return true;
  if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
    return !entry.message.content.some(b => b.type === 'tool_result');
  }
  return false;
}

// Retrocede desde el final (tope TURN_WINDOW_CAP lineas) hasta la ultima
// frontera de turno, para no cortar un tool_use sin su tool_result.
function windowSinceLastTurn(lines) {
  const start = Math.max(0, lines.length - TURN_WINDOW_CAP);
  const capped = lines.slice(start);
  for (let i = capped.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(capped[i]); } catch { continue; }
    if (isTurnBoundary(entry)) return capped.slice(i);
  }
  return capped;
}

// ── Sub-agentes (Task/Agent/Skill pendientes) ─────────────────

// <dir del jsonl>/<sessionId>/subagents/*.jsonl con mtime reciente =
// sub-agente todavia trabajando (evita falso needs_permission).
function hasFreshSubagentActivity(facts) {
  try {
    const subagentsDir = path.join(path.dirname(facts.filePath), facts.sessionId, 'subagents');
    const files = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl'));
    const now = Date.now();
    for (const f of files) {
      const stat = fs.statSync(path.join(subagentsDir, f));
      if (now - stat.mtimeMs < SUBAGENT_ACTIVE_MS) return true;
    }
  } catch {}
  return false;
}

// ── JSONL Parsing ────────────────────────────────────────────

// I/O + parseo puro: no depende de Date.now() ni de procesos vivos, asi que
// es cacheable por mtime+size (ver factsCache).
function parseSessionFacts(filePath) {
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

    // Ventana anclada al ultimo turno (tope 400 lineas) en vez de un
    // numero fijo de lineas — garantiza que ningun tool_use quede sin su
    // tool_result dentro de la ventana.
    const recentLines = windowSinceLastTurn(lines);
    const tracking = { activeToolIds: new Set(), activeToolNames: new Map(), hadToolsInTurn: false, lastAssistantText: '', lastToolName: null, lastModel: null };

    let lastEntry = null;
    let lastConvEntry = null;
    let lastConvTimestamp = null;

    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId) sessionId = entry.sessionId;
        if (entry.slug) slug = entry.slug;
        if (entry.cwd) { cwd = entry.cwd; if (!initialCwd) initialCwd = entry.cwd; }
        if (entry.timestamp) lastActivity = entry.timestamp; // cualquier entrada, para orden/display

        if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
          if (entry.message.model) tracking.lastModel = entry.message.model;
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

        // Whitelist conversacional: decide el estado solo con esto, nunca
        // con away_summary/attachment/etc.
        if (isConversational(entry)) {
          lastConvEntry = entry;
          lastConvTimestamp = entry.timestamp || lastConvTimestamp;
        }

        lastEntry = entry;
      } catch {}
    }

    if (!lastEntry || !sessionId) return null;

    return {
      filePath,
      sessionId,
      slug,
      cwd,
      initialCwd,
      purpose,
      lastActivity,
      lastConvEntry,
      lastConvTimestamp,
      tracking,
    };
  } catch {
    return null;
  }
}

// Cache de facts por archivo: evita re-parsear si mtime+size no cambiaron
// entre ticks (el tick corre cada 2s, la mayoria de sesiones no cambian).
const factsCache = new Map(); // filePath -> { mtimeMs, size, facts }

function getSessionFacts(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  const cached = factsCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.facts;
  }
  const facts = parseSessionFacts(filePath);
  if (facts) factsCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, facts });
  else factsCache.delete(filePath);
  return facts;
}

// Solo la ultima linea real, terminada en "?" y corta. Sin lista de
// palabras clave (era la fuente principal de falsos needs_input+chime).
function looksLikeQuestion(text) {
  if (!text) return false;
  const lastLine = text.trim().split('\n').filter(l => l.trim()).pop() || '';
  return lastLine.length < 250 && /\?\s*$/.test(lastLine);
}

// Pura (aparte de Date.now() e isCwdActive): decide estado a partir de los
// facts ya parseados. Se recalcula en cada tick sin volver a leer el archivo.
function deriveState(facts) {
  const { sessionId, slug, initialCwd, purpose, lastActivity, lastConvEntry, lastConvTimestamp, tracking } = facts;
  // Si la ventana de turno no incluyo ninguna linea con "cwd" (poco comun,
  // el CLI lo escribe en casi todas), cae a initialCwd — mismo fallback
  // que ya usa el campo "project".
  const cwd = facts.cwd || initialCwd;

  const activityAge = lastActivity ? Date.now() - new Date(lastActivity).getTime() : Infinity;
  const convAge = lastConvTimestamp ? Date.now() - new Date(lastConvTimestamp).getTime() : Infinity;
  const isRecent = convAge < RECENT_CONV_MS;
  const cwdActive = isCwdActive(cwd) || (initialCwd && initialCwd !== cwd && isCwdActive(initialCwd));
  const lastType = lastConvEntry?.type;
  const lastSubtype = lastConvEntry?.subtype;

  let state = 'offline';
  let detail = '';
  let currentTool = null;

  if (lastType === 'system' && lastSubtype === 'turn_duration') {
    // Turn completed definitively (rama terminal: gracia de 2 min, no 5)
    if (!cwdActive && convAge > OFFLINE_GRACE_MS) {
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
    const blocks = lastConvEntry.message?.content || [];
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
        // Umbral por tool: Bash/Task/Agent/Skill/WebFetch/WebSearch toleran
        // mas tiempo antes de asumir needs_permission.
        const graceMs = TOOL_PERMISSION_GRACE_MS[toolName] ?? PERMISSION_TIMER_MS;
        const pendingTooLong = convAge > graceMs && tracking.activeToolIds.size > 0;
        const isSubagentTool = toolName === 'Task' || toolName === 'Agent' || toolName === 'Skill';

        if (pendingTooLong && isSubagentTool && hasFreshSubagentActivity(facts)) {
          state = 'working';
          detail = 'Sub-agente trabajando';
        } else if (pendingTooLong) {
          state = 'needs_permission';
          detail = `Necesita aprobacion para: ${toolName}`;
        } else {
          state = 'working';
          detail = formatToolStatus(toolName, toolBlock?.input);
        }
      }
    } else if (hasText) {
      // Rama terminal (texto sin tool pendiente): misma gracia de 2 min
      if (!cwdActive && convAge > OFFLINE_GRACE_MS) {
        state = 'offline';
        detail = 'Sesion cerrada';
      } else if (looksLikeQuestion(tracking.lastAssistantText)) {
        state = 'needs_input';
        const lastLine = tracking.lastAssistantText.trim().split('\n').pop();
        detail = lastLine ? lastLine.slice(0, 100) : 'Esperando tu respuesta';
      } else if (convAge > TEXT_IDLE_MS) {
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
    const blocks = lastConvEntry.message?.content || [];
    const isToolResult = Array.isArray(blocks) && blocks.some(b => b.type === 'tool_result');

    if (isToolResult) {
      state = 'working';
      // Show what tool just completed
      const lastTool = tracking.lastToolName;
      detail = lastTool ? formatToolStatus(lastTool, null) : 'Procesando...';
      currentTool = lastTool;
    } else {
      if (!isRecent && !cwdActive) {
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
    if (!isRecent && !cwdActive) {
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
}

function getAllSessions() {
  // Dedupe por sessionId real (resumes futuros podrian dejar mas de un
  // archivo con el mismo sessionId) — se queda con el de lastActivity mayor.
  const factsBySessionId = new Map();

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
            const facts = getSessionFacts(fullPath);
            if (!facts) continue;
            const existing = factsBySessionId.get(facts.sessionId);
            if (!existing || new Date(facts.lastActivity || 0) > new Date(existing.lastActivity || 0)) {
              factsBySessionId.set(facts.sessionId, facts);
            }
          }
        }
      }
    } catch {}
  }

  scanDir(CLAUDE_DIR);

  const sessions = [];
  for (const facts of factsBySessionId.values()) {
    const session = deriveState(facts);
    if (session) sessions.push(session);
  }
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

// ── Claude.ai Plan Tier (rate_limit_tier, e.g. "Max (5x)") ───

let cachedPlanTier = null;
let planTierFetchedAt = 0;
const PLAN_TIER_CACHE_MS = 10 * 60 * 1000; // tier rarely changes → cache 10 min

async function fetchPlanTier() {
  if (!CLAUDE_ORG_ID || !CLAUDE_COOKIE) return null;

  // Return cache if fresh
  if (cachedPlanTier && (Date.now() - planTierFetchedAt) < PLAN_TIER_CACHE_MS) {
    return cachedPlanTier;
  }

  try {
    const url = `https://claude.ai/api/organizations/${CLAUDE_ORG_ID}`;
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

    if (!res.ok) return null;

    const data = await res.json();
    const tier = { rate_limit_tier: data.rate_limit_tier || null };
    cachedPlanTier = tier;
    planTierFetchedAt = Date.now();
    return tier;
  } catch {
    return null;
  }
}

// ── Warp Launch Configurations ────────────────────────────────
// Warp no tiene AppleScript (.sdef inexistente), pero las launch configs
// abren ventana nueva y SI ejecutan comandos. warp://action/new_tab abre
// pestana pero NO ejecuta comandos, por eso usamos launch configs.

const WARP_LAUNCH_DIR = path.join(HOME, '.warp', 'launch_configurations');
const WARP_CONFIG_PREFIX = 'agent-dashboard-';
const WARP_CONFIG_MAX_AGE_MS = 60 * 60 * 1000; // 1h

const shellQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;

// Escribe un launch config YAML unico. Usa block scalar (|-) para el
// comando: evita el escapado YAML, el escapado real lo hace shellQuote.
function writeWarpLaunchConfig(targetDir, prompt) {
  fs.mkdirSync(WARP_LAUNCH_DIR, { recursive: true });
  const name = `${WARP_CONFIG_PREFIX}${Date.now()}`;
  const fileName = `${name}.yaml`;
  const cleanPrompt = (prompt || '').replace(/\r?\n/g, ' ').trim();
  const cmd = cleanPrompt
    ? `cd ${shellQuote(targetDir)} && claude ${shellQuote(cleanPrompt)}`
    : `cd ${shellQuote(targetDir)} && claude`;
  const escapedCwd = targetDir.replace(/"/g, '\\"');
  const yaml = `---
name: ${name}
windows:
  - tabs:
      - title: ${path.basename(targetDir)}
        layout:
          cwd: "${escapedCwd}"
          commands:
            - exec: |-
                ${cmd}
`;
  fs.writeFileSync(path.join(WARP_LAUNCH_DIR, fileName), yaml);
  return fileName;
}

// Borra configs viejos (prefijo agent-dashboard-, mtime > 1h) en cada
// lanzamiento, para no acumular basura en ~/.warp/launch_configurations.
function cleanupOldWarpConfigs() {
  try {
    const now = Date.now();
    for (const entry of fs.readdirSync(WARP_LAUNCH_DIR)) {
      if (!entry.startsWith(WARP_CONFIG_PREFIX) || !entry.endsWith('.yaml')) continue;
      const fullPath = path.join(WARP_LAUNCH_DIR, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > WARP_CONFIG_MAX_AGE_MS) fs.unlinkSync(fullPath);
      } catch {}
    }
  } catch {}
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

        cleanupOldWarpConfigs();
        const fileName = writeWarpLaunchConfig(targetDir, prompt);

        // Resuelve contra launch_configurations y arranca Warp si no corre.
        exec(`open "warp://launch/${fileName}"`, (err) => {
          if (err) {
            // Fallback: al menos activar Warp
            exec('open -a Warp', () => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, degraded: true }));
            });
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
    Promise.all([fetchPlanUsage(), fetchPlanTier()]).then(([data, tier]) => {
      // Spread to avoid mutating the cached usage object with the tier field.
      const payload = { ...data, rate_limit_tier: tier?.rate_limit_tier ?? null };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  } else if (req.url?.startsWith('/api/focus-terminal') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      // Warp no expone AppleScript (.sdef inexistente) ni URI para enfocar
      // pestanas, pero sus VENTANAS si son accesibles via System Events.
      // El titulo de ventana = titulo de la pestana activa (y los agentes
      // lanzados desde el dashboard abren ventana propia con el nombre del
      // proyecto), asi que intentamos AXRaise de la ventana cuyo titulo
      // contenga el basename del cwd; si no hay match, activamos Warp.
      const { exec } = require('child_process');
      const activateWarp = (found) => {
        exec('open -a Warp', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, found }));
        });
      };

      let title = '';
      try {
        const { cwd } = JSON.parse(body || '{}');
        if (cwd) title = path.basename(cwd.replace('~', HOME));
      } catch {}

      if (!title) return activateWarp(false);

      // AppleScript: comparacion de texto case-insensitive por defecto.
      // El proceso de Warp Stable se llama "stable"; el canal normal, "Warp".
      const asTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `
        tell application "System Events"
          repeat with p in (application processes whose name is "stable" or name is "Warp")
            tell p
              repeat with w in windows
                if (name of w) contains "${asTitle}" then
                  perform action "AXRaise" of w
                  set frontmost to true
                  return "found"
                end if
              end repeat
            end tell
          end repeat
        end tell
        return "not_found"`;
      exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err, stdout) => {
        if (!err && stdout.trim() === 'found') {
          // AXRaise ya trajo la ventana; frontmost activo la app
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, found: true }));
        } else {
          // Sin match (pestana de fondo en ventana compartida) o sin
          // permiso de Accesibilidad: al menos activar Warp.
          activateWarp(false);
        }
      });
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
        cachedPlanTier = null;
        planTierFetchedAt = 0;
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

// Firma barata "id:state:detail" de todas las sesiones — solo hace
// broadcast si algo realmente cambio, para no spamear a los clientes en
// cada tick de 2s.
let lastBroadcastSignature = '';

function broadcastIfChanged() {
  const sessions = getAllSessions();
  const signature = sessions.map(s => `${s.id}:${s.state}:${s.detail}`).join('|');
  if (signature === lastBroadcastSignature) return;
  lastBroadcastSignature = signature;
  broadcast({ type: 'update', sessions });
}

// Tick del servidor: recalcula estado (deriveState es barato gracias al
// factsCache) y transiciona tarjetas sin depender del polling del cliente.
setInterval(broadcastIfChanged, 2000);

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
  debounceTimer = setTimeout(broadcastIfChanged, 300);
}

watcher.on('change', onFileChange);
watcher.on('add', onFileChange);

// ── Start ────────────────────────────────────────────────────

// Bind ONLY to localhost — not accessible from network
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Dashboard running at http://localhost:${PORT} (localhost only)`);
});
