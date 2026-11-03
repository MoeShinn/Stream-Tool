'use strict';
// App local: 1 kết nối gRPC streamList tới YouTube -> đẩy tin cho OBS qua SSE (127.0.0.1).
const fs = require('fs'), path = require('path'), http = require('http'), https = require('https');
const grpc = require('@grpc/grpc-js'), loader = require('@grpc/proto-loader');
const cfg = { port: 8787, apiKey: '', video: '' };
try { Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))); } catch {}
if (process.env.YT_API_KEY) cfg.apiKey = process.env.YT_API_KEY;
if (process.argv[2]) cfg.video = process.argv[2];
if (!cfg.apiKey) { console.error('Thiếu apiKey: tạo config.json (xem config.example.json) hoặc đặt biến YT_API_KEY.'); process.exit(1); }

const REST = process.env.YT_REST || 'https://www.googleapis.com/youtube/v3/';
const TARGET = process.env.YT_GRPC || 'youtube.googleapis.com:443';
const def = loader.loadSync(path.join(__dirname, 'stream_list.proto'), { keepCase: false, longs: String, enums: String, defaults: false, oneofs: true });
const Svc = grpc.loadPackageDefinition(def).youtube.api.v3.V3DataLiveChatMessageService;
const client = new Svc(TARGET, process.env.YT_INSECURE ? grpc.credentials.createInsecure() : grpc.credentials.createSsl(),
  { 'grpc.keepalive_time_ms': 60000, 'grpc.max_receive_message_length': 1 << 20 });
const md = new grpc.Metadata(); md.set('x-goog-api-key', cfg.apiKey);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const vidOf = (s) => { s = String(s || ''); const m = s.match(/(?:v=|youtu\.be\/|\/live\/|\/embed\/)([\w-]{11})/); return m ? m[1] : s.trim(); };
const getJSON = (url) => new Promise((res, rej) => (url.startsWith('https') ? https : http).get(url, (r) => {
  let b = ''; r.setEncoding('utf8'); r.on('data', (c) => (b += c)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
}).on('error', rej));

const clients = new Set();
const send = (ev, data) => { const s = (ev ? 'event: ' + ev + '\n' : '') + 'data: ' + data + '\n\n'; for (const r of clients) r.write(s); };
const SFILE = path.join(__dirname, 'settings.json');
let settings = null; try { settings = JSON.parse(fs.readFileSync(SFILE, 'utf8')); } catch {}
let video = cfg.video || (settings && settings.v) || '', gen = 0, call = null, state = 'idle';
const setState = (s, msg) => { state = s; if (msg) { log(msg); send('st', msg); } };

// ---- Giới hạn quota (ước tính, lưu vào quota.json, reset theo giờ Thái Bình Dương như YouTube) ----
const LIMIT = Number(process.env.YT_QUOTA_LIMIT || cfg.quotaLimit) || 3000, QFILE = path.join(__dirname, 'quota.json');
const ptDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
let quota = { day: ptDay(), used: 0 };
try { const j = JSON.parse(fs.readFileSync(QFILE, 'utf8')); if (j.day === quota.day) quota = j; } catch {}
function spend(n) {
  const d = ptDay(); if (quota.day !== d) quota = { day: d, used: 0 };
  if (quota.used + n > LIMIT) return false;
  quota.used += n; try { fs.writeFileSync(QFILE, JSON.stringify(quota)); } catch {}
  return true;
}
async function waitQuota(my, n) { // trả false nếu phiên chạy đã bị thay thế
  while (my === gen && !spend(n)) { setState('quota', `Đã dùng ${quota.used}/${LIMIT} đơn vị quota (ước tính), tạm dừng đến khi quota reset`); await sleep(600000); }
  return my === gen;
}

const role = (a) => (a.isChatOwner ? 'owner' : a.isChatModerator ? 'mod' : a.isChatSponsor ? 'mem' : '');
function map(i) {
  const s = i.snippet || {}, a = i.authorDetails || {}, sc = s.superChatDetails;
  if (s.type !== 'TEXT_MESSAGE_EVENT' && s.type !== 'SUPER_CHAT_EVENT') return null;
  return JSON.stringify({ n: a.displayName || '', img: a.profileImageUrl || '', role: role(a), ver: !!a.isVerified,
    t: sc ? sc.userComment || '' : s.displayMessage || (s.textMessageDetails && s.textMessageDetails.messageText) || '',
    time: Date.parse(s.publishedAt) || Date.now(), sc: sc ? sc.amountDisplayString || '' : '', tier: sc ? sc.tier || 0 : 0 });
}

async function run() {
  const my = ++gen;
  if (call) { call.cancel(); call = null; }
  const vid = vidOf(video);
  if (!vid) return setState('idle');
  setState('connect');
  let chat = '';
  while (my === gen) {
    let w = 30000;
    if (!(await waitQuota(my, 1))) return;
    try {
      const j = await getJSON(`${REST}videos?part=liveStreamingDetails&id=${vid}&key=${cfg.apiKey}`);
      if (j.error) { const q = /quota/i.test(j.error.message); setState('err', 'API: ' + j.error.message); if (q) w = 600000; }
      else { chat = j.items && j.items[0] && j.items[0].liveStreamingDetails && j.items[0].liveStreamingDetails.activeLiveChatId; if (chat) break; setState('wait', 'Chưa thấy live chat, thử lại sau 30 giây'); }
    } catch (e) { setState('err', 'Mạng: ' + e.message); }
    await sleep(w);
  }
  let tok = '', skip = true, backoff = 3000;
  while (my === gen) {
    if (!(await waitQuota(my, 5))) return;
    const t0 = Date.now(); let ended = false;
    try {
      await new Promise((res, rej) => {
        const req = { liveChatId: chat, part: ['snippet', 'authorDetails'] }; if (tok) req.pageToken = tok;
        const c = (call = client.StreamList(req, md));
        c.on('data', (r) => {
          if (state !== 'ok') setState('ok');
          if (r.nextPageToken) tok = r.nextPageToken;
          if (r.offlineAt) ended = true;
          if (skip) { skip = false; return; } // bỏ lịch sử ở phản hồi đầu
          for (const i of r.items || []) { if (i.snippet && i.snippet.type === 'CHAT_ENDED_EVENT') ended = true; const m = map(i); if (m) send(null, m); }
        });
        c.on('error', rej); c.on('end', res);
      });
      if (my === gen && state !== 'ok') setState('ok');
    } catch (e) {
      if (my !== gen) return;
      const code = e.code;
      if (code === grpc.status.NOT_FOUND) ended = true;
      else if (code === grpc.status.RESOURCE_EXHAUSTED) { setState('quota', 'Hết quota API hôm nay, thử lại sau 10 phút'); await sleep(600000); continue; }
      else if ([3, 7, 16].includes(code)) { setState('err', 'Lỗi API: ' + (e.details || e.message) + ' (kiểm tra API key)'); await sleep(60000); continue; }
      else log('Mất kết nối:', e.details || e.message);
    }
    if (ended) { setState('ended', 'Live chat đã kết thúc, đã dừng lấy tin'); return; }
    if (Date.now() - t0 > 60000) backoff = 3000;
    await sleep(backoff); backoff = Math.min(backoff * 2, 60000);
  }
}

// ---- Icon khay hệ thống (Windows): xem trạng thái + nút Stop. Tắt bằng "tray": false trong config.json ----
function startTray() {
  if (process.platform !== 'win32' || cfg.tray === false || process.env.YT_NO_TRAY) return;
  try {
    const t = require('child_process').spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'tray.ps1'), '-Port', String(cfg.port)], { windowsHide: true, stdio: 'ignore' });
    t.on('error', (e) => log('Không bật được icon khay:', e.message));
  } catch (e) { log('Không bật được icon khay:', e.message); }
}

const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('<head>', '<head><script>window.__LOCAL__=1</script>');
http.createServer((q, r) => {
  const u = q.url.split('?')[0];
  if (u === '/events') {
    r.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    r.write('retry: 3000\n\n'); clients.add(r); q.on('close', () => clients.delete(r)); return;
  }
  if (u === '/api/video' && q.method === 'POST' && q.headers['x-local'] === '1') {
    let b = ''; q.on('data', (c) => { b += c; if (b.length > 300) q.destroy(); });
    q.on('end', () => { const v = b.trim(); if (v !== video) { video = v; run(); } r.writeHead(204); r.end(); }); return;
  }
  if (u === '/api/settings') {
    if (q.method === 'GET') { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(settings || {})); return; }
    if (q.method === 'POST' && q.headers['x-local'] === '1') {
      let b = ''; q.on('data', (c) => { b += c; if (b.length > 200000) q.destroy(); });
      q.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (!j || typeof j !== 'object' || Array.isArray(j)) throw 0;
          delete j.k; settings = j; fs.writeFileSync(SFILE + '.tmp', JSON.stringify(j, null, 1)); fs.renameSync(SFILE + '.tmp', SFILE); send('cfg', JSON.stringify(j)); r.writeHead(204);
        } catch { r.writeHead(400); }
        r.end();
      }); return;
    }
  }
  if (u === '/api/quit' && q.method === 'POST' && q.headers['x-local'] === '1') { r.writeHead(204); r.end(); log('Đã nhận lệnh tắt'); setTimeout(() => process.exit(0), 100); return; }
  if (u === '/api/status') { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ state, video, clients: clients.size, quota: { used: quota.used, limit: LIMIT } })); return; }
  if (u === '/' || u === '/index.html') { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(page); return; }
  r.writeHead(404); r.end();
}).listen(cfg.port, '127.0.0.1', () => { const url = `http://127.0.0.1:${cfg.port}/`;
  log(`Giao diện chỉnh sửa: ${url} (lấy URL cho OBS ở đó, không cần Ctrl+C)`);
  if (process.platform === 'win32' && cfg.openBrowser !== false && !process.env.YT_NO_OPEN)
    require('child_process').exec(`start "" chrome "${url}" || start "" "${url}"`); // Chrome, không có thì trình duyệt mặc định
  startTray();
  run(); });
setInterval(() => { for (const r of clients) r.write(': ping\n\n'); }, 25000).unref();
process.on('uncaughtException', (e) => log('Lỗi:', e.message));
