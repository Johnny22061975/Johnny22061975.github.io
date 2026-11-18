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
  // App Check (seit 2.11.2026 von Firebase für die KI-Auswertung verlangt).
  // Der reCAPTCHA-Websiteschlüssel ist öffentlich und darf hier stehen.
  const APPCHECK_KEY = window.FP_APPCHECK_KEY || '6LfwKBIuAAAAAGWmdQq4aSyzF33HiEIJ2AYZk0SU'; // Fraud Defense (reCAPTCHA Enterprise), Projekt familien-planner
  const APPCHECK_TYPE = window.FP_APPCHECK_TYPE || 'enterprise'; // 'enterprise' (Fraud Defense) oder 'v3'
  // In der Android-App antwortet reCAPTCHA nicht und blockiert jede KI-Anfrage: dort ohne App Check.
  // Lösung: Die Android-App liefert einen bei Firebase hinterlegten Debug-Token (GitHub-Secret FP_AC_DEBUG).
  const NATIVE = !!window.FPNative;
  let AC_DBG = '';
  try { AC_DBG = (NATIVE && window.FPNative.acDebug) ? String(window.FPNative.acDebug() || '') : ''; } catch (e) {}
  if (AC_DBG) self.FIREBASE_APPCHECK_DEBUG_TOKEN = AC_DBG;
  const AC_ON = APPCHECK_KEY && (!NATIVE || AC_DBG);
  let acReady = null, acInfo = !AC_ON ? (NATIVE ? 'in der Android-App ohne Token (alte App oder Secret FP_AC_DEBUG fehlt)' : 'aus') : AC_DBG ? 'startet (Android-Token)' : 'startet';
  let aiStep = 'noch nicht gestartet';
  window.FP_AISTEP = () => aiStep + ' · Prüfung: ' + acInfo;
  if (AC_ON) acReady = import(B + 'firebase-app-check.js').then(AC => AC.initializeAppCheck(app, {
    provider: APPCHECK_TYPE === 'enterprise' ? new AC.ReCaptchaEnterpriseProvider(APPCHECK_KEY) : new AC.ReCaptchaV3Provider(APPCHECK_KEY),
    isTokenAutoRefreshEnabled: true
  })).then(ac => import(B + 'firebase-app-check.js').then(AC => AC.getToken(ac)).then(() => { acInfo = 'ok'; return ac; }, e => { acInfo = 'Token-Fehler: ' + String((e && e.message) || e).slice(0, 140); return ac; }))
    .catch(e => { acInfo = 'Start-Fehler: ' + String((e && e.message) || e).slice(0, 140); console.warn('App Check', e); return null; });
  window.FP_APPCHECK_INFO = () => acInfo;
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
  // Immer zuerst das beste Modell. Weiter zum nächsten nur, wenn es das Modell nicht gibt
  // oder sein Tageslimit (kostenloser Tarif) voll ist. Bei langsamer Antwort NICHT weiter (jede Anfrage zählt).
  const MODELS = [window.FP_MODEL, 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.6-flash', 'gemini-3.8-flash-lite', 'gemini-flash-lite-latest'].filter((x, i, a) => x && a.indexOf(x) === i);
  const AI_WAIT = 80000;
  let aiM = null, ai = null; const models = {};
  async function getModel(name){
    if (!aiM) { aiStep = 'wartet auf Prüfung'; if (acReady) await Promise.race([acReady, new Promise(res => setTimeout(() => { if (/^startet/.test(acInfo)) acInfo = 'Zeitüberschreitung (reCAPTCHA antwortet nicht)'; res(null); }, 8000))]); aiStep = 'lädt KI-Modul'; aiM = await import(B + 'firebase-ai.js'); ai = aiM.getAI(app, { backend: new aiM.GoogleAIBackend() }); }
    return models[name] || (models[name] = aiM.getGenerativeModel(ai, { model: name, generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }));
  }
  const b64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
  const sample = {
    limits: () => Promise.resolve({ images: true }),
    json: async (prompt, opt) => {
      aiStep = 'startet'; if (!navigator.onLine) throw { code: 'offline' };
      aiStep = 'wandelt Foto um';
      const parts = [{ text: prompt }];
      let kb = 0;
      for (const bl of ((opt && opt.images) || [])) { const d = await b64(bl); kb += Math.round(d.length * 0.75 / 1024); parts.push({ inlineData: { data: d, mimeType: bl.type || 'image/jpeg' } }); }
      let r = null, last = '', quota = false;
      for (const name of MODELS) {
        try {
          const m = await getModel(name); aiStep = 'wartet auf KI-Antwort (' + name + (kb ? ', Foto ' + kb + ' KB' : '') + ')';
          r = await Promise.race([m.generateContent(parts), new Promise((_, rej) => setTimeout(() => rej(new Error('FP_SLOW')), AI_WAIT))]);
          aiStep = 'Antwort da (' + name + ')'; try { localStorage.setItem('fp2_aimodel', name); } catch (x) {} break;
        } catch (e) {
          const s = String((e && e.message) || e); last = s;
          if (s === 'FP_SLOW') throw { code: 'timeout', message: 'Die KI (' + name + ') hat in ' + (AI_WAIT / 1000) + ' Sekunden nicht geantwortet. Bitte gleich noch einmal versuchen' };
          if (/\b429\b|quota|RESOURCE_EXHAUSTED/i.test(s)) { quota = true; continue; } // Tageslimit dieses Modells voll: nächstes Modell
          if (/\b404\b|\b50[0-4]\b|not found|not supported|is not available|no longer|retired|deprecated|high demand|overloaded|UNAVAILABLE|try again later|Interactions API/i.test(s)) continue; // Modell gibt es nicht (mehr) oder überlastet
          if (/app ?check/i.test(s)) throw { code: 'failed', message: 'App Check (' + (NATIVE ? (AC_DBG ? 'Android-Token' : 'Android') : APPCHECK_TYPE) + ', ' + acInfo + '): ' + name + ': ' + s.slice(-120) };
          throw { code: /not been used|disabled|not enabled|PERMISSION_DENIED|403/i.test(s) ? 'ai_disabled' : 'failed', message: name + ': ' + s.slice(-160) };
        }
      }
      if (!r && quota) throw { code: 'rate_limited', message: 'Das kostenlose Tageslimit der KI ist erreicht. Ab etwa 9 Uhr morgens geht es wieder, bis dahin bitte den Betrag selbst eintragen' };
      if (!r) throw { code: 'failed', message: 'Kein Modell erreichbar: ' + last.slice(-160) };
      let t = r.response.text().trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      try { return JSON.parse(t); } catch (e) { const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a > -1 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (x) {} } throw { code: 'invalid_json', message: t.slice(0, 120) }; }
    }
  };
  // Test ohne Foto: zeigt, ob die KI in dieser Umgebung überhaupt antwortet
  window.FP_AIPING = async () => {
    const name = (() => { try { return localStorage.getItem('fp2_aimodel'); } catch (e) { return null; } })() || 'gemini-3.8-flash';
    const t0 = Date.now(), sec = () => ((Date.now() - t0) / 1000).toFixed(1) + ' s';
    try {
      const m = await getModel(name);
      const r = await Promise.race([m.generateContent([{ text: 'Antworte nur mit {"ok":1}' }]), new Promise((_, rej) => setTimeout(() => rej(new Error('keine Antwort in 20 s')), 20000))]);
      return 'Text-Test (' + name + '): ok in ' + sec() + ', Antwort ' + String(r.response.text()).slice(0, 20);
    } catch (e) { return 'Text-Test (' + name + '): Fehler nach ' + sec() + ': ' + String((e && e.message) || e).slice(-120); }
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
  // Android-App: echte Android-Benachrichtigungen statt Browser-Push (der in der App nicht geht)
  if (NATIVE && window.FPNative.pushStart) {
    window.FP_PUSH = {
      native: true,
      ok: () => true,
      perm: () => { try { return String(window.FPNative.notifPerm()); } catch (e) { return 'default'; } },
      token: (vapid, ask) => new Promise((res, rej) => {
        const to = setTimeout(() => rej({ code: 'token', message: 'Das Handy hat keine Kennung geliefert' }), 25000);
        window.fpNativePush = (tk, perm) => { clearTimeout(to); if (tk) res(tk); else rej({ code: perm === 'denied' ? 'denied' : 'noperm' }); };
        window.FPNative.pushStart(!!ask);
      }),
      async off() { try { window.FPNative.pushOff(); } catch (e) {} }
    };
  }
  window.FP_signIn = async () => {
    const p = new AU.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
    try { await AU.signInWithPopup(auth, p); }
    catch (e) {
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) { try { await AU.signInWithRedirect(auth, p); } catch (e2) { emit({ state: 'error', msg: errText(e2) }); } }
      else emit({ state: 'error', msg: errText(e) });
    }
  };
  // Für den Standort-Dienst der Android-App: damit er auch bei geschlossener App senden darf
  window.FP_LOCAUTH = () => { const u = auth.currentUser, c = window.FP_CONFIG || {}; return u ? { apiKey: c.apiKey, projectId: c.projectId, appId: c.appId, refreshToken: u.refreshToken, uid: u.uid } : null; };
  window.FP_signOut = () => AU.signOut(auth).then(() => location.reload());
  AU.getRedirectResult(auth).catch(e => emit({ state: 'error', msg: errText(e) }));
  AU.onAuthStateChanged(auth, u => {
    if (u) emit({ state: 'in', user: { uid: u.uid, email: u.email || '', name: u.displayName || '' }, store, sample });
    else emit({ state: 'out' });
  });
} catch (e) {
  emit({ state: 'error', msg: navigator.onLine ? 'Die App konnte nicht starten (' + String((e && e.message) || e).slice(0, 120) + ').' : 'Keine Internetverbindung. Beim allerersten Start braucht die App einmal Internet.' });
}
