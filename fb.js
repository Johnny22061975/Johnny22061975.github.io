// Familien-Planer: Firebase-Anbindung (Anmeldung, Datenbank, KI-Auswertung)
const V = '12.18.0';
const B = 'https://www.gstatic.com/firebasejs/' + V + '/';
function emit(d){ window.FP_LAST = d; window.dispatchEvent(new CustomEvent('fp-auth', { detail: d })); }
function errText(e){
  const c = (e && e.code) || '';
  if (c === 'auth/unauthorized-domain') return 'Diese Internet-Adresse ist in Firebase noch nicht freigegeben (Authentication → Einstellungen → Autorisierte Domains).';
  if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') return 'Anmeldung abgebrochen.';
  if (c === 'auth/network-request-failed') return 'Keine Internetverbindung. Für die erste Anmeldung braucht die App Internet.';
  return 'Anmeldung hat nicht geklappt (' + (c || 'unbekannt') + ').';
}
try {
  const [A, AU, F] = await Promise.all([import(B + 'firebase-app.js'), import(B + 'firebase-auth.js'), import(B + 'firebase-firestore.js')]);
  const app = A.initializeApp(window.FP_CONFIG);
  const auth = AU.getAuth(app); auth.languageCode = 'de';
  let db;
  try { db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) }); }
  catch (e) { db = F.getFirestore(app); }
  const clean = o => JSON.parse(JSON.stringify(o));
  const fire = p => { p.catch(e => window.dispatchEvent(new CustomEvent('fp-err', { detail: String((e && e.code) || e) }))); return Promise.resolve(true); };
  const store = {
    mode: 'db',
    watch(c, cb, onErr) {
      return F.onSnapshot(F.collection(db, c), snap => {
        const rows = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
        const changes = snap.docChanges().map(ch => ({ type: ch.type, row: Object.assign({ id: ch.doc.id }, ch.doc.data() || {}) }));
        cb(rows, changes);
      }, e => { if (e && e.code === 'permission-denied') window.dispatchEvent(new CustomEvent('fp-denied')); else if (onErr) onErr(e); });
    },
    set: (c, id, o) => fire(F.setDoc(F.doc(db, c, id), clean(o))),
    update: (c, id, p) => fire(F.updateDoc(F.doc(db, c, id), clean(p))),
    remove: (c, id) => fire(F.deleteDoc(F.doc(db, c, id))),
    newId: () => F.doc(F.collection(db, 'ids')).id
  };
  // KI-Auswertung (Fotos, Sätze) über Gemini / Firebase AI Logic
  let model = null;
  async function getModel(){
    if (model) return model;
    const M = await import(B + 'firebase-ai.js');
    const ai = M.getAI(app, { backend: new M.GoogleAIBackend() });
    model = M.getGenerativeModel(ai, { model: window.FP_MODEL || 'gemini-2.5-flash', generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } });
    return model;
  }
  const b64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
  const sample = {
    limits: () => Promise.resolve({ images: true }),
    json: async (prompt, opt) => {
      if (!navigator.onLine) throw { code: 'offline' };
      const md = await getModel();
      const parts = [{ text: prompt }];
      for (const bl of ((opt && opt.images) || [])) parts.push({ inlineData: { data: await b64(bl), mimeType: bl.type || 'image/jpeg' } });
      let r;
      try { r = await md.generateContent(parts); }
      catch (e) {
        const s = String((e && e.message) || e);
        throw { code: /429|quota|RESOURCE_EXHAUSTED/i.test(s) ? 'rate_limited' : /not been used|disabled|not enabled|PERMISSION_DENIED|403/i.test(s) ? 'ai_disabled' : 'failed', message: s };
      }
      let t = r.response.text().trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      try { return JSON.parse(t); } catch (e) { throw { code: 'invalid_json' }; }
    }
  };
  // Benachrichtigungen: Gerät bei Firebase Cloud Messaging anmelden
  window.FP_PUSH = {
    ok: () => 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window,
    async token(vapid, ask) {
      if (!vapid) throw { code: 'novapid' };
      if (!window.FP_PUSH.ok()) throw { code: 'unsupported' };
      const perm = ask ? await Notification.requestPermission() : Notification.permission;
      if (perm !== 'granted') throw { code: perm === 'denied' ? 'denied' : 'noperm' };
      const M = await import(B + 'firebase-messaging.js');
      if (!(await M.isSupported())) throw { code: 'unsupported' };
      const reg = await navigator.serviceWorker.register('sw.js');
      await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej({ code: 'swfail', message: 'Hintergrunddienst startet nicht (fehlt eine Datei auf GitHub?)' }), 15000))]);
      try { return await M.getToken(M.getMessaging(app), { vapidKey: vapid.trim(), serviceWorkerRegistration: reg }); }
      catch (e) { throw { code: 'token', message: String((e && e.message) || e) }; }
    },
    async off() { try { const M = await import(B + 'firebase-messaging.js'); await M.deleteToken(M.getMessaging(app)); } catch (e) {} }
  };
  window.FP_signIn = async () => {
    const p = new AU.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
    try { await AU.signInWithPopup(auth, p); }
    catch (e) {
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) { try { await AU.signInWithRedirect(auth, p); } catch (e2) { emit({ state: 'error', msg: errText(e2) }); } }
      else emit({ state: 'error', msg: errText(e) });
    }
  };
  window.FP_signOut = () => AU.signOut(auth).then(() => location.reload());
  AU.getRedirectResult(auth).catch(e => emit({ state: 'error', msg: errText(e) }));
  AU.onAuthStateChanged(auth, u => {
    if (u) emit({ state: 'in', user: { uid: u.uid, email: u.email || '', name: u.displayName || '' }, store, sample });
    else emit({ state: 'out' });
  });
} catch (e) {
  emit({ state: 'error', msg: navigator.onLine ? 'Die App konnte nicht starten (' + String((e && e.message) || e).slice(0, 120) + ').' : 'Keine Internetverbindung. Beim allerersten Start braucht die App einmal Internet.' });
}
