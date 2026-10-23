// Lecture de l'état des imprimantes 3D du réseau local, pour l'application Windows.
//
// Deux familles sont prises en charge :
//   - « bambu »     : Bambu Lab en mode réseau local (MQTT sécurisé, port 8883, code d'accès de l'imprimante)
//   - « moonraker » : imprimantes sous Klipper avec l'API Moonraker (Creality K1, Elegoo Neptune 4, etc.)
//
// Toutes les lectures sont en lecture seule : ce module n'envoie aucune commande d'impression.
// État normalisé : { state, progress, remaining_min, file_name, nozzle_c, bed_c, layer, total_layers }
// state : idle | printing | paused | finished | error | offline

const mqtt = require('mqtt');
const os = require('os');
const dgram = require('dgram');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// Message lisible pour une erreur réseau (Node cache la cause réelle dans « cause »)
function friendly(e) {
  const code = String((e && e.cause && (e.cause.code || e.cause.message)) || (e && e.code) || '');
  const m = String(e && e.message ? e.message : e);
  const all = `${code} ${m} ${e && e.name}`;
  if (/ECONNREFUSED/i.test(all)) return 'Connexion refusée (mauvais port ?).';
  if (/ENOTFOUND|EAI_AGAIN/i.test(all)) return 'Adresse introuvable : vérifie l’adresse IP.';
  if (/abort|timeout|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(all)) return 'Pas de réponse : l’adresse est-elle bonne, et l’imprimante est-elle allumée sur le même réseau ?';
  return m;
}

/* ---------------- Moonraker (Klipper) ---------------- */

function normalizeMoonraker(json) {
  const st = (json && json.result && json.result.status) || {};
  const ps = st.print_stats || {};
  const ds = st.display_status || {};
  const vs = st.virtual_sdcard || {};
  const map = { printing: 'printing', paused: 'paused', complete: 'finished', cancelled: 'error', error: 'error', standby: 'idle' };
  const state = map[ps.state] || 'idle';
  let fraction = num(ds.progress);
  if (!fraction) fraction = num(vs.progress);
  const progress = fraction == null ? null : round1(fraction * 100);
  let remaining = null;
  const dur = num(ps.print_duration);
  if (state === 'printing' && fraction && fraction > 0.005 && dur) remaining = Math.max(0, Math.round((dur / fraction - dur) / 60));
  const info = ps.info || {};
  return {
    state,
    progress: state === 'finished' ? 100 : progress,
    remaining_min: state === 'finished' ? 0 : remaining,
    file_name: ps.filename || null,
    nozzle_c: round1(num(st.extruder && st.extruder.temperature)),
    bed_c: round1(num(st.heater_bed && st.heater_bed.temperature)),
    layer: num(info.current_layer),
    total_layers: num(info.total_layer)
  };
}

async function fetchMoonraker(cfg, timeoutMs = 4000) {
  const port = cfg.port || 7125;
  const url = `http://${cfg.host}:${port}/printer/objects/query?print_stats&virtual_sdcard&display_status&extruder&heater_bed`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`L’imprimante a répondu ${res.status}`);
  return normalizeMoonraker(await res.json());
}

/* ---------------- Bambu Lab (réseau local, MQTT) ---------------- */

function normalizeBambu(p) {
  const map = { RUNNING: 'printing', PREPARE: 'printing', PAUSE: 'paused', FINISH: 'finished', FAILED: 'error', IDLE: 'idle', INIT: 'idle', SLICING: 'idle' };
  const state = map[String(p.gcode_state || '').toUpperCase()] || 'idle';
  return {
    state,
    progress: state === 'finished' ? 100 : round1(num(p.mc_percent)),
    remaining_min: state === 'finished' ? 0 : num(p.mc_remaining_time),
    file_name: p.subtask_name || p.gcode_file || null,
    nozzle_c: round1(num(p.nozzle_temper)),
    bed_c: round1(num(p.bed_temper)),
    layer: num(p.layer_num),
    total_layers: num(p.total_layer_num)
  };
}

class BambuClient {
  constructor(cfg, onStatus, onError) {
    this.cfg = cfg;
    this.onStatus = onStatus;
    this.onError = onError;
    this.print = {};
    this.client = null;
    this.timer = null;
  }

  connect() {
    const { host, serial, code } = this.cfg;
    const port = this.cfg.port || 8883;
    const secure = this.cfg.secure !== false;
    this.client = mqtt.connect(`${secure ? 'mqtts' : 'mqtt'}://${host}:${port}`, {
      username: 'bblp',
      password: code,
      rejectUnauthorized: false, // l'imprimante utilise un certificat auto-signé
      clientId: `dayan3d-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 5000,
      connectTimeout: 8000
    });
    const requestAll = () => {
      if (this.client && this.client.connected) {
        this.client.publish(`device/${serial}/request`, JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } }));
      }
    };
    this.client.on('connect', () => {
      this.client.subscribe(`device/${serial}/report`, (err) => { if (err && this.onError) this.onError(err); else requestAll(); });
      clearInterval(this.timer);
      this.timer = setInterval(requestAll, 60000); // l'imprimante n'envoie que des changements : on redemande tout chaque minute
    });
    this.client.on('message', (_topic, payload) => {
      let json;
      try { json = JSON.parse(payload.toString()); } catch (e) { return; }
      if (json && json.print && typeof json.print === 'object') {
        Object.assign(this.print, json.print);
        this.onStatus(normalizeBambu(this.print));
      }
    });
    this.client.on('error', (err) => { if (this.onError) this.onError(err); });
    this.client.on('close', () => { if (this.onError) this.onError(new Error('Connexion perdue')); });
  }

  close() {
    clearInterval(this.timer);
    if (this.client) this.client.end(true);
    this.client = null;
  }
}

/* ---------------- Relais : toutes les imprimantes configurées ---------------- */

class Relay {
  // onStatus(machine_id, status) ; status.state === 'offline' avec status.error quand l'imprimante ne répond pas
  constructor(onStatus, intervalMs = 10000) {
    this.onStatus = onStatus;
    this.intervalMs = intervalMs;
    this.workers = [];
  }

  configure(list) {
    this.stop();
    (list || []).forEach((cfg) => {
      if (!cfg || !cfg.machine_id || !cfg.host || !cfg.type) return;
      if (cfg.type === 'moonraker') this.startMoonraker(cfg);
      else if (cfg.type === 'bambu' && cfg.serial && cfg.code) this.startBambu(cfg);
    });
  }

  startMoonraker(cfg) {
    let fails = 0;
    const tick = async () => {
      try {
        const st = await fetchMoonraker(cfg);
        fails = 0;
        this.onStatus(cfg.machine_id, st);
      } catch (e) {
        fails += 1;
        if (fails >= 3) this.onStatus(cfg.machine_id, { state: 'offline', error: friendly(e) });
      }
    };
    tick();
    const timer = setInterval(tick, this.intervalMs);
    this.workers.push({ stop: () => clearInterval(timer) });
  }

  startBambu(cfg) {
    let lastOk = Date.now();
    const c = new BambuClient(cfg, (st) => { lastOk = Date.now(); this.onStatus(cfg.machine_id, st); }, () => {});
    c.connect();
    const watch = setInterval(() => {
      if (Date.now() - lastOk > 120000) this.onStatus(cfg.machine_id, { state: 'offline', error: 'Aucune réponse de l’imprimante' });
    }, 30000);
    this.workers.push({ stop: () => { clearInterval(watch); c.close(); } });
  }

  stop() {
    this.workers.forEach((w) => w.stop());
    this.workers = [];
  }
}

// Essai ponctuel pour le bouton « Tester » des réglages.
async function testPrinter(cfg, timeoutMs = 9000) {
  try {
    if (!cfg || !cfg.host) return { ok: false, error: 'Indique l’adresse IP de l’imprimante.' };
    if (cfg.type === 'moonraker') return { ok: true, status: await fetchMoonraker(cfg, 5000) };
    if (cfg.type === 'bambu') {
      if (!cfg.serial || !cfg.code) return { ok: false, error: 'Indique le numéro de série et le code d’accès de l’imprimante.' };
      return await new Promise((resolve) => {
        let done = false;
        const finish = (r) => { if (done) return; done = true; clearTimeout(t); c.close(); resolve(r); };
        const c = new BambuClient(cfg, (st) => finish({ ok: true, status: st }), (err) => {
          const msg = String(err && err.message ? err.message : err);
          if (/not authorized|bad user|identifier rejected/i.test(msg)) finish({ ok: false, error: 'Code d’accès refusé par l’imprimante.' });
        });
        const t = setTimeout(() => finish({ ok: false, error: 'Aucune réponse : vérifie l’adresse, le mode « réseau local » de l’imprimante et le code d’accès.' }), timeoutMs);
        c.connect();
      });
    }
    return { ok: false, error: 'Choisis le type d’imprimante.' };
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
}


/* ---------------- Recherche des imprimantes sur le réseau (Wi-Fi ou câble) ---------------- */

const BAMBU_MODELS = {
  'BL-P001': 'X1 Carbon', 'BL-P002': 'X1', 'C11': 'P1P', 'C12': 'P1S', 'N1': 'A1 mini', 'N2S': 'A1',
  'O1D': 'H2D', 'O1S': 'H2S', 'O1C': 'H2C'
};

// Lit une annonce SSDP envoyée par une imprimante Bambu Lab (NOTIFY ou réponse à M-SEARCH).
function parseSsdp(text) {
  const h = {};
  String(text).split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  });
  if (!/bambulab/i.test(`${h.nt || ''} ${h.st || ''}`)) return null;
  const serial = h.usn;
  if (!serial) return null;
  const rawModel = h['devmodel.bambu.com'] || null;
  return {
    type: 'bambu',
    host: h.location || null,
    serial,
    name: h['devname.bambu.com'] || null,
    model: rawModel ? (BAMBU_MODELS[rawModel] || rawModel) : null,
    lan: h['devconnect.bambu.com'] || null
  };
}

function discoverBambu(opts = {}) {
  const { timeoutMs = 4500, listenPorts = [1990, 2021], groups = ['239.255.255.250'], sendTo = [{ addr: '239.255.255.250', port: 1990 }] } = opts;
  return new Promise((resolve) => {
    const found = new Map();
    const sockets = [];
    const onMsg = (msg, rinfo) => {
      const d = parseSsdp(msg.toString());
      if (!d) return;
      if (!d.host) d.host = rinfo.address;
      found.set(d.serial, d);
    };
    const open = (port, membership) => {
      try {
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        sock.on('error', () => { /* port déjà pris : on continue sans */ });
        sock.on('message', onMsg);
        sock.bind(port, () => {
          if (!membership) return;
          const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
          groups.forEach((g) => addrs.forEach((a) => { try { sock.addMembership(g, a); } catch (e) { /* ignoré */ } }));
        });
        sockets.push(sock);
      } catch (e) { /* ignoré */ }
    };
    listenPorts.forEach((p) => open(p, true));
    // recherche active : on demande aux imprimantes de se signaler
    try {
      const prober = dgram.createSocket('udp4');
      prober.on('error', () => {});
      prober.on('message', onMsg);
      prober.bind(0, () => {
        const msg = Buffer.from(['M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1990', 'MAN: "ssdp:discover"', 'MX: 2', 'ST: urn:bambulab-com:device:3dprinter:1', '', ''].join('\r\n'));
        sendTo.forEach((t) => { try { prober.send(msg, t.port, t.addr); } catch (e) { /* ignoré */ } });
      });
      sockets.push(prober);
    } catch (e) { /* ignoré */ }
    setTimeout(() => {
      sockets.forEach((s) => { try { s.close(); } catch (e) { /* ignoré */ } });
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

// Réseaux de cet ordinateur (adresses privées seulement, limités au /24 pour rester rapide)
function localSubnets(ifaces = os.networkInterfaces()) {
  const out = new Map();
  Object.keys(ifaces || {}).forEach((name) => (ifaces[name] || []).forEach((a) => {
    if (!a || a.family !== 'IPv4' || a.internal || !isPrivate(a.address)) return;
    const p = a.address.split('.');
    const base = `${p[0]}.${p[1]}.${p[2]}.`;
    if (!out.has(base)) out.set(base, { base, own: a.address, iface: name });
  }));
  return [...out.values()];
}

function hostsOf(subnets) {
  const hosts = [];
  subnets.forEach((s) => { for (let i = 1; i <= 254; i++) { const ip = `${s.base}${i}`; if (ip !== s.own) hosts.push(ip); } });
  return hosts;
}

async function probeMoonraker(host, ports = [7125, 4408], timeoutMs = 900) {
  for (const port of ports) {
    try {
      const r = await fetch(`http://${host}:${port}/server/info`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) continue;
      const j = await r.json();
      if (!j || !j.result || !('moonraker_version' in j.result || 'klippy_state' in j.result)) continue;
      let name = null;
      try {
        const r2 = await fetch(`http://${host}:${port}/printer/info`, { signal: AbortSignal.timeout(timeoutMs) });
        if (r2.ok) { const i = await r2.json(); name = (i.result && i.result.hostname) || null; }
      } catch (e) { /* le nom est facultatif */ }
      return { type: 'moonraker', host, port, name, detail: j.result.moonraker_version || null };
    } catch (e) { /* port fermé ou pas de réponse */ }
  }
  return null;
}

async function scanHosts(hosts, ports = [7125, 4408], timeoutMs = 900, concurrency = 48) {
  const found = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++];
      const r = await probeMoonraker(host, ports, timeoutMs);
      if (r) found.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

// Recherche complète : Bambu Lab (annonces SSDP) + imprimantes Klipper (test des adresses du réseau)
async function discover() {
  const subs = localSubnets();
  if (!subs.length) return { error: 'Aucun réseau détecté sur cet ordinateur : vérifie qu’il est connecté au Wi-Fi de l’atelier.', bambu: [], moonraker: [], networks: [] };
  const hosts = hostsOf(subs);
  const [bambu, moonraker] = await Promise.all([discoverBambu(), scanHosts(hosts)]);
  return { bambu, moonraker, scanned: hosts.length, networks: subs.map((s) => `${s.base}x`) };
}

module.exports = { Relay, testPrinter, normalizeMoonraker, normalizeBambu, fetchMoonraker, BambuClient, parseSsdp, discoverBambu, localSubnets, hostsOf, probeMoonraker, scanHosts, discover };
