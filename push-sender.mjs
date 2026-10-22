// Familien-Planer: verschickt Benachrichtigungen (Chat, Erinnerungen, Wecker).
// Läuft kostenlos bei GitHub (Datei .github/workflows/push.yml) alle paar Minuten.
// Braucht keine Zusatzpakete. Der geheime Schlüssel steht nur im GitHub-Secret FIREBASE_SA.
import crypto from 'node:crypto';

// Fehler als „Annotation“ ausgeben: die sieht man bei GitHub auch ohne Anmeldung
const note = (lvl, msg) => console.log(`::${lvl} title=Familien-Planer::` + String(msg).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').slice(0, 900));
let sa = {};
try { sa = JSON.parse(process.env.FIREBASE_SA || '{}'); }
catch (e) { note('error', 'Das Secret FIREBASE_SA ist kein gültiger Schlüssel-Text (beim Einfügen beschädigt?): ' + e.message); process.exit(1); }
if (!sa.private_key || !sa.client_email || !sa.project_id) { console.log('Secret FIREBASE_SA fehlt oder ist unvollständig.'); process.exit(0); }
const P = sa.project_id;
const DB = `https://firestore.googleapis.com/v1/projects/${P}/databases/(default)/documents`;
const LOOKAHEAD = 7 * 60000;   // bis zu 7 Min. früher schicken, weil GitHub nicht minutengenau startet
const LATE = 90 * 60000;       // Erinnerungen, die älter als 90 Min. sind, nicht mehr schicken
const now = Date.now();
let H;

async function login() {
  const t = Math.floor(now / 1000);
  const b = s => Buffer.from(JSON.stringify(s)).toString('base64url');
  const un = b({ alg: 'RS256', typ: 'JWT' }) + '.' + b({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: t, exp: t + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(un).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + un + '.' + sig });
  const j = await r.json();
  if (!j.access_token) throw new Error('Anmeldung bei Google fehlgeschlagen: ' + JSON.stringify(j).slice(0, 300));
  H = { authorization: 'Bearer ' + j.access_token };
}

// Firestore-Werte umwandeln
const dec = v => {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) { const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = dec(x); return o; }
  return null;
};
const enc = x => x === null || x === undefined ? { nullValue: null }
  : typeof x === 'string' ? { stringValue: x }
  : typeof x === 'boolean' ? { booleanValue: x }
  : typeof x === 'number' ? (Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x })
  : Array.isArray(x) ? { arrayValue: { values: x.map(enc) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, enc(v)])) } };
const docObj = d => Object.assign(dec({ mapValue: { fields: d.fields || {} } }), { id: d.name.split('/').pop() });

async function get(path) {
  const r = await fetch(`${DB}/${path}`, { headers: H });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Lesen ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return docObj(await r.json());
}
async function list(coll) {
  const out = []; let pt = '';
  do {
    const r = await fetch(`${DB}/${coll}?pageSize=300${pt ? '&pageToken=' + encodeURIComponent(pt) : ''}`, { headers: H });
    if (!r.ok) throw new Error(`Liste ${coll}: ${r.status}`);
    const j = await r.json(); (j.documents || []).forEach(d => out.push(docObj(d))); pt = j.nextPageToken || '';
  } while (pt);
  return out;
}
async function newer(coll, field, gt) {
  const r = await fetch(`${DB}:runQuery`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coll }], where: { fieldFilter: { field: { fieldPath: field }, op: 'GREATER_THAN', value: enc(gt) } } } }) });
  if (!r.ok) throw new Error(`Abfrage ${coll}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return (await r.json()).filter(x => x.document).map(x => docObj(x.document));
}
async function put(path, obj) {
  const r = await fetch(`${DB}/${path}`, { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ fields: enc(obj).mapValue.fields }) });
  if (!r.ok) throw new Error(`Schreiben ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
}
async function del(path) { await fetch(`${DB}/${path}`, { method: 'DELETE', headers: H }); }

async function main() {
  await login();
  const st = (await get('pushsrv/state')) || {};
  const sent = st.sent || {}, seen = st.seen || {};
  const jobs = [];
  let changed = false;

  // 1) Erinnerungen und Wecker (die App legt den Plan in settings/pushplan ab)
  const plan = await get('settings/pushplan');
  for (const it of (plan && plan.items) || []) {
    if (!it || !it.k || sent[it.k] || typeof it.at !== 'number') continue;
    if (it.at <= now + LOOKAHEAD && it.at > now - LATE) {
      jobs.push({ to: it.to || [], title: it.t || 'Erinnerung', body: it.b || '', tag: it.k, kind: it.al ? 'alarm' : 'rem' });
      sent[it.k] = it.at; changed = true;
    }
  }

  // 2) Neue Chat-Nachrichten
  if (!st.lastChat) { st.lastChat = now; changed = true; }
  else {
    const cs = (await get('pushsrv/chatseen')) || {}, wseen = cs.seen || {};
    if (Object.keys(wseen).length > 500) { const keep = {}; for (const [k, v] of Object.entries(wseen)) if (v > now - 2 * 86400000) keep[k] = v; await put('pushsrv/chatseen', { seen: keep }); }
    const msgs = (await newer('notes', 'ts', st.lastChat - 2 * 3600000)).filter(m => !seen[m.id] && typeof m.ts === 'number').sort((a, b) => a.ts - b.ts);
    if (msgs.length) {
      const people = (await get('settings/people')) || {};
      const chats = {}; for (const c of await list('chats')) chats[c.id] = c;
      const nm = k => (people[k] && people[k].name) || 'Jemand';
      for (const m of msgs) {
        if (wseen[m.id]) { seen[m.id] = m.ts; st.lastChat = Math.max(st.lastChat, m.ts); changed = true; continue; } // schon sofort per Cloudflare verschickt
        if (now - m.ts < 3 * 60000) continue; // ganz neue Nachrichten erst Cloudflare überlassen
        seen[m.id] = m.ts; st.lastChat = Math.max(st.lastChat, m.ts); changed = true;
        if (m.ts < now - 6 * 3600000) continue;
        const cid = m.chat || 'all', c = chats[cid];
        if (cid !== 'all' && !c) continue;
        jobs.push({ to: cid === 'all' ? [] : (c.members || []), not: m.by || '', title: '💬 ' + nm(m.by) + (cid === 'all' ? '' : ' · ' + (c.name || 'Chat')), body: String(m.text || '').slice(0, 160) || 'Neue Nachricht', tag: 'chat_' + cid, kind: 'chat' });
      }
    }
  }

  // 3) Testnachricht aus der App
  const tst = await get('pushsrv/test');
  if (tst && tst.at > (st.lastTest || 0)) {
    st.lastTest = tst.at; changed = true;
    if (now - tst.at < 3600000 && tst.dev) jobs.push({ only: tst.dev, title: '🔔 Test', body: 'Benachrichtigungen funktionieren.', tag: 'test', kind: 'test' });
  }

  // Verschicken
  if (jobs.length) {
    const devs = (await list('push')).filter(d => d.token);
    for (const j of jobs) {
      const done = new Set();
      for (const d of devs) {
        const hit = j.only ? d.id === j.only : ((!j.to.length || j.to.includes(d.me)) && !(j.not && d.me === j.not));
        if (!hit || done.has(d.token)) continue; done.add(d.token);
        const r = await fetch(`https://fcm.googleapis.com/v1/projects/${P}/messages:send`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ message: { token: d.token, data: { title: j.title, body: j.body, tag: j.tag, kind: j.kind }, webpush: { headers: { Urgency: 'high', TTL: j.kind === 'chat' ? '86400' : '3600' } } } }) });
        if (r.ok) console.log('gesendet:', j.kind, '→', d.me || '?');
        else {
          const tx = await r.text(); console.log('Fehler', r.status, tx.slice(0, 200));
          if (r.status === 404 || /UNREGISTERED|not a valid FCM registration token/i.test(tx)) await del('push/' + d.id);
        }
      }
    }
  } else console.log('Nichts zu schicken.');

  if (changed) {
    for (const k of Object.keys(sent)) if (sent[k] < now - 3 * 86400000) delete sent[k];
    for (const k of Object.keys(seen)) if (seen[k] < now - 86400000) delete seen[k];
    await put('pushsrv/state', { sent, seen, lastChat: st.lastChat, lastTest: st.lastTest || 0, ts: now });
  }
}
main().catch(e => { console.log(String(e && e.stack || e)); note('error', (e && e.message) || e); process.exit(1); });
