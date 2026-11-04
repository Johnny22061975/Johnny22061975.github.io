// Familien-Planer: schickt Chat-Nachrichten und Zettel-Meldungen sofort als Benachrichtigung (Cloudflare Worker)
const ORIGIN = 'https://johnny22061975.github.io';
let T = null;
const enc = new TextEncoder();
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function token(sa) {
  if (T && T.exp > Date.now() + 60000) return T.t;
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const un = b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))) + '.' + b64u(enc.encode(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })));
  const sig = b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(un)));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + un + '.' + sig });
  const j = await r.json();
  if (!j.access_token) throw new Error('Google-Anmeldung: ' + JSON.stringify(j).slice(0, 200));
  T = { t: j.access_token, exp: Date.now() + 3300000 };
  return T.t;
}
const dec = v => !v ? null : 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec) : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : null;
const obj = d => Object.assign(dec({ mapValue: { fields: d.fields || {} } }), { id: d.name.split('/').pop() });

let SELF = '';
async function tools(env) {
  const sa = JSON.parse(env.FIREBASE_SA);
  const DB = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
  const H = { authorization: 'Bearer ' + await token(sa) };
  const get = async p => { const r = await fetch(`${DB}/${p}`, { headers: H }); if (r.status === 404) return null; if (!r.ok) throw new Error('Lesen ' + p + ': ' + r.status); return obj(await r.json()); };
  const list = async c => { const r = await fetch(`${DB}/${c}?pageSize=300`, { headers: H }); if (!r.ok) throw new Error('Liste ' + c + ': ' + r.status); return ((await r.json()).documents || []).map(obj); };
  const mark = (doc, field, key, val) => fetch(`${DB}/${doc}?updateMask.fieldPaths=${encodeURIComponent(field + '.`' + key + '`')}`, { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ fields: { [field]: { mapValue: { fields: { [key]: { integerValue: String(val) } } } } } }) });
  const send = async (filter, data, ttl, perDev) => {
    const done = new Set(); let n = 0;
    for (const d of await list('push')) {
      if (!d.token || done.has(d.token) || !filter(d)) continue;
      done.add(d.token);
      const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ message: { token: d.token, data: perDev ? Object.assign({}, data, perDev(d)) : data, webpush: { headers: { Urgency: 'high', TTL: ttl } } } }) });
      if (r.ok) n++;
      else if (r.status === 404) await fetch(`${DB}/push/${d.id}`, { method: 'DELETE', headers: H });
    }
    return n;
  };
  const setRcv = async (k, ts) => { const cur = await get('settings/rcpt_' + k); if (cur && (cur.rcv || 0) >= ts) return 'schon'; await fetch(`${DB}/settings/rcpt_${k}?updateMask.fieldPaths=rcv&updateMask.fieldPaths=ack`, { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ fields: { rcv: { integerValue: String(ts) }, ack: { integerValue: '1' } } }) }); return 'ok'; };
  return { get, mark, send, setRcv };
}

// Chat-Nachricht (notes/<id>)
async function run(env, id) {
  const { get, mark, send } = await tools(env);
  const seenDoc = await get('pushsrv/chatseen');
  if (seenDoc && seenDoc.seen && seenDoc.seen[id]) return 'schon verschickt';
  let m = null;
  for (const w of [0, 1500, 3000, 5000]) { if (w) await new Promise(r => setTimeout(r, w)); m = await get('notes/' + id); if (m) break; }
  if (!m || typeof m.ts !== 'number' || Date.now() - m.ts > 3600000) return 'keine neue Nachricht';
  // sofort als erledigt markieren (verhindert doppelte Meldungen)
  await mark('pushsrv/chatseen', 'seen', id, m.ts);
  const cid = m.chat || 'all';
  const c = cid === 'all' ? null : await get('chats/' + cid);
  if (cid !== 'all' && !c) return 'Chat fehlt';
  const people = (await get('settings/people')) || {};
  const nm = k => (people[k] && people[k].name) || 'Jemand';
  const to = cid === 'all' ? [] : (c.members || []);
  const title = '💬 ' + nm(m.by) + (cid === 'all' ? '' : ' · ' + (c.name || 'Chat'));
  const body = String(m.text || '').slice(0, 160) || 'Neue Nachricht';
  const n = await send(d => !(m.by && d.me === m.by) && !(to.length && !to.includes(d.me)), { title, body, tag: 'chat_' + cid, kind: 'chat', mid: id, ack: SELF }, '86400', d => ({ me: String(d.me || '') }));
  return 'gesendet: ' + n;
}

// Empfangsbestätigung vom Handy (Service Worker)
async function runAck(env, mid, me) {
  const { get, setRcv } = await tools(env);
  const m = await get('notes/' + mid);
  if (!m || typeof m.ts !== 'number') return 'Nachricht fehlt';
  return 'Empfang ' + me + ': ' + await setRcv(me, m.ts);
}

// Notiz-Zettel (citems/<id>): an die ausgewählten Personen, höchstens einmal pro halbe Stunde
async function runNote(env, id) {
  const { get, mark, send } = await tools(env);
  const x = await get('citems/' + id);
  if (!x || (x.kind !== 'topic' && x.kind !== 'note') || typeof x.ts !== 'number' || Date.now() - x.ts > 3600000) return 'kein neuer Zettel';
  const notify = Array.isArray(x.notify) ? x.notify : [], vis = Array.isArray(x.vis) ? x.vis : [];
  const to = notify.filter(k => k !== x.by && (!vis.length || x.owner === k || vis.includes(k)));
  if (!to.length) return 'niemand zu benachrichtigen';
  const key = 'nt_' + id + '_' + Math.floor(x.ts / 1800000); // gleicher Schlüssel wie im GitHub-Ablauf, damit nichts doppelt kommt
  const st = await get('pushsrv/state');
  if (st && st.sent && st.sent[key]) return 'schon verschickt';
  await mark('pushsrv/state', 'sent', key, x.ts);
  const people = (await get('settings/people')) || {};
  const nm = k => (people[k] && people[k].name) || 'Jemand';
  const title = ('📝 ' + (x.title || (x.kind === 'note' ? 'Notiz' : 'Zettel'))).slice(0, 80);
  const body = nm(x.by) + ' hat etwas eingetragen';
  const n = await send(d => to.includes(d.me), { title, body, tag: key, kind: 'rem' }, '3600');
  return 'Zettel gesendet: ' + n;
}


// RMV-Abfahrten (Schlüssel liegt nur als Geheimnis RMV_KEY im Helfer, nie in der App)
const RMV = 'https://www.rmv.de/hapi/';
async function rmvGet(env, path, q) {
  const u = new URL(RMV + path);
  u.searchParams.set('accessId', env.RMV_KEY);
  u.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
  const r = await fetch(u.toString(), { headers: { accept: 'application/json' } });
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok || !j || j.errorCode) return { err: (j && j.errorCode) || ('http ' + r.status) }; // errorText nie weitergeben, er kann den Schlüssel enthalten
  return { j };
}
async function rmvStops(env, q) {
  const { j, err } = await rmvGet(env, 'location.name', { input: q, type: 'S', maxNo: 5 });
  if (err) return { err };
  const stops = (j.stopLocationOrCoordLocation || []).map(x => x.StopLocation).filter(Boolean).map(s => ({ id: String(s.extId || ''), name: String(s.name || '') })).filter(s => s.id);
  return { stops };
}
async function rmvDeps(env, id, line) {
  const { j, err } = await rmvGet(env, 'departureBoard', { id, duration: 180, maxJourneys: 60 });
  if (err) return { err };
  const want = String(line || '').toUpperCase().replace(/\s+/g, ''), num = want.replace(/^AST/, ''), ast = /^AST/.test(want);
  const deps = (j.Departure || []).map(d => {
    const p = (Array.isArray(d.Product) ? d.Product[0] : d.Product) || {};
    return { line: String(p.line || p.displayNumber || ''), cat: String(p.catOut || '').trim(), name: String(d.name || '').trim(), dir: String(d.direction || ''), t: String(d.time || '').slice(0, 5), d: String(d.date || ''), rt: d.rtTime ? String(d.rtTime).slice(0, 5) : '', rd: d.rtDate ? String(d.rtDate) : '', x: d.cancelled === true || d.cancelled === 'true' };
  }).filter(d => !num || (d.line.toUpperCase() === num && ((d.cat.toUpperCase() === 'AST') === ast))).slice(0, 8);
  return { deps };
}

export default {
  async fetch(req, env, ctx) {
    const cors = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method === 'GET') return new Response(env.FIREBASE_SA ? 'Familien-Planer ok (Version 3 mit Empfang und RMV' + (env.RMV_KEY ? '' : ', RMV_KEY fehlt') + ')' : 'Familien-Planer: Secret FIREBASE_SA fehlt', { headers: cors });
    SELF = new URL(req.url).origin;
    let id = '', nt = '', ack = '', me = '', b = {};
    try { b = await req.json() || {}; id = String(b.id || ''); nt = String(b.nt || ''); ack = String(b.ack || ''); me = String(b.me || ''); } catch (e) {}
    const js = o => new Response(JSON.stringify(o), { headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    if (b.rmvq !== undefined || b.rmv !== undefined) {
      if (!env.RMV_KEY) return js({ err: 'nokey' });
      try {
        if (b.rmvq !== undefined) { const q = String(b.rmvq || '').trim().slice(0, 80); if (q.length < 3) return js({ err: 'kurz' }); return js(await rmvStops(env, q)); }
        const sid = String(b.rmv || ''); if (!/^\d{5,9}$/.test(sid)) return js({ err: 'id' });
        const ln = String(b.line || '').trim().slice(0, 10); if (ln && !/^[0-9A-Za-z ]{1,10}$/.test(ln)) return js({ err: 'linie' });
        return js(await rmvDeps(env, sid, ln));
      } catch (e) { return js({ err: 'netz' }); }
    }
    const ok = s => /^[A-Za-z0-9_-]{4,40}$/.test(s);
    if (ack && ok(ack) && /^[a-z0-9]{1,14}$/.test(me)) { ctx.waitUntil(runAck(env, ack, me).then(t => console.log(t), e => console.log('Fehler', String(e && e.message || e)))); return new Response('ok', { headers: cors }); }
    if (nt && ok(nt)) { ctx.waitUntil(runNote(env, nt).then(t => console.log(t), e => console.log('Fehler', String(e && e.message || e)))); return new Response('ok', { headers: cors }); }
    if (!ok(id)) return new Response('ungültig', { status: 400, headers: cors });
    ctx.waitUntil(run(env, id).then(t => console.log(t), e => console.log('Fehler', String(e && e.message || e))));
    return new Response('ok', { headers: cors });
  }
};
