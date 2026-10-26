/* Ledger Desk vault: each person's books are locked (encrypted) in their own browser before they go to the server.
   The server only ever stores locked files. The key comes from the person's password (and a recovery code),
   so the server PC's owner can't open anyone's books from the files. AES-256-GCM, PBKDF2-SHA256. */
(function (root) {
  'use strict';
  const subtle = crypto.subtle, te = new TextEncoder(), td = new TextDecoder();
  const PW_ITER = 600000, REC_ITER = 200000, AUTH_ITER = 200000;
  const b64 = buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const rand = n => crypto.getRandomValues(new Uint8Array(n));

  async function pbkdf2(secret, salt, iter, usage) {
    const base = await subtle.importKey('raw', te.encode(secret), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
    if (usage === 'bits') return subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, 256);
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  }
  // What the browser sends to sign in. The server never gets the password itself.
  async function authFor(username, password) {
    return b64(await pbkdf2(password, te.encode('ledgerdesk-auth|' + String(username).trim().toLowerCase()), AUTH_ITER, 'bits'));
  }
  // Lets the server check a recovery code without being able to learn it or unlock anything with it.
  async function recAuthFor(username, code) {
    return b64(await pbkdf2(normRec(code), te.encode('ledgerdesk-rec|' + String(username).trim().toLowerCase()), AUTH_ITER, 'bits'));
  }
  async function wrapWith(dek, secret, iter) {
    const salt = rand(16), iv = rand(12);
    const kek = await pbkdf2(secret, salt, iter);
    const ct = await subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv });
    return { salt: b64(salt), iter, iv: b64(iv), ct: b64(ct) };
  }
  async function unwrapWith(w, secret) {
    const kek = await pbkdf2(secret, unb64(w.salt), w.iter);
    try { return await subtle.unwrapKey('raw', unb64(w.ct), kek, { name: 'AES-GCM', iv: unb64(w.iv) }, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']); }
    catch (e) { throw new Error('wrong'); }
  }
  function normRec(s) { return String(s || '').toUpperCase().replace(/[^A-Z2-9]/g, ''); }
  function newRecoveryCode() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', r = rand(25); let s = '';
    r.forEach((v, i) => { s += abc[v & 31]; if (i % 5 === 4 && i < 24) s += '-'; });
    return s; // 125 random bits
  }
  async function newVault(password) {
    const dek = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const recovery = newRecoveryCode();
    return { dek, recovery, vault: { pw: await wrapWith(dek, password, PW_ITER), rec: await wrapWith(dek, normRec(recovery), REC_ITER) } };
  }
  const unlockWithPassword = (vault, password) => unwrapWith(vault.pw, password);
  const unlockWithRecovery = (vault, code) => unwrapWith(vault.rec, normRec(code));
  const passwordWrap = (dek, password) => wrapWith(dek, password, PW_ITER);
  async function newRecovery(dek) { const recovery = newRecoveryCode(); return { recovery, rec: await wrapWith(dek, normRec(recovery), REC_ITER) }; }
  // Ways to keep a copy of the recovery code. They open the person's own email; the server never sees the code.
  function recoveryMail(username, code) {
    const subject = 'My Ledger Desk recovery code (' + username + ')';
    const body = 'Ledger Desk recovery code for user name: ' + username + '\n\n' + code + '\n\nKeep this email. If I forget my Ledger Desk password, I use this code on the sign-in page (Forgot your password?) to unlock my books. Nobody else can unlock them.\n';
    return { mailto: 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body), gmail: 'https://mail.google.com/mail/?view=cm&fs=1&su=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body), outlook: 'https://outlook.live.com/mail/0/deeplink/compose?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body) };
  }

  // Keep the key for this browser tab only. Closing the tab locks the books again.
  async function keepKey(username, dek) { try { sessionStorage.setItem('ld-key:' + username, b64(await subtle.exportKey('raw', dek))); } catch (e) {} }
  async function keptKey(username) {
    let raw = null; try { raw = sessionStorage.getItem('ld-key:' + username); } catch (e) {}
    return raw ? subtle.importKey('raw', unb64(raw), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) : null;
  }
  function forgetKeys() { try { Object.keys(sessionStorage).filter(k => k.indexOf('ld-key:') === 0).forEach(k => sessionStorage.removeItem(k)); } catch (e) {} }

  async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }
  async function seal(dek, bytes) { const iv = rand(12); return { iv: b64(iv), ct: b64(await subtle.encrypt({ name: 'AES-GCM', iv }, dek, bytes)) }; }
  async function open(dek, box) {
    try { return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, dek, unb64(box.ct))); }
    catch (e) { throw new Error('These books can\'t be unlocked with your key.'); }
  }
  // A company file on the server: { ld: "enc1", hdr: <locked name + account ids>, body: <locked, compressed books> }
  async function sealBooks(dek, jsonText) {
    let hdr = { name: 'Company', ofxIds: [] };
    try { const d = JSON.parse(jsonText); hdr = { name: d.company || 'Company', ofxIds: (d.accounts || []).filter(a => a.ofxId).map(a => String(a.ofxId)) }; } catch (e) {}
    const z = await pipe(te.encode(jsonText), new CompressionStream('gzip'));
    return JSON.stringify({ ld: 'enc1', hdr: await seal(dek, te.encode(JSON.stringify(hdr))), body: await seal(dek, z) });
  }
  async function openBooks(dek, envText) {
    const env = JSON.parse(envText);
    if (!env || env.ld !== 'enc1') throw new Error('Not a locked Ledger Desk file');
    return td.decode(await pipe(await open(dek, env.body), new DecompressionStream('gzip')));
  }
  async function openHeader(dek, hdr) { return JSON.parse(td.decode(await open(dek, hdr))); }
  const newCompanyFile = () => 'c-' + Array.from(rand(8), b => b.toString(16).padStart(2, '0')).join('') + '.json';
  const passwordProblem = pw => (String(pw || '').length < 10 ? 'Use at least 10 characters for the password.' : '');

  // ----- sharing: each company has its own key; each person has a key pair so others can lock a company key for them -----
  const RSA = { name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  async function newPersonKeys(dek) {
    const kp = await subtle.generateKey(RSA, true, ['wrapKey', 'unwrapKey']);
    return { pub: b64(await subtle.exportKey('spki', kp.publicKey)), priv: await seal(dek, new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey))) };
  }
  async function openPrivate(dek, priv) { return subtle.importKey('pkcs8', await open(dek, priv), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['unwrapKey']); }
  const importPublic = pub => subtle.importKey('spki', unb64(pub), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey']);
  const newCompanyKey = () => subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  async function lockCompanyKeyFor(pubKey, ck) { return b64(await subtle.wrapKey('raw', ck, typeof pubKey === 'string' ? await importPublic(pubKey) : pubKey, { name: 'RSA-OAEP' })); }
  async function unlockCompanyKey(privKey, wrapped) {
    try { return await subtle.unwrapKey('raw', unb64(wrapped), privKey, { name: 'RSA-OAEP' }, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']); }
    catch (e) { throw new Error('This company\'s key can\'t be unlocked with your key.'); }
  }
  root.LDVault = { newPersonKeys, openPrivate, importPublic, newCompanyKey, lockCompanyKeyFor, unlockCompanyKey, authFor, recAuthFor, newRecovery, recoveryMail, newVault, unlockWithPassword, unlockWithRecovery, passwordWrap, keepKey, keptKey, forgetKeys, sealBooks, openBooks, openHeader, newCompanyFile, passwordProblem };
})(window);
