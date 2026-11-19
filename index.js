const express = require('express');
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || '';      // without @
const APP_SHORT_NAME = process.env.APP_SHORT_NAME || '';  // Mini App short name from BotFather
const WELCOME_BONUS = Number(process.env.WELCOME_BONUS || 50);
const REF_BONUS = Number(process.env.REF_BONUS || 100);
const LINK_WAIT_SECONDS = Number(process.env.LINK_WAIT_SECONDS || 10);

const app = express();
app.use(express.json());

// ---------- Telegram initData verification ----------
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (calc !== hash) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (Date.now() / 1000 - authDate > 86400) return null;
  try {
    return { user: JSON.parse(params.get('user')), start_param: params.get('start_param') || '' };
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const data = verifyInitData(req.headers['x-init-data']);
  if (!data || !data.user) return res.status(401).json({ error: 'Open this app from Telegram.' });
  req.tg = data;
  next();
}

function inviteLink(userId) {
  if (!BOT_USERNAME || !APP_SHORT_NAME) return '';
  return `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}?startapp=ref_${userId}`;
}

// ---------- Init: create user + handle referral ----------
app.post('/api/init', auth, async (req, res) => {
  try {
    const u = req.tg.user;
    const exists = await sql`SELECT id FROM users WHERE id = ${u.id}`;

    if (!exists.length) {
      let ref = null;
      const sp = req.tg.start_param;
      if (sp.startsWith('ref_')) {
        const rid = Number(sp.slice(4));
        if (rid && rid !== u.id) {
          const r = await sql`SELECT id FROM users WHERE id = ${rid}`;
          if (r.length) ref = rid;
        }
      }
      const inserted = await sql`
        INSERT INTO users (id, username, first_name, balance, referred_by)
        VALUES (${u.id}, ${u.username || null}, ${u.first_name || ''}, ${WELCOME_BONUS}, ${ref})
        ON CONFLICT (id) DO NOTHING
        RETURNING id`;
      if (inserted.length && ref) {
        await sql`UPDATE users SET balance = balance + ${REF_BONUS}, ref_count = ref_count + 1 WHERE id = ${ref}`;
      }
    }

    const rows = await sql`SELECT id, first_name, balance, ref_count FROM users WHERE id = ${u.id}`;
    res.json({
      user: rows[0],
      inviteLink: inviteLink(u.id),
      refBonus: REF_BONUS,
      waitSeconds: LINK_WAIT_SECONDS
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Tasks ----------
app.get('/api/tasks', auth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT t.id, t.title, t.type, t.url, t.reward,
             (ut.completed_at IS NOT NULL) AS done,
             (ut.started_at IS NOT NULL) AS started
      FROM tasks t
      LEFT JOIN user_tasks ut ON ut.task_id = t.id AND ut.user_id = ${req.tg.user.id}
      WHERE t.active
      ORDER BY t.id`;
    res.json({ tasks: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/task/start', auth, async (req, res) => {
  try {
    const taskId = Number(req.body.taskId);
    await sql`
      INSERT INTO user_tasks (user_id, task_id, started_at)
      VALUES (${req.tg.user.id}, ${taskId}, now())
      ON CONFLICT (user_id, task_id) DO NOTHING`;
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

async function isChannelMember(chat, userId) {
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chat)}&user_id=${userId}`
    );
    const j = await r.json();
    if (!j.ok) return false;
    return ['member', 'administrator', 'creator'].includes(j.result.status);
  } catch {
    return false;
  }
}

app.post('/api/task/claim', auth, async (req, res) => {
  try {
    const userId = req.tg.user.id;
    const taskId = Number(req.body.taskId);

    const tasks = await sql`SELECT * FROM tasks WHERE id = ${taskId} AND active`;
    if (!tasks.length) return res.status(404).json({ error: 'Task not found.' });
    const task = tasks[0];

    await sql`
      INSERT INTO user_tasks (user_id, task_id, started_at)
      VALUES (${userId}, ${taskId}, now())
      ON CONFLICT (user_id, task_id) DO NOTHING`;

    const ut = (await sql`SELECT * FROM user_tasks WHERE user_id = ${userId} AND task_id = ${taskId}`)[0];
    if (ut.completed_at) return res.status(400).json({ error: 'You already finished this task.' });

    if (task.type === 'channel') {
      const ok = await isChannelMember(task.chat, userId);
      if (!ok) return res.status(400).json({ error: 'Join the channel first, then tap Claim.' });
    } else {
      const waited = (Date.now() - new Date(ut.started_at).getTime()) / 1000;
      if (waited < LINK_WAIT_SECONDS) {
        return res.status(400).json({ error: 'Please finish the task first, then tap Claim.' });
      }
    }

    // Atomic: only the first request gets the reward
    const done = await sql`
      UPDATE user_tasks SET completed_at = now()
      WHERE user_id = ${userId} AND task_id = ${taskId} AND completed_at IS NULL
      RETURNING task_id`;
    if (!done.length) return res.status(400).json({ error: 'You already finished this task.' });

    const bal = await sql`
      UPDATE users SET balance = balance + ${task.reward} WHERE id = ${userId} RETURNING balance`;
    res.json({ ok: true, reward: task.reward, balance: bal[0].balance });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Friends ----------
app.get('/api/friends', auth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT first_name, username, created_at FROM users
      WHERE referred_by = ${req.tg.user.id}
      ORDER BY created_at DESC LIMIT 100`;
    res.json({ friends: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = app;
