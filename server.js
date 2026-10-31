// Bunker Mini App — сервер: игровая логика, API, проверка подписи Telegram, запуск бота.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';      // https://xxx.onrender.com
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'games.json');

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS для Telegram-клиентов
app.use((req, res, next) => {
  const origin = req.get('origin') || '';
  const allowed = !origin || /(^|\.)telegram\.org$|(^|\.)telegram\.me$/.test(origin);
  res.setHeader('Access-Control-Allow-Origin', allowed ? origin : 'https://web.telegram.org');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Init-Data');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- Хранилище ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let games = {};
try {
  games = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  games = {};
}
const saveTimer = setInterval(() => {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(games)); } catch (e) {}
}, 5000);
function persist() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(games)); } catch (e) {}
}

// ---------- Утилиты ----------
// HTTPS-адрес определяется автоматически: Render проксирует через X-Forwarded-Proto
function externalBase(req) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function randomId(n = 6) {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

// ---------- Проверка подписи initData Telegram ----------
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return { ok: false, reason: 'no_token' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (computed !== hash) return { ok: false, reason: 'bad_hash' };
  const authDate = Number(params.get('auth_date') || 0);
  if (Date.now() / 1000 - authDate > 86400) return { ok: false, reason: 'expired' };
  const userRaw = params.get('user');
  let user = {};
  try { user = JSON.parse(userRaw || '{}'); } catch (e) {}
  return { ok: true, user };
}

function auth(req, res, next) {
  const initData = req.get('X-Init-Data') || (req.body && req.body.initData) || req.query.initData;
  const check = verifyInitData(initData);
  if (!check.ok) return res.status(403).json({ error: 'auth_failed', reason: check.reason });
  req.tgUser = check.user;
  next();
}

// ---------- Игровая логика ----------
const PHASES = ['discussion', 'vote', 'items', 'catastrophe', 'result'];
const PHASE_LABEL = {
  discussion: 'Обсуждение',
  vote: 'Голосование',
  items: 'Выбор вещей',
  catastrophe: 'Катастрофа',
  result: 'Итог',
};

const CATASTROPHES = [
  'В бункер ударила молния. Всех, кто с окном, больше нет.',
  'Затопило грунтовыми водами. Трое самых сильных выжили, остальные — вода.',
  'Пришёл облучающий из космоса. Свет прошёл сквозь стены: выжил только тот, кто был в капюшоне.',
  'Рухнула шахта. В обвал попали все, кто стоял у правой стены.',
  'Началась пандемия. Заразились те, кто выходил за водой. Без исключений.',
  'Ядерная зима. Выживают двое — те, кто ближе к генератору.',
];

const ITEMS = [
  'Фонарь', 'Аптечка', 'Радио', 'Мешок семян', 'Пистолет', 'Карта',
  'Верёвка', 'Консервы', 'Книжка рецептов', 'Очки', 'Компас', 'Тёплое одеяло',
  'Заряд для фонаря', 'Набор инструментов', 'Противогаз', 'Фонарь (запасной)',
];

function newGame(chatId, title) {
  return {
    id: randomId(8),
    chatId,
    title: title || 'Бункер',
    phase: 'discussion',
    round: 1,
    bunkerSize: 2,
    phaseEndsAt: Date.now() + 60000,
    players: [],            // {id, name, alive, items[], voted, chosenItem, score}
    votes: {},             // targetId -> count
    itemsPool: ITEMS.slice(),
    log: [],
    events: [],
    createdAt: Date.now(),
    started: true,
  };
}

function alive(g) { return g.players.filter(p => p.alive); }

function pushLog(g, text) {
  g.log.unshift({ t: Date.now(), text });
  g.log = g.log.slice(0, 200);
}

function advance(g) {
  // переход к следующей фазе
  const aliveCount = alive(g).length;
  if (aliveCount <= g.bunkerSize) {
    g.phase = 'result';
    g.phaseEndsAt = null;
    pushLog(g, `Раунд завершён. В бункере остались: ${alive(g).map(p => p.name).join(', ')}.`);
    return;
  }
  switch (g.phase) {
    case 'discussion':
      g.phase = 'vote';
      g.phaseEndsAt = Date.now() + 45000;
      g.votes = {};
      g.players.forEach(p => { p.voted = null; });
      pushLog(g, 'Фаза обсуждения окончена. Голосуем, кто покинет бункер.');
      break;
    case 'vote': {
      const counts = {};
      g.players.forEach(p => { if (p.voted) counts[p.voted] = (counts[p.voted] || 0) + 1; });
      g.votes = counts;
      let expelled = null, best = 0;
      for (const [id, c] of Object.entries(counts)) {
        if (c > best) { best = c; expelled = id; }
      }
      if (expelled) {
        const p = g.players.find(x => x.id === expelled);
        if (p) { p.alive = false; p.exiled = true; pushLog(g, `${p.name} покидает бункер.`); }
      } else {
        pushLog(g, 'Голоса разделились — никто не покидает бункер. Все пьют воду из стакана.');
      }
      g.phase = 'items';
      g.phaseEndsAt = Date.now() + 40000;
      g.players.forEach(p => { p.chosenItem = null; });
      g.itemsPool = ITEMS.slice().sort(() => Math.random() - 0.5).slice(0, 6);
      break;
    }
    case 'items': {
      // выбранные вещи переходят к игрокам
      g.players.forEach(p => {
        if (p.alive && p.chosenItem) {
          if (!p.items.includes(p.chosenItem)) p.items.push(p.chosenItem);
          pushLog(g, `${p.name} забирает: ${p.chosenItem}.`);
        }
        p.chosenItem = null;
      });
      g.phase = 'catastrophe';
      g.phaseEndsAt = Date.now() + 20000;
      g.catastrophe = CATASTROPHES[Math.floor(Math.random() * CATASTROPHES.length)];
      pushLog(g, `Катастрофа: ${g.catastrophe}`);
      break;
    }
    case 'catastrophe': {
      // применяем последствия: случайный выживший теряет предмет
      const survivors = alive(g);
      if (survivors.length) {
        const loser = survivors[Math.floor(Math.random() * survivors.length)];
        if (loser.items.length) {
          const lost = loser.items.pop();
          pushLog(g, `${loser.name} потерял(а): ${lost}.`);
        } else {
          pushLog(g, `Никто ничего не потерял. ${loser.name} в безопасности.`);
        }
      }
      g.round += 1;
      g.phase = 'discussion';
      g.phaseEndsAt = Date.now() + 60000;
      break;
    }
    default:
      break;
  }
}

function findGame(id) {
  if (games[id]) return games[id];
  return Object.values(games).find(g => g.id === id) || null;
}

function publicState(g, viewerId) {
  if (!g) return null;
  return {
    id: g.id,
    title: g.title,
    phase: g.phase,
    phaseLabel: PHASE_LABEL[g.phase],
    phaseEndsAt: g.phaseEndsAt,
    round: g.round,
    bunkerSize: g.bunkerSize,
    catastrophe: g.catastrophe || null,
    itemsPool: g.itemsPool,
    players: g.players.map(p => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      items: p.alive || viewerId === p.id ? p.items : p.items.length ? ['???'] : [],
      voted: p.voted || null,
      chosenItem: p.chosenItem || null,
      score: p.score || 0,
      isYou: p.id === viewerId,
    })),
    votes: g.votes,
    log: g.log.slice(0, 40),
    viewerId,
  };
}

// ---------- API ----------
app.get('/api/health', (req, res) => res.json({ ok: true, bot: !!BOT_TOKEN, time: Date.now() }));

app.post('/api/game/join', auth, (req, res) => {
  const { chatId, name } = req.body || {};
  if (!chatId) return res.status(400).json({ error: 'chat_id_required' });
  const gid = String(chatId);
  let g = games[gid];
  if (!g || g.phase === 'result') { g = games[gid] = newGame(gid, (req.body && req.body.title) || 'Бункер'); }
  const uid = String(req.tgUser.id);
  let p = g.players.find(x => x.id === uid);
  if (!p) {
    p = { id: uid, name: (name || req.tgUser.first_name || 'Игрок').slice(0, 24), alive: true, items: [], voted: null, chosenItem: null, score: 0 };
    g.players.push(p);
    if (!g.adminId) g.adminId = uid;   // первый вошедший — ведущий игры
    pushLog(g, `${p.name} присоединился к бункеру.`);
  }
  persist();
  res.json(publicState(g, uid));
});

app.get('/api/game/:id', auth, (req, res) => {
  const g = findGame(req.params.id);
  if (!g) return res.status(404).json({ error: 'not_found' });
  res.json(publicState(g, String(req.tgUser.id)));
});

app.post('/api/game/:id/action', auth, (req, res) => {
  const g = findGame(req.params.id);
  if (!g) return res.status(404).json({ error: 'not_found' });
  const uid = String(req.tgUser.id);
  const p = g.players.find(x => x.id === uid);
  if (!p) return res.status(403).json({ error: 'not_a_player' });
  const { action, value } = req.body || {};
  switch (action) {
    case 'vote':
      if (g.phase !== 'vote') return res.status(400).json({ error: 'wrong_phase' });
      if (!p.alive) return res.status(400).json({ error: 'dead' });
      if (!g.players.some(x => x.id === value)) return res.status(400).json({ error: 'bad_target' });
      p.voted = value;
      break;
    case 'item':
      if (g.phase !== 'items') return res.status(400).json({ error: 'wrong_phase' });
      if (!g.itemsPool.includes(value)) return res.status(400).json({ error: 'bad_item' });
      p.chosenItem = value;
      break;
    case 'say':
      pushLog(g, `${p.name}: ${String(value || '').slice(0, 200)}`);
      break;
    case 'next':
      if (String(req.tgUser.id) !== String(g.adminId || '')) {
        // любой игрок может ускорить фазу, но не чаще, чем раз в 20 секунд
        if (Date.now() - (g.lastManualAdvance || 0) < 20000) {
          return res.status(429).json({ error: 'too_soon' });
        }
      }
      g.lastManualAdvance = Date.now();
      advance(g);
      persist();
      break;
    default:
      return res.status(400).json({ error: 'unknown_action' });
  }
  persist();
  res.json(publicState(g, uid));
});

// ---------- Статика Mini App ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- Бот ----------
let bot = null;
function startBot() {
  if (!BOT_TOKEN) {
    console.log('BOT_TOKEN не задан — бот не запущен, работает только Mini App.');
    return;
  }
  const TelegramBot = require('node-telegram-bot-api');
  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  const webApp = (req) => ({
    inline_keyboard: [[{ text: '🎮 Открыть бункер', web_app: { url: `${externalBase(req)}/` } }]],
  });

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
      'Бункер готов. Открой игру — там обсуждение, голосование, вещи и катастрофы.',
      { reply_markup: webApp(msg) });
  });

  bot.onText(/\/new(?:\s+(.*))?/, (msg, match) => {
    const gid = String(msg.chat.id);
    games[gid] = newGame(gid, match && match[1] ? match[1] : 'Бункер');
    games[gid].adminId = String(msg.from.id);
    persist();
    bot.sendMessage(msg.chat.id, 'Новая игра. Заходи в Mini App и жми «В бункер».', { reply_markup: webApp(msg) });
  });

  bot.onText(/\/open/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Мини App:', { reply_markup: webApp(msg) });
  });

  bot.on('polling_error', (e) => console.error('polling_error:', e.message));
  console.log('Бот запущен.');
}

// Автопереход фаз
setInterval(() => {
  const now = Date.now();
  for (const g of Object.values(games)) {
    if (g.phaseEndsAt && now > g.phaseEndsAt) {
      advance(g);
      persist();
    }
  }
}, 3000);

app.listen(PORT, () => {
  console.log(`Bunker server on :${PORT}`);
  startBot();
});
