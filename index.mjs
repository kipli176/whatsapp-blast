// index.mjs — Baileys WhatsApp Bot + Web UI + Contacts/Broadcast
// Kompatibel dengan Baileys (CommonJS) saat dipakai dari ESM .mjs

// --- Imports (CJS-friendly) ---
import baileysPkg from '@whiskeysockets/baileys'; // default import lalu destruktur
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  makeInMemoryStore,   // bisa undefined di beberapa build → ada fallback di bawah
  jidNormalizedUser
} = baileysPkg;

import qrcodeTerminal from 'qrcode-terminal';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// --- Express setup ---
const app = express();
app.use(express.json());

// __dirname untuk ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- State umum ---
let sock = null;
let isConnected = false;
let latestQR = null;

// --- Store (dengan fallback kalau makeInMemoryStore tidak tersedia) ---
let store = null;
let simpleContacts = {}; // fallback penampung kontak minimal

const hasBaileysStore = typeof makeInMemoryStore === 'function';
if (hasBaileysStore) {
  store = makeInMemoryStore({});
  // optionally load
  try {
    if (fs.existsSync('./baileys_store.json')) {
      store.readFromFile('./baileys_store.json');
    }
  } catch {}
  // save periodic
  setInterval(() => {
    try { store.writeToFile('./baileys_store.json'); } catch {}
  }, 10_000);
} else {
  // Fallback: kumpulkan kontak manual via events
  store = {
    contacts: simpleContacts,
    bind: () => {}, // no-op agar pemanggilan store.bind(sock.ev) aman
  };
}

// --- SSE (Server-Sent Events) sederhana untuk QR & status ---
const sseClients = new Set();
function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}
function sseHeartbeat() {
  for (const res of sseClients) {
    try { res.write(`: ping\n\n`); } catch {}
  }
}
setInterval(sseHeartbeat, 25_000);

// --- Helpers kontak ---
function collectContacts() {
  const contactsMap = store?.contacts || {};
  const seen = new Set();
  const list = Object.entries(contactsMap)
    .filter(([jid]) => jid.endsWith('@s.whatsapp.net'))
    .map(([jid, c]) => ({
      jid,
      number: jid.replace('@s.whatsapp.net', ''),
      name: c?.name || c?.verifiedName || c?.notify || '',
      notify: c?.notify || '',
      verifiedName: c?.verifiedName || '',
    }))
    .filter(c => {
      if (seen.has(c.jid)) return false;
      seen.add(c.jid);
      return true;
    })
    .sort((a, b) =>
      (a.name || '').localeCompare(b.name || '') ||
      a.number.localeCompare(b.number)
    );
  return list;
}


function saveContactsToFile(filepath = './contacts.json') {
  const contacts = collectContacts();
  fs.writeFileSync(filepath, JSON.stringify(contacts, null, 2), 'utf-8');
  return { filepath, count: contacts.length };
}

// --- Start WhatsApp connection ---
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,                 // QR juga tampil di logs
    browser: Browsers.ubuntu('BaileysDocker')
  });

  // Ikat store resmi (kalau ada)
  if (hasBaileysStore && typeof store.bind === 'function') {
    store.bind(sock.ev);
  }

  // Fallback: kumpulkan kontak manual lewat events
  if (!hasBaileysStore) {
    // kontak masuk lewat upsert/update
    sock.ev.on('contacts.upsert', (contacts = []) => {
      for (const c of contacts) {
        // c.id adalah JID
        simpleContacts[c.id] = {
          name: c?.name || c?.verifiedName || c?.notify || '',
          notify: c?.notify || '',
          verifiedName: c?.verifiedName || ''
        };
      }
    });
    sock.ev.on('contacts.update', (contacts = []) => {
      for (const c of contacts) {
        const prev = simpleContacts[c.id] || {};
        simpleContacts[c.id] = {
          ...prev,
          name: c?.name ?? prev.name,
          verifiedName: c?.verifiedName ?? prev.verifiedName,
          notify: c?.notify ?? prev.notify
        };
      }
    });
  }

  // Connection lifecycle
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      qrcodeTerminal.generate(qr, { small: true });
      sseBroadcast('qr', { qr });
    }

    if (connection === 'close') {
      isConnected = false;
      sseBroadcast('status', { connected: false });
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) start();
    } else if (connection === 'open') {
      isConnected = true;
      latestQR = null;
      console.log('✅ WhatsApp connected!');
      sseBroadcast('status', { connected: true });

      // simpan snapshot kontak awal (jika bisa)
      try {
        const { count } = saveContactsToFile('./contacts.json');
        console.log(`💾 Contacts snapshot saved (${count}) -> contacts.json`);
      } catch (e) {
        console.log('Could not write contacts.json:', e?.message || e);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// --- Endpoints REST ---

// Kesehatan / status
app.get('/health', (req, res) => {
  res.json({ ok: true, connected: isConnected });
});

// Ambil QR satu-kali (fallback)
app.get('/qr', (req, res) => {
  res.json({ ok: true, qr: latestQR, connected: isConnected });
});

// SSE untuk QR & status realtime
app.get('/qr/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // kirim status awal + QR bila ada
  res.write(`event: status\ndata: ${JSON.stringify({ connected: isConnected })}\n\n`);
  if (latestQR && !isConnected) {
    res.write(`event: qr\ndata: ${JSON.stringify({ qr: latestQR })}\n\n`);
  }

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Kirim pesan tunggal
app.post('/send-message', async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }

  const { number, message } = req.body || {};
  if (!number || !message) {
    return res.status(400).json({ error: 'Missing number or message' });
  }

  const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
  try {
    await sock.sendMessage(jid, { text: message });
    res.json({ status: 'sent', to: number });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Kontak: ambil daftar saat ini
// Kontak: ambil daftar saat ini dengan pagination append-friendly
app.get('/contacts', (req, res) => {
  try {
    const all = collectContacts(); // pastikan collectContacts() sudah urut & unik
    // kembalikan langsung array atau bungkus object {ok, contacts}
    res.json({ ok: true, contacts: all });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to collect contacts' });
  }
});


// Kontak: simpan ke file JSON
app.post('/contacts/save', (req, res) => {
  const { path: customPath } = req.body || {};
  try {
    const { filepath, count } = saveContactsToFile(customPath || './contacts.json');
    res.json({ ok: true, saved: count, file: filepath });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to save contacts' });
  }
});

// Broadcast: kirim ke banyak kontak
app.post('/broadcast', async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }

  const { jids = [], numbers = [], message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Missing message' });

  const targets = new Set([
    ...jids.filter(Boolean),
    ...numbers.filter(Boolean).map(n => (n.includes('@s.whatsapp.net') ? n : `${n}@s.whatsapp.net`)),
  ]);
  if (targets.size === 0) return res.status(400).json({ error: 'No recipients provided' });

  const results = [];
  for (const jid of targets) {
    try {
      await sock.sendMessage(jidNormalizedUser(jid), { text: message });
      results.push({ jid, status: 'sent' });
    } catch (e) {
      results.push({ jid, status: 'failed', error: e?.message || String(e) });
    }
  }
  res.json({ ok: true, total: results.length, results });
});

// (opsional) logout untuk memaksa QR baru
app.post('/logout', async (req, res) => {
  try {
    if (sock?.logout) await sock.logout();
  } catch {}
  // hapus kredensial agar benar-benar fresh login
  try {
    fs.rmSync('./auth_info', { recursive: true, force: true });
  } catch {}
  isConnected = false;
  latestQR = null;
  sseBroadcast('status', { connected: false });
  // mulai ulang koneksi
  start().catch(() => {});
  res.json({ ok: true });
});

// Serve UI statis
app.use(express.static(path.join(__dirname, 'public')));

// Start
start();
app.listen(3000, () => console.log('🚀 API & UI ready on http://localhost:3000'));
