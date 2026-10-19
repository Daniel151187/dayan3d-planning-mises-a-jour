(() => {
  'use strict';

  if (!window.CONFIG || !window.CONFIG.SUPABASE_URL || !window.CONFIG.SUPABASE_KEY) {
    if (window.__fatal) window.__fatal('Le fichier config.js est vide ou absent : l’adresse de la base de données est introuvable.');
    return;
  }
  const sb = window.supabase.createClient(window.CONFIG.SUPABASE_URL, window.CONFIG.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  /* ------------------------------------------------------------------ */
  /*  Utilitaires                                                        */
  /* ------------------------------------------------------------------ */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const mondayOf = (d) => { const x = startOfDay(d); return addDays(x, -((x.getDay() + 6) % 7)); };
  const sameDay = (a, b) => ymd(a) === ymd(b);
  const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
  const fmtShort = (d) => d.toLocaleDateString('fr-CH', { day: 'numeric', month: 'short' });
  const fmtDayLong = (d) => d.toLocaleDateString('fr-CH', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit' });
  const fmtDateTime = (iso) => `${fmtDayLong(new Date(iso))}, ${fmtTime(iso)}`;
  const fmtMoney = (n) => `CHF ${Number(n).toLocaleString('fr-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtSize = (n) => (n == null ? '' : n < 1024 ? `${n} o` : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${(n / 1048576).toFixed(1)} Mo`);
  const initials = (name) => (name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const flat = (fields) => fields.flat();

  let toastTimer;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, isErr ? 6000 : 2200);
  }

  /* ------------------------------------------------------------------ */
  /*  État                                                               */
  /* ------------------------------------------------------------------ */
  const state = {
    started: false,
    me: null,
    profiles: [], machines: [], orders: [], prints: [], tasks: [], availability: [], attachments: [], history: [],
    materials: [], material_uses: [], stock_moves: [], comments: [], comment_reads: [], machine_blocks: [], clients: [], print_templates: [], maintenance_rules: [], trash: [], spools: [], volunteer_hours: [], printer_status: [], volRange: 'month', filTab: 'spools', filFilter: 'all', filType: '', filQuery: '', helpQuery: '', helpOpen: '', statsRange: 30, orderFilter: { urgent: false, tag: '' }, openOrderId: null,
    view: 'today',
    calMode: 'month',
    cursor: startOfDay(new Date()),
    tlStart: mondayOf(new Date()),
    teamStart: mondayOf(new Date()),
    taskFilter: 'all',
    channel: null,
    modalRefresh: null
  };

  const TABLES = ['profiles', 'machines', 'orders', 'prints', 'tasks', 'availability', 'attachments', 'history', 'materials', 'material_uses', 'stock_moves', 'comments', 'comment_reads', 'machine_blocks', 'clients', 'print_templates', 'maintenance_rules', 'trash', 'spools', 'volunteer_hours', 'printer_status'];

  const profileName = (id) => state.profiles.find((p) => p.id === id)?.name || 'Quelqu’un';
  const machineName = (id) => state.machines.find((m) => m.id === id)?.name || 'Sans machine';
  const orderLabel = (o) => (o.client ? `${o.client} – ${o.title}` : o.title);

  /* ---------- Clients, étiquettes, recherche ---------- */
  const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const clientById = (id) => state.clients.find((c) => c.id === id);
  const allTags = () => [...new Set(state.orders.flatMap((o) => o.tags || []))].sort((x, y) => x.localeCompare(y, 'fr'));
  const orderMatchesFilter = (o) => (!state.orderFilter.urgent || o.priority === 'urgent') && (!state.orderFilter.tag || (o.tags || []).includes(state.orderFilter.tag));
  function clientStats(c) {
    const os = state.orders.filter((o) => o.client_id === c.id);
    return { n: os.length, total: os.reduce((s, o) => s + (Number(o.price_chf) || 0), 0) };
  }
  function orphanOrders() { return state.orders.filter((o) => !o.client_id && o.client && o.client.trim()); }

  /* ---------- Commentaires ---------- */
  const readAt = (orderId) => { const r = state.comment_reads.find((x) => x.order_id === orderId); return r ? +new Date(r.last_read_at) : 0; };
  const commentsOf = (orderId) => state.comments.filter((c) => c.order_id === orderId).sort((x, y) => new Date(x.created_at) - new Date(y.created_at));
  const unreadOf = (orderId) => state.comments.filter((c) => c.order_id === orderId && c.created_by !== (state.me && state.me.id) && +new Date(c.created_at) > readAt(orderId)).length;
  const totalUnread = () => state.orders.reduce((n, o) => n + unreadOf(o.id), 0);
  async function markRead(orderId) {
    const { error } = await sb.rpc('mark_order_read', { p_order: orderId });
    if (error) return;
    await loadTable('comment_reads');
    render();
  }

  /* ---------- Chevauchements et blocages ---------- */
  const rangesOverlap = (s1, e1, s2, e2) => +s1 < +e2 && +s2 < +e1;
  const isActivePrint = (p) => p.status === 'planned' || p.status === 'printing';
  const FAIL_REASONS = ['Décollement du plateau', 'Bourrage ou buse bouchée', 'Filament épuisé ou cassé', 'Pièce détachée (spaghetti)', 'Coupure de courant', 'Réglage ou calibration', 'Autre'];
  function printConflicts(machineId, startIso, endIso, excludeId) {
    if (!machineId || !startIso || !endIso) return [];
    const s = new Date(startIso), e = new Date(endIso), out = [];
    state.prints.forEach((p) => {
      if (p.id !== excludeId && p.machine_id === machineId && isActivePrint(p) && rangesOverlap(s, e, new Date(p.start_at), new Date(p.end_at))) {
        out.push(`l’impression « ${p.title} » (${fmtDateTime(p.start_at)})`);
      }
    });
    state.machine_blocks.forEach((b) => {
      if (b.machine_id === machineId && rangesOverlap(s, e, new Date(b.start_at), new Date(b.end_at))) out.push(`le blocage « ${b.reason} » (${fmtDateTime(b.start_at)})`);
    });
    return out;
  }
  function clashIds() {
    const ids = new Set();
    state.prints.forEach((p) => {
      if (isActivePrint(p) && p.machine_id && printConflicts(p.machine_id, p.start_at, p.end_at, p.id).length) ids.add(p.id);
    });
    return ids;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  /* ---------- Entretien selon les heures d'impression ---------- */
  function machineHoursSince(machineId, since) {
    const from = +new Date(since), now = Date.now();
    return state.prints
      .filter((p) => p.machine_id === machineId && (p.status === 'done' || p.status === 'failed' || p.status === 'printing'))
      .reduce((s, p) => s + Math.max(0, Math.min(+new Date(p.end_at), now) - Math.max(+new Date(p.start_at), from)) / 36e5, 0);
  }
  function ruleProgress(r) {
    const h = machineHoursSince(r.machine_id, r.last_done_at);
    return { h, pct: (h / Number(r.every_h)) * 100 };
  }
  const dueRules = () => state.maintenance_rules.filter((r) => ruleProgress(r).pct >= 100);
  const TRASH_TABLES = new Set(['orders', 'tasks', 'prints', 'clients', 'print_templates']);
  const TRASH_LABEL = { orders: 'Commande', tasks: 'Tâche', prints: 'Impression', clients: 'Client', print_templates: 'Modèle' };

  /* ---------- État en direct des imprimantes ---------- */
  const LIVE_FRESH_MS = 150000;
  const LIVE_FR = { printing: 'En impression', paused: 'En pause', idle: 'Libre', finished: 'Terminée', error: 'Erreur', offline: 'Hors ligne' };
  function liveOf(machineId) {
    const r = state.printer_status.find((x) => x.machine_id === machineId);
    if (!r) return null;
    const fresh = Date.now() - +new Date(r.updated_at) < LIVE_FRESH_MS;
    return { ...r, fresh, state: fresh ? r.state : 'offline' };
  }
  const fmtRemain = (min) => (min == null ? '' : min >= 60 ? `${Math.floor(min / 60)} h ${pad(Math.round(min % 60))}` : `${Math.round(min)} min`);
  function liveBadge(machineId) {
    const l = liveOf(machineId);
    if (!l || l.state === 'offline' || l.state === 'idle') return '';
    const txt = l.state === 'printing' ? `${Math.round(Number(l.progress) || 0)} %` : LIVE_FR[l.state];
    return `<span class="lv ${l.state}">${esc(txt)}</span>`;
  }

  /* ---------- Bobines ---------- */
  const spoolById = (id) => state.spools.find((s) => s.id === id);
  const spoolLeft = (s) => Math.max(0, Number(s.remaining_g));
  const spoolName = (s) => { const m = materialById(s.material_id); return `${m ? m.name : 'Bobine'}${s.label ? ` ${s.label}` : ''}`; };
  const loadedSpool = (materialId, machineId) => state.spools
    .filter((s) => s.status === 'active' && s.material_id === materialId && s.machine_id === machineId)
    .sort((x, y) => new Date(y.loaded_at || 0) - new Date(x.loaded_at || 0))[0];
  /* ---------- Filaments : références, couleurs, séchage ---------- */
  // Valeurs indicatives : la notice du fabricant fait foi.
  const FIL_TYPES = {
    PLA: { nozzle: [190, 220], bed: 60, dry: [45, 5], wet: false },
    PETG: { nozzle: [230, 250], bed: 75, dry: [65, 5], wet: true },
    ABS: { nozzle: [240, 260], bed: 100, dry: [80, 4], wet: false },
    ASA: { nozzle: [240, 260], bed: 95, dry: [80, 4], wet: false },
    TPU: { nozzle: [210, 230], bed: 50, dry: [50, 5], wet: true },
    PA: { nozzle: [250, 280], bed: 80, dry: [80, 10], wet: true },
    PC: { nozzle: [260, 300], bed: 110, dry: [80, 6], wet: true },
    PVA: { nozzle: [190, 210], bed: 55, dry: [45, 6], wet: true },
    Autre: { nozzle: [null, null], bed: null, dry: [null, null], wet: false }
  };
  const FIL_TYPE_LIST = Object.keys(FIL_TYPES);
  const DRY_AFTER_DAYS = 30;
  const filType = (m) => (m && m.filament_type) || '';
  const filHex = (m) => (m && /^#[0-9a-f]{6}$/i.test(m.color_hex || '') ? m.color_hex : null);
  const filTitle = (m) => (m ? ([m.brand, m.filament_type, m.color_name].filter(Boolean).join(' ') || m.name) : 'Filament');
  const swatchHtml = (m, big) => `<span class="swatch ${big ? 'big' : ''}" ${filHex(m) ? `style="background:${filHex(m)}"` : 'data-none="1"'} aria-hidden="true"></span>`;
  // prix au kilo : celui payé pour cette bobine, sinon celui de la référence
  const pricePerKg = (s, m) => {
    if (Number(s.price_chf) > 0 && Number(s.initial_g) > 0) return (Number(s.price_chf) / Number(s.initial_g)) * 1000;
    if (m && m.unit === 'g' && Number(m.cost_chf) > 0 && Number(m.cost_qty) > 0) return (Number(m.cost_chf) / Number(m.cost_qty)) * 1000;
    return null;
  };
  const daysSince = (day) => Math.floor((startOfDay(new Date()) - parseYmd(day)) / 864e5);
  // une bobine de filament qui craint l'humidité, ouverte depuis plus de 30 jours sans séchage récent
  const needsDrying = (s) => {
    const m = materialById(s.material_id);
    const t = FIL_TYPES[filType(m)];
    if (!t || !t.wet || s.status !== 'active' || s.dry_storage || !s.opened_at) return false;
    const ref = s.dried_at && s.dried_at >= s.opened_at ? s.dried_at : s.opened_at;
    return daysSince(ref) > DRY_AFTER_DAYS;
  };
  const dryAdvice = (m) => {
    const t = FIL_TYPES[filType(m)] || {};
    const c = (m && m.dry_c) || (t.dry && t.dry[0]);
    const h = (m && m.dry_h) || (t.dry && t.dry[1]);
    return c ? `${c} °C pendant ${h ? `environ ${h} h` : 'quelques heures'}` : '';
  };
  const round1 = (x) => Math.round(Number(x) * 10) / 10;
  const FIL_FILTERS = [['all', 'En service'], ['loaded', 'Chargées'], ['reserve', 'En réserve'], ['low', 'Bientôt vides'], ['dry', 'À sécher'], ['empty', 'Terminées']];
  const MOVE_FR = { use: 'Utilisation', return: 'Retour', purchase: 'Achat', adjust: 'Correction', inventory: 'Pesée ou inventaire' };

  const lowSpools = () => state.spools.filter((s) => s.status === 'active' && s.machine_id && spoolLeft(s) <= Number(s.alert_g));

  /* ---------- Stock et coût matière ---------- */
  const MAT_CATS = [['filament', 'Filaments'], ['wood', 'Bois et plaques'], ['other', 'Autres consommables']];
  const MAT_UNITS = [['g', 'grammes (g)'], ['plaque', 'plaques'], ['pièce', 'pièces']];
  const materialById = (id) => state.materials.find((m) => m.id === id);
  const unitFor = (m, q) => (m.unit === 'g' || Math.abs(Number(q)) <= 1 ? m.unit : `${m.unit}s`);
  const fmtNum = (n) => Number(n).toLocaleString('fr-CH', { maximumFractionDigits: 2 });
  const isLow = (m) => Number(m.min_quantity) > 0 && Number(m.quantity) <= Number(m.min_quantity);
  const lowStock = () => state.materials.filter(isLow);
  const unitCost = (m) => (m && m.cost_chf != null && Number(m.cost_qty) > 0 ? Number(m.cost_chf) / Number(m.cost_qty) : null);
  const reorderQty = (m) => (Number(m.reorder_qty) > 0 ? Number(m.reorder_qty) : Math.max(Number(m.min_quantity) * 2 - Number(m.quantity), Number(m.min_quantity)));
  function reorderLines() {
    return lowStock().sort((x, y) => x.name.localeCompare(y.name, 'fr')).map((m) => {
      const q = reorderQty(m);
      const c = unitCost(m);
      return { m, q, cost: c == null ? null : c * q };
    });
  }
  function priceLabel(m) {
    const c = unitCost(m);
    if (c == null) return 'Prix non renseigné';
    return m.unit === 'g' ? `${fmtMoney(c * 1000)} le kg` : `${fmtMoney(c)} par ${m.unit}`;
  }
  function costOfRows(rows) {
    let total = 0;
    const missing = new Set();
    rows.forEach((r) => {
      const m = materialById(r.material_id);
      const q = Number(r.qty) || 0;
      if (!m || !q) return;
      const c = unitCost(m);
      if (c == null) missing.add(m.name); else total += c * q;
    });
    return { total, missing: [...missing] };
  }
  // coût matière d'une commande : impressions liées + matières ajoutées à la commande
  function orderCost(orderId, extraRows) {
    const printIds = new Set(orderId ? state.prints.filter((p) => p.order_id === orderId).map((p) => p.id) : []);
    const fromPrints = costOfRows(state.material_uses.filter((u) => u.print_id && printIds.has(u.print_id)));
    const extras = costOfRows(extraRows || (orderId ? state.material_uses.filter((u) => u.order_id === orderId) : []));
    return { prints: fromPrints.total, extras: extras.total, total: fromPrints.total + extras.total, missing: [...new Set([...fromPrints.missing, ...extras.missing])] };
  }
  function printHours(orderId) {
    const ms = state.prints.filter((p) => p.order_id === orderId).reduce((s, p) => s + (new Date(p.end_at) - new Date(p.start_at)), 0);
    const h = Math.floor(ms / 36e5), m = Math.round((ms % 36e5) / 6e4);
    return ms > 0 ? `${h} h${m ? ` ${pad(m)}` : ''}` : '';
  }

  async function loadTable(t) {
    let q = sb.from(t).select('*');
    if (t === 'history') q = q.order('at', { ascending: false }).limit(200);
    if (t === 'stock_moves') q = q.order('at', { ascending: false }).limit(300);
    if (t === 'trash') q = q.order('deleted_at', { ascending: false }).limit(200);
    const { data, error } = await q;
    if (error) {
      if (/schema cache|does not exist/i.test(error.message)) {
        toast('Base non initialisée : lance d’abord le script supabase-schema.sql dans Supabase.', true);
      } else {
        toast(`Erreur de chargement (${t}) : ${error.message}`, true);
      }
      return;
    }
    state[t] = data || [];
    if (t === 'machines') state.machines.sort((a, b) => a.sort - b.sort);
    if (t === 'profiles') state.profiles.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }
  const loadAll = () => Promise.all(TABLES.map(loadTable));

  /* ---------- Synchronisation en direct ---------- */
  const pending = new Set();
  let reloadTimer;
  function scheduleReload(t) {
    pending.add(t);
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      const list = [...pending];
      pending.clear();
      await Promise.all(list.map(loadTable));
      render();
      if (state.modalRefresh) state.modalRefresh();
      checkReminders();
    }, 250);
  }

  function setSync(ok) {
    const el = $('#sync');
    el.className = 'sync ' + (ok ? 'ok' : 'off');
    $('#sync-text').textContent = ok ? 'Synchronisé en direct' : 'Hors ligne';
  }

  function subscribe() {
    if (state.channel) sb.removeChannel(state.channel);
    let ch = sb.channel('dayan3d-planning');
    TABLES.forEach((t) => {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => scheduleReload(t));
    });
    ch.subscribe((status) => setSync(status === 'SUBSCRIBED'));
    state.channel = ch;
  }
  window.addEventListener('online', () => { loadAll().then(render); subscribe(); });
  let lastWake = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.started || Date.now() - lastWake < 20000) return;
    lastWake = Date.now();
    loadAll().then(render);
  });
  window.addEventListener('offline', () => setSync(false));

  /* ------------------------------------------------------------------ */
  /*  Connexion                                                          */
  /* ------------------------------------------------------------------ */
  function showLogin() {
    state.started = false;
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#login-pass').value = '';
  }

  async function start(session) {
    if (state.started) return;
    state.started = true;
    state.me = session.user;
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    await loadAll();
    await purgeOldTrash();
    const mine = state.profiles.find((p) => p.id === state.me.id);
    $('#me').innerHTML = `<span class="avatar">${esc(initials(mine?.name || state.me.email))}</span><span class="name">${esc(mine?.name || state.me.email)}</span>`;
    subscribe();
    if (location.hash === '#atelier') { state.view = 'atelier'; document.body.classList.add('kiosk'); }
    if (window.dayanApp && window.dayanApp.getPrinters) { try { printerCfg = await window.dayanApp.getPrinters(); } catch (e) { /* ignoré */ } }
    render();
    if (!handleScanLink()) setTimeout(maybeOfferTour, 1200);
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn');
    const err = $('#login-error');
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Connexion…';
    const { data, error } = await sb.auth.signInWithPassword({
      email: $('#login-email').value.trim(),
      password: $('#login-pass').value
    });
    btn.disabled = false;
    btn.textContent = 'Se connecter';
    if (error) {
      err.textContent = /invalid login/i.test(error.message)
        ? 'E-mail ou mot de passe incorrect.'
        : /fetch|network/i.test(error.message)
          ? 'Pas de connexion internet.'
          : error.message;
      return;
    }
    await start(data.session);
  });

  $('#logout').addEventListener('click', async () => {
    if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
    await sb.auth.signOut();
    showLogin();
  });

  /* ------------------------------------------------------------------ */
  /*  Navigation et barre du haut                                        */
  /* ------------------------------------------------------------------ */
  const ICONS = {
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    machines: '<path d="M3 6h12M7 12h14M3 18h9"/>',
    orders: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/>',
    tasks: '<path d="M10 6h11M10 12h11M10 18h11"/><path d="M3.5 6l1.2 1.2L7 4.8M3.5 12l1.2 1.2L7 10.8M3.5 18l1.2 1.2L7 16.8"/>',
    team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14.2c2.6.2 4.5 2 4.5 5"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
    filaments: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 4v3M12 17v3M4 12h3M17 12h3"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.1 1-1.1 1.8M12 17h.01"/>',
    atelier: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    volunteers: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
    clients: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
    today: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
    stock: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>'
  };
  const NAV = [
    ['today', 'Aujourd’hui'],
    ['atelier', 'Affichage atelier'],
    ['calendar', 'Calendrier'],
    ['machines', 'Machines'],
    ['orders', 'Commandes'],
    ['clients', 'Clients'],
    ['stock', 'Stock'],
    ['filaments', 'Filaments'],
    ['tasks', 'Tâches'],
    ['team', 'Équipe'],
    ['volunteers', 'Bénévolat'],
    ['stats', 'Statistiques'],
    ['history', 'Historique'],
    ['trash', 'Corbeille'],
    ['help', 'Aide']
  ];

  function renderNav() {
    $('#nav').innerHTML = NAV.map(([id, label]) => `
      <button type="button" data-act="nav" data-view="${id}" ${state.view === id ? 'aria-current="page"' : ''}>
        <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[id]}</svg><span>${label}</span>${id === 'stock' && lowStock().length + lowSpools().length ? `<b class="badge" title="Stocks et bobines bas">${lowStock().length + lowSpools().length}</b>` : ''}${id === 'orders' && totalUnread() ? `<b class="badge" title="Nouveaux commentaires">${totalUnread()}</b>` : ''}${id === 'machines' && dueRules().length ? `<b class="badge" title="Entretiens à faire">${dueRules().length}</b>` : ''}
      </button>`).join('');
  }

  const navBtns = `
    <button class="btn icon-btn" type="button" data-act="prev" aria-label="Précédent">‹</button>
    <button class="btn btn-small" type="button" data-act="today">Aujourd’hui</button>
    <button class="btn icon-btn" type="button" data-act="next" aria-label="Suivant">›</button>`;

  function calLabel() {
    const c = state.cursor;
    if (state.calMode === 'month') return cap(c.toLocaleDateString('fr-CH', { month: 'long', year: 'numeric' }));
    const a = mondayOf(c);
    const b = addDays(a, 6);
    return `${fmtShort(a)} – ${fmtShort(b)} ${b.getFullYear()}`;
  }

  function renderTop() {
    const v = state.view;
    let html = '';
    if (v === 'today') {
      const first = (profileName(state.me.id) || '').split(' ')[0];
      html = `<h2>Aujourd’hui</h2><span class="grow hint">Bonjour ${esc(first)}, ${esc(new Date().toLocaleDateString('fr-CH', { weekday: 'long', day: 'numeric', month: 'long' }))}</span>
        <button class="btn btn-primary" type="button" data-act="new-menu">+ Nouveau</button>`;
    } else if (v === 'calendar') {
      html = `<h2>${esc(calLabel())}</h2>${navBtns}
        <div class="seg" role="group" aria-label="Affichage">
          <button type="button" data-act="mode" data-mode="month" aria-pressed="${state.calMode === 'month'}">Mois</button>
          <button type="button" data-act="mode" data-mode="week" aria-pressed="${state.calMode === 'week'}">Semaine</button>
        </div>
        <span class="grow hint">Double-clic sur un jour pour ajouter une tâche</span>
        <button class="btn btn-primary" type="button" data-act="new-menu">+ Nouveau</button>`;
    } else if (v === 'machines') {
      const a = state.tlStart, b = addDays(a, 13);
      html = `<h2>Machines</h2>${navBtns}<span class="hint">${fmtShort(a)} – ${fmtShort(b)} ${b.getFullYear()}</span>
        <span class="grow hint">Double-clic sur une machine pour planifier une impression</span>
        <button class="btn" type="button" data-act="plan">Planifier</button>
        <button class="btn" type="button" data-act="newitem" data-kind="maintenance">+ Entretien</button>
        <button class="btn" type="button" data-act="newitem" data-kind="template">+ Modèle</button>
        <button class="btn" type="button" data-act="newitem" data-kind="block">+ Blocage</button>
        <button class="btn btn-primary" type="button" data-act="newitem" data-kind="print">+ Impression</button>`;
    } else if (v === 'orders') {
      const tags = allTags();
      html = `<h2>Commandes</h2>
        <div class="seg" role="group" aria-label="Filtre">
          <button type="button" data-act="ofilter" data-f="all" aria-pressed="${!state.orderFilter.urgent}">Toutes</button>
          <button type="button" data-act="ofilter" data-f="urgent" aria-pressed="${state.orderFilter.urgent}">Urgentes</button>
        </div>
        ${tags.length ? `<select id="tag-filter" class="mini-select" aria-label="Étiquette"><option value="">Toutes les étiquettes</option>${tags.map((t) => `<option value="${esc(t)}" ${state.orderFilter.tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}
        <span class="grow hint">Glisse une commande pour changer son état</span>
        <button class="btn btn-primary" type="button" data-act="newitem" data-kind="order">+ Commande</button>`;
    } else if (v === 'tasks') {
      html = `<h2>Tâches</h2>
        <div class="seg" role="group" aria-label="Filtre">
          <button type="button" data-act="filter" data-f="all" aria-pressed="${state.taskFilter === 'all'}">Toutes</button>
          <button type="button" data-act="filter" data-f="mine" aria-pressed="${state.taskFilter === 'mine'}">Les miennes</button>
        </div><span class="grow"></span>
        <button class="btn btn-primary" type="button" data-act="newitem" data-kind="task">+ Tâche</button>`;
    } else if (v === 'team') {
      const a = state.teamStart, b = addDays(a, 6);
      html = `<h2>Équipe</h2>${navBtns}<span class="hint">${fmtShort(a)} – ${fmtShort(b)} ${b.getFullYear()}</span>
        <span class="grow hint">Clique sur une case pour indiquer une disponibilité</span>
        <button class="btn btn-primary" type="button" data-act="newitem" data-kind="avail">+ Disponibilité</button>`;
    } else if (v === 'stats') {
      html = `<h2>Statistiques</h2>
        <div class="seg" role="group" aria-label="Période">
          ${[[30, '30 jours'], [90, '3 mois'], [365, '12 mois']].map(([d, l]) => `<button type="button" data-act="srange" data-r="${d}" aria-pressed="${state.statsRange === d}">${l}</button>`).join('')}
        </div><span class="grow hint">Sur les commandes terminées et les impressions réalisées</span>`;
    } else if (v === 'clients') {
      const orphans = orphanOrders().length;
      html = `<h2>Clients</h2><span class="grow hint">${state.clients.length} fiche${state.clients.length > 1 ? 's' : ''}</span>
        ${orphans ? '<button class="btn" type="button" data-act="clients-import">Créer les fiches depuis les commandes</button>' : ''}
        ${state.clients.length ? '<button class="btn" type="button" data-act="clients-export">Envoyer vers la facturation</button>' : ''}
        <button class="btn btn-primary" type="button" data-act="newitem" data-kind="client">+ Client</button>`;
    } else if (v === 'atelier') {
      html = `<h2>Affichage atelier</h2><span class="grow hint">Pour une tablette ou une télé à l’atelier : il se met à jour tout seul</span>
        <button class="btn btn-primary" type="button" data-act="kiosk-on">Plein écran</button>`;
    } else if (v === 'volunteers') {
      html = `<h2>Bénévolat</h2>
        <div class="seg" role="group" aria-label="Période">
          ${[['month', 'Ce mois'], ['quarter', '3 mois'], ['year', 'Cette année']].map(([k, l]) => `<button type="button" data-act="vrange" data-r="${k}" aria-pressed="${state.volRange === k}">${l}</button>`).join('')}
        </div><span class="grow hint">Heures données par chaque membre, avec ou sans compte</span>
        <button class="btn btn-primary" type="button" data-act="newitem" data-kind="volunteer">+ Heures</button>`;
    } else if (v === 'filaments') {
      html = `<h2>Filaments</h2>
        <div class="seg" role="group" aria-label="Affichage">${[['spools', 'Bobines'], ['catalog', 'Catalogue']].map(([k, l]) => `<button type="button" data-act="fil-tab" data-tab="${k}" aria-pressed="${state.filTab === k}">${l}</button>`).join('')}</div>
        <span class="grow"></span>
        <button class="btn" type="button" data-act="newitem" data-kind="filament">+ Filament</button>
        <button class="btn btn-primary" type="button" data-act="newitem" data-kind="spool">+ Bobine</button>`;
    } else if (v === 'help') {
      html = `<h2>Aide</h2><span class="grow hint">Tout pour bien utiliser l’application</span>
        <button class="btn btn-primary" type="button" data-act="tour">Visite guidée</button>`;
    } else if (v === 'trash') {
      html = `<h2>Corbeille</h2><span class="grow hint">Les éléments supprimés restent 30 jours</span>`;
    } else if (v === 'stock') {
      html = `<h2>Stock</h2><span class="grow hint">Le stock baisse quand une impression ou une commande passe à « Terminée »</span>
        <button class="btn" type="button" data-act="newitem" data-kind="spool">+ Bobine</button>
        <button class="btn btn-primary" type="button" data-act="newitem" data-kind="material">+ Matière</button>`;
    } else {
      html = `<h2>Historique</h2><span class="grow hint">Les 200 dernières modifications de l’équipe</span>`;
    }
    $('#top').innerHTML = `<button class="btn icon-btn menu-btn" type="button" data-act="menu" aria-label="Menu">☰</button>${html}${v === 'help' ? '' : '<button class="btn btn-quiet icon-btn help-btn" type="button" data-act="help-view" aria-label="Aide sur cette page" title="Aide sur cette page (F1)">?</button>'}`;
  }

  function render() {
    if (!state.started) return;
    const view = $('#view');
    const st = view.scrollTop;
    renderNav();
    renderTop();
    const html = { filaments: filamentsHtml, help: helpHtml, atelier: atelierHtml, volunteers: volunteersHtml, trash: trashHtml, stats: statsHtml, today: todayHtml, calendar: calendarHtml, machines: machinesHtml, orders: ordersHtml, clients: clientsHtml, stock: stockHtml, tasks: tasksHtml, team: teamHtml, history: historyHtml }[state.view]();
    view.innerHTML = html;
    view.scrollTop = st;
  }

  /* ------------------------------------------------------------------ */
  /*  Vue : aujourd'hui                                                  */
  /* ------------------------------------------------------------------ */
  function todayHtml() {
    const now = new Date(), d0 = startOfDay(now), d1 = addDays(d0, 1), todayKey = ymd(now), meId = state.me.id;
    const panel = (title, count, body) => `<section class="panel"><header><h3>${title}</h3>${count != null ? `<span class="count">${count}</span>` : ''}</header>${body}</section>`;
    const empty = (t) => `<div class="empty-day">${t}</div>`;
    const item = (act, attrs, main, sub, cls = '') => `<button type="button" class="tl-item ${cls}" data-act="${act}" ${attrs}><span class="ti-main">${esc(main)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</button>`;

    const machineRows = state.machines.map((m) => {
      const blk = state.machine_blocks.find((b) => b.machine_id === m.id && new Date(b.start_at) <= now && new Date(b.end_at) >= now);
      const cur = state.prints.find((p) => p.machine_id === m.id && isActivePrint(p) && (p.status === 'printing' || (new Date(p.start_at) <= now && new Date(p.end_at) >= now)));
      const next = state.prints.filter((p) => p.machine_id === m.id && p.status === 'planned' && new Date(p.start_at) > now).sort((x, y) => new Date(x.start_at) - new Date(y.start_at))[0];
      let sub, cls;
      const lv = liveOf(m.id);
      if (blk) { sub = `Bloquée : ${blk.reason} jusqu’au ${fmtDateTime(blk.end_at)}`; cls = 'blocked'; }
      else if (lv && lv.state === 'printing') { sub = `${lv.file_name || 'Impression'} : ${Math.round(Number(lv.progress) || 0)} %${lv.remaining_min != null ? `, encore ${fmtRemain(lv.remaining_min)}` : ''}`; cls = 'busy'; }
      else if (lv && lv.state === 'paused') { sub = `En pause : ${lv.file_name || 'impression'}`; cls = 'busy'; }
      else if (lv && lv.state === 'error') { sub = `Erreur sur l’imprimante${lv.file_name ? ` : ${lv.file_name}` : ''}`; cls = 'busy'; }
      else if (lv && lv.state === 'finished') { sub = `Impression terminée${lv.file_name ? ` : ${lv.file_name}` : ''}, à vider`; cls = 'free'; }
      else if (cur) { sub = `${cur.title}, fin ${sameDay(new Date(cur.end_at), now) ? fmtTime(cur.end_at) : fmtDateTime(cur.end_at)}`; cls = 'busy'; }
      else if (next) { sub = `Libre, prochaine : ${next.title} (${fmtDateTime(next.start_at)})`; cls = 'free'; }
      else { sub = 'Libre'; cls = 'free'; }
      return item('nav', 'data-view="machines"', m.name, sub, `machine ${cls}`);
    }).join('');

    const prints = state.prints.filter((p) => isActivePrint(p) && new Date(p.start_at) < d1 && new Date(p.end_at) > d0)
      .sort((x, y) => new Date(x.start_at) - new Date(y.start_at));
    const printRows = prints.map((p) => {
      const late = new Date(p.end_at) < now;
      return item('edit', `data-kind="print" data-id="${p.id}"`, p.title, `${machineName(p.machine_id)}, ${fmtTime(p.start_at)} à ${fmtTime(p.end_at)}${late ? ', à vérifier' : ''}`, late ? 'late' : '');
    }).join('');

    const tasks = state.tasks.filter((t) => !t.done && t.start_at && new Date(t.start_at) < d1 && (t.kind === 'rdv' || !t.assignee || t.assignee === meId))
      .sort((x, y) => new Date(x.start_at) - new Date(y.start_at));
    const taskRows = tasks.map((t) => {
      const late = new Date(t.end_at || t.start_at) < now && t.kind === 'task';
      return item('edit', `data-kind="task" data-id="${t.id}"`, t.title, `${t.kind === 'rdv' ? 'Rendez-vous, ' : ''}${sameDay(new Date(t.start_at), now) ? fmtTime(t.start_at) : fmtDateTime(t.start_at)}${late ? ', en retard' : ''}`, late ? 'late' : '');
    }).join('');

    const limit = ymd(addDays(d0, 3));
    const dues = state.orders.filter((o) => o.status !== 'done' && o.due_date && o.due_date <= limit).sort((x, y) => x.due_date.localeCompare(y.due_date));
    const dueRows = dues.map((o) => {
      const diff = Math.round((parseYmd(o.due_date) - d0) / 864e5);
      const sub = diff < 0 ? `en retard de ${-diff} jour${diff < -1 ? 's' : ''}` : diff === 0 ? 'à rendre aujourd’hui' : `dans ${diff} jour${diff > 1 ? 's' : ''}`;
      return item('edit', `data-kind="order" data-id="${o.id}"`, orderLabel(o), sub, diff < 0 ? 'late' : '');
    }).join('');

    const shop = state.orders.filter((o) => o.source === 'boutique' && o.status === 'todo').sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
    const shopRows = shop.slice(0, 8).map((o) => item('edit', `data-kind="order" data-id="${o.id}"`, orderLabel(o), `${o.price_chf != null ? `${fmtMoney(o.price_chf)}, ` : ''}reçue le ${fmtDateTime(o.created_at)}`)).join('');

    const maint = state.maintenance_rules.map((r) => ({ r, ...ruleProgress(r) })).filter((x) => x.pct >= 90).sort((x, y) => y.pct - x.pct);
    const maintRows = maint.map(({ r, h, pct }) => item('nav', 'data-view="machines"', r.name, `${machineName(r.machine_id)} : ${fmtNum(Math.round(h))} / ${fmtNum(r.every_h)} h (${Math.round(pct)} %)`, pct >= 100 ? 'late' : '')).join('');

    const loadedRows = state.spools.filter((s) => s.status === 'active' && s.machine_id).sort((x, y) => machineName(x.machine_id).localeCompare(machineName(y.machine_id), 'fr'))
      .map((s) => item('edit', `data-kind="spool" data-id="${s.id}"`, `${machineName(s.machine_id)} : ${spoolName(s)}`, `${fmtNum(Math.round(spoolLeft(s)))} g restants`, spoolLeft(s) <= Number(s.alert_g) ? 'late' : '')).join('');

    const lows = lowStock().sort((x, y) => x.name.localeCompare(y.name, 'fr'));
    const lowRows = lows.map((m) => item('adjust', `data-id="${m.id}"`, m.name, `${fmtNum(m.quantity)} ${unitFor(m, m.quantity)} (alerte sous ${fmtNum(m.min_quantity)})`, 'late')).join('');

    const unread = state.orders.map((o) => ({ o, n: unreadOf(o.id) })).filter((x) => x.n > 0);
    const unreadRows = unread.map(({ o, n }) => item('edit', `data-kind="order" data-id="${o.id}"`, orderLabel(o), `${n} nouveau${n > 1 ? 'x' : ''} commentaire${n > 1 ? 's' : ''}`)).join('');

    const teamRows = state.profiles.map((p) => {
      const a = state.availability.filter((x) => x.user_id === p.id && x.date_from <= todayKey && x.date_to >= todayKey).sort((x, y) => new Date(y.updated_at) - new Date(x.updated_at))[0];
      const label = a ? `${AVAIL_LABEL[a.kind]}${a.note ? `, ${a.note}` : ''}` : 'Pas d’indication';
      return `<div class="tl-item static"><span class="ti-main"><span class="avatar small">${esc(initials(p.name))}</span> ${esc(p.name)}</span><span class="sub ${a && a.kind === 'absent' ? 'late' : ''}">${esc(label)}</span></div>`;
    }).join('');

    return `<div class="today-grid">
      ${panel('Machines', state.machines.length, machineRows || empty('Aucune machine'))}
      ${panel('Impressions du jour', prints.length, printRows || empty('Aucune impression prévue aujourd’hui'))}
      ${panel('Tâches et rendez-vous', tasks.length, taskRows || empty('Rien de prévu aujourd’hui, rien en retard'))}
      ${panel('Commandes à rendre', dues.length, dueRows || empty('Aucune échéance dans les 3 jours'))}
      ${state.spools.length ? panel('Bobines chargées', state.spools.filter((s) => s.status === 'active' && s.machine_id).length, loadedRows || empty('Aucune bobine chargée dans une machine')) : ''}
      ${state.maintenance_rules.length ? panel('Entretien à prévoir', maint.length, maintRows || empty('Rien à prévoir pour le moment')) : ''}
      ${state.orders.some((o) => o.source === 'boutique') ? panel('Boutique en ligne : à traiter', shop.length, shopRows || empty('Aucune nouvelle commande de la boutique')) : ''}
      ${panel('Stocks bas', lows.length, lowRows || empty('Tous les stocks sont suffisants'))}
      ${panel('Nouveaux commentaires', unread.length, unreadRows || empty('Aucun nouveau commentaire'))}
      ${panel('Équipe aujourd’hui', null, teamRows || empty('Aucun collaborateur'))}
    </div>`;
  }

  /* ------------------------------------------------------------------ */
  /*  Vue : calendrier                                                   */
  /* ------------------------------------------------------------------ */
  function dayItems(day) {
    const d0 = day, d1 = addDays(day, 1), key = ymd(day), out = [];
    const overlaps = (s, e) => s < d1 && (e > d0 || (+e === +s && s >= d0));

    state.tasks.forEach((t) => {
      if (!t.start_at) return;
      const s = new Date(t.start_at), e = t.end_at ? new Date(t.end_at) : s;
      if (overlaps(s, e)) {
        out.push({ sort: +s, cls: t.kind === 'rdv' ? 'c-rdv' : '', time: sameDay(s, day) ? fmtTime(t.start_at) : '', label: t.title, title: t.title, kind: 'task', id: t.id, done: t.done });
      }
    });
    state.prints.forEach((p) => {
      const s = new Date(p.start_at), e = new Date(p.end_at);
      if (overlaps(s, e)) {
        out.push({ sort: +s, cls: 'c-print', time: sameDay(s, day) ? fmtTime(p.start_at) : '', label: p.title, title: `${machineName(p.machine_id)} – ${p.title}`, kind: 'print', id: p.id, done: p.status === 'done' || p.status === 'failed' });
      }
    });
    state.orders.forEach((o) => {
      if (o.due_date === key && o.status !== 'done') {
        out.push({ sort: +day + 86399000, cls: 'c-due', time: '', label: `Échéance : ${o.client || o.title}`, title: orderLabel(o), kind: 'order', id: o.id });
      }
    });
    state.availability.forEach((a) => {
      if (a.kind === 'absent' && a.date_from <= key && a.date_to >= key) {
        out.push({ sort: -1, cls: 'c-abs', time: '', label: `${profileName(a.user_id)} absent`, title: a.note || '', kind: 'avail', id: a.id });
      }
    });
    state.machine_blocks.forEach((b) => {
      const s = new Date(b.start_at), e = new Date(b.end_at);
      if (overlaps(s, e)) out.push({ sort: +s, cls: 'c-abs', time: sameDay(s, day) ? fmtTime(b.start_at) : '', label: `${machineName(b.machine_id)} bloquée : ${b.reason}`, title: b.reason, kind: 'block', id: b.id });
    });
    return out.sort((x, y) => x.sort - y.sort);
  }

  function chipHtml(it) {
    return `<button type="button" class="chip ${it.cls} ${it.done ? 'done' : ''}" data-act="edit" data-kind="${it.kind}" data-id="${it.id}" title="${esc(it.title)}">
      ${it.time ? `<span class="t">${it.time}</span>` : ''}<span class="l">${esc(it.label)}</span></button>`;
  }

  const WEEKDAYS = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];

  function calendarHtml() {
    return state.calMode === 'month' ? monthHtml() : weekHtml();
  }

  function monthHtml() {
    const c = state.cursor;
    const first = new Date(c.getFullYear(), c.getMonth(), 1);
    const last = new Date(c.getFullYear(), c.getMonth() + 1, 0);
    const start = mondayOf(first);
    const weeks = Math.round((mondayOf(last) - start) / (7 * 864e5)) + 1;
    const todayKey = ymd(new Date());
    let cells = '';
    for (let i = 0; i < weeks * 7; i++) {
      const day = addDays(start, i);
      const key = ymd(day);
      const items = dayItems(day);
      const shown = items.slice(0, 3).map(chipHtml).join('');
      const more = items.length > 3 ? `<button type="button" class="more" data-act="day" data-date="${key}">+ ${items.length - 3} autre${items.length - 3 > 1 ? 's' : ''}</button>` : '';
      cells += `<div class="cal-cell ${day.getMonth() !== c.getMonth() ? 'other' : ''} ${isWeekend(day) ? 'weekend' : ''} ${key === todayKey ? 'today' : ''}" data-date="${key}">
        <button type="button" class="dnum" data-act="day" data-date="${key}" aria-label="${esc(fmtDayLong(day))}">${day.getDate()}</button>${shown}${more}</div>`;
    }
    return `<div class="cal"><div class="cal-head">${WEEKDAYS.map((d) => `<div>${d}</div>`).join('')}</div><div class="cal-grid">${cells}</div></div>`;
  }

  function weekHtml() {
    const start = mondayOf(state.cursor);
    const todayKey = ymd(new Date());
    let cols = '';
    for (let i = 0; i < 7; i++) {
      const day = addDays(start, i);
      const key = ymd(day);
      const items = dayItems(day);
      cols += `<div class="week-col ${isWeekend(day) ? 'weekend' : ''} ${key === todayKey ? 'today' : ''}" data-date="${key}">
        <header>${esc(fmtDayLong(day))}</header>
        <div class="items">${items.length ? items.map(chipHtml).join('') : '<div class="empty-day">Rien de prévu</div>'}</div></div>`;
    }
    return `<div class="week">${cols}</div>`;
  }

  /* ------------------------------------------------------------------ */
  /*  Vue : frise par machine                                            */
  /* ------------------------------------------------------------------ */
  function machinesHtml() {
    const rs = state.tlStart, re = addDays(rs, 14), span = re - rs;
    const todayKey = ymd(new Date());
    const head = Array.from({ length: 14 }, (_, i) => {
      const d = addDays(rs, i);
      return `<div class="${ymd(d) === todayKey ? 'today' : ''}">${WEEKDAYS[(d.getDay() + 6) % 7]}<b>${d.getDate()}</b></div>`;
    }).join('');

    const clashes = clashIds();
    const rows = state.machines.map((m) => ({ id: m.id, name: m.name }));
    if (state.prints.some((p) => !p.machine_id)) rows.push({ id: '', name: 'Sans machine' });

    const nowPct = ((Date.now() - rs) / span) * 100;
    const weekendDivs = Array.from({ length: 14 }, (_, i) => (isWeekend(addDays(rs, i))
      ? `<div class="tl-we" style="left:${(i / 14) * 100}%;width:${100 / 14}%"></div>` : '')).join('');

    const body = rows.map((m) => {
      const list = [
        ...state.prints.filter((p) => (p.machine_id || '') === m.id && new Date(p.start_at) < re && new Date(p.end_at) > rs).map((p) => ({ ...p, _kind: 'print' })),
        ...state.machine_blocks.filter((b) => b.machine_id === m.id && new Date(b.start_at) < re && new Date(b.end_at) > rs).map((b) => ({ ...b, title: b.reason, status: 'block', _kind: 'block' }))
      ].sort((x, y) => new Date(x.start_at) - new Date(y.start_at));
      const laneEnds = [];
      const bars = list.map((p) => {
        const s = Math.max(+new Date(p.start_at), +rs);
        const e = Math.min(Math.max(+new Date(p.end_at), s + span * 0.035), +re);
        let lane = laneEnds.findIndex((end) => end <= s);
        if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
        laneEnds[lane] = e;
        const left = ((s - rs) / span) * 100;
        const width = ((e - s) / span) * 100;
        const tip = `${p._kind === 'block' ? 'Machine bloquée : ' : ''}${p.title} – ${fmtDateTime(p.start_at)} → ${fmtDateTime(p.end_at)}${clashes.has(p.id) ? ' (chevauchement)' : ''}`;
        return `<button type="button" class="bar ${p.status}${clashes.has(p.id) ? ' clash' : ''}" data-act="edit" data-kind="${p._kind}" data-id="${p.id}" style="left:${left}%;width:${Math.min(width, 100 - left)}%;top:${8 + lane * 34}px" title="${esc(tip)}">${esc(p.title)}</button>`;
      }).join('');
      const height = Math.max(64, laneEnds.length * 34 + 14);
      const now = nowPct >= 0 && nowPct <= 100 ? `<div class="tl-now" style="left:${nowPct}%"></div>` : '';
      return `<div class="tl-row"><div class="tl-label"><span>${esc(m.name)}${m.id ? liveBadge(m.id) : ''}</span></div>
        <div class="tl-track" data-machine="${m.id}" style="height:${height}px">${weekendDivs}${now}${bars}</div></div>`;
    }).join('');

    return `<div class="tl"><div class="tl-row"><div class="tl-label"></div><div class="tl-days">${head}</div></div>${body}</div>${maintenanceHtml()}${templatesHtml()}`;
  }

  function maintenanceHtml() {
    const rules = state.maintenance_rules.slice().sort((x, y) => ruleProgress(y).pct - ruleProgress(x).pct);
    const due = dueRules().length;
    const rows = rules.map((r) => {
      const { h, pct } = ruleProgress(r);
      const cls = pct >= 100 ? 'due' : pct >= 90 ? 'soon' : '';
      return `<div class="maint-row ${cls}"><button type="button" class="tl-item" data-act="edit" data-kind="maintenance" data-id="${r.id}"><span class="ti-main">${esc(r.name)}</span>
        <span class="sub">${esc(machineName(r.machine_id))}, tous les ${esc(fmtNum(r.every_h))} h, dernier le ${esc(fmtShort(new Date(r.last_done_at)))}</span></button>
        <div class="maint-prog"><span class="strack"><span class="sfill" style="width:${Math.min(100, pct)}%"></span></span><span class="mt">${esc(fmtNum(Math.round(h * 10) / 10))} / ${esc(fmtNum(r.every_h))} h</span></div>
        <button type="button" class="btn btn-small" data-act="maint-done" data-id="${r.id}">Fait</button></div>`;
    }).join('');
    return `<section class="panel maint"><header><h3>Entretien des machines</h3><span class="count">${due ? `${due} à faire` : rules.length}</span></header>
      ${rows || '<div class="empty-day">Aucun entretien programmé. Crée-en un avec « + Entretien » : par exemple graisser les axes toutes les 200 h.</div>'}</section>`;
  }

  function templatesHtml() {
    const list = state.print_templates.slice().sort((x, y) => x.name.localeCompare(y.name, 'fr'));
    const rows = list.map((t) => {
      const uses = state.material_uses.filter((u) => u.template_id === t.id);
      const mats = uses.map((u) => { const m = materialById(u.material_id); return m ? `${m.name} ${fmtNum(u.qty)} ${unitFor(m, u.qty)}` : ''; }).filter(Boolean).join(', ');
      const cost = costOfRows(uses).total;
      return `<div class="tpl-row"><button type="button" class="tl-item" data-act="edit" data-kind="template" data-id="${t.id}"><span class="ti-main">${esc(t.name)}</span>
        <span class="sub">${esc(t.machine_id ? machineName(t.machine_id) : 'Toutes les machines')}, ${esc(fmtNum(t.duration_h))} h${mats ? `, ${esc(mats)}` : ''}${cost > 0 ? `, matière ${esc(fmtMoney(cost))}` : ''}</span></button>
        <button type="button" class="btn btn-small" data-act="use-template" data-id="${t.id}">Créer l’impression</button></div>`;
    }).join('');
    return `<section class="panel tpl"><header><h3>Modèles d’impression</h3><span class="count">${list.length}</span></header>
      ${rows || '<div class="empty-day">Aucun modèle. Crée-en un avec « + Modèle », ou depuis une impression avec « Enregistrer comme modèle ».</div>'}</section>`;
  }

  /* ------------------------------------------------------------------ */
  /*  Vue : commandes                                                    */
  /* ------------------------------------------------------------------ */
  const ORDER_STATUS = [['todo', 'À faire'], ['doing', 'En cours'], ['done', 'Terminé']];

  function ordersHtml() {
    const todayKey = ymd(new Date());
    const cols = ORDER_STATUS.map(([status, label]) => {
      const list = state.orders.filter((o) => o.status === status).filter(orderMatchesFilter).sort((a, b) => {
        if (status !== 'done') { const pu = (b.priority === 'urgent') - (a.priority === 'urgent'); if (pu) return pu; }
        if (status === 'done') return new Date(b.updated_at) - new Date(a.updated_at);
        if (!a.due_date && !b.due_date) return new Date(a.created_at) - new Date(b.created_at);
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return a.due_date.localeCompare(b.due_date);
      });
      const cards = list.map((o) => {
        const atts = state.attachments.filter((a) => a.parent_type === 'order' && a.parent_id === o.id);
        const files = atts.filter((a) => !a.kind || a.kind === 'file').length;
        const photos = atts.length - files;
        const prints = state.prints.filter((p) => p.order_id === o.id).length;
        const late = o.due_date && o.status !== 'done' && o.due_date < todayKey;
        const cost = orderCost(o.id);
        const nComments = commentsOf(o.id).length;
        const nNew = unreadOf(o.id);
        const meta = [
          o.priority === 'urgent' ? '<span class="tag urgent">Urgent</span>' : '',
          o.due_date ? `<span class="${late ? 'late' : ''}">Échéance ${esc(fmtShort(parseYmd(o.due_date)))}${late ? ' (en retard)' : ''}</span>` : '',
          o.price_chf != null ? `<span>${esc(fmtMoney(o.price_chf))}</span>` : '',
          cost.total > 0 ? `<span title="Coût de la matière utilisée">Matière ${esc(fmtMoney(cost.total))}</span>` : '',
          prints ? `<span>${prints} impression${prints > 1 ? 's' : ''}</span>` : '',
          files ? `<span>${files} fichier${files > 1 ? 's' : ''}</span>` : '',
          photos ? `<span>${photos} photo${photos > 1 ? 's' : ''}</span>` : '',
          nComments ? `<span>${nComments} commentaire${nComments > 1 ? 's' : ''}</span>` : '',
          nNew ? `<span class="newc">${nNew} nouveau${nNew > 1 ? 'x' : ''}</span>` : ''
        ].join('');
        return `<button type="button" class="card" draggable="true" data-act="edit" data-kind="order" data-id="${o.id}">
          <span class="client">${esc(o.client || o.title)}</span>
          ${o.client ? `<span class="what">${esc(o.title)}</span>` : ''}
          ${meta ? `<span class="meta">${meta}</span>` : ''}
          ${(o.tags || []).length ? `<span class="chips">${o.tags.map((t) => `<span class="tagchip">${esc(t)}</span>`).join('')}</span>` : ''}</button>`;
      }).join('');
      return `<section class="col" data-status="${status}">
        <header><span>${label}</span><span class="count">${list.length}</span></header>
        <div class="cards">${cards || '<div class="col-empty">Aucune commande</div>'}</div></section>`;
    }).join('');
    return `<div class="board">${cols}</div>`;
  }

  /* ------------------------------------------------------------------ */
  /*  Aide intégrée et visite guidée                                     */
  /* ------------------------------------------------------------------ */
  const HELP_GROUPS = ['Premiers pas', 'Commandes et clients', 'Machines et impressions', 'Stock et matières', 'Équipe', 'Atelier et imprimantes', 'Réglages et autres', 'Dépannage'];
  const HELP = [
    { id: 'start', g: 0, t: 'Comment l’appli est organisée', k: 'menu navigation nouveau historique corbeille partage',
      b: ['Le menu à gauche donne accès à toutes les pages. Sur téléphone, touche le bouton à trois traits en haut à gauche.',
        '- Tout est **partagé en direct** : ce qu’un collègue modifie apparaît chez les autres en quelques secondes.',
        '- Tout le monde peut tout modifier. L’**Historique** garde la trace de qui a changé quoi, et la **Corbeille** garde 30 jours ce qui a été supprimé.',
        '- Le bouton **+ Nouveau** (page Aujourd’hui et Calendrier) crée une tâche, un rendez-vous, une impression, une commande, un blocage ou une disponibilité.',
        '- **Ctrl + K** (ou le bouton Rechercher) retrouve n’importe quoi : commande, client, pièce, fichier, commentaire.',
        '- Une pastille rouge sur un onglet signale quelque chose à regarder : nouveaux commentaires, stock bas, entretien à faire.',
        '- Le bouton **?** en haut à droite de chaque page (ou la touche **F1**) ouvre l’aide de la page.'] },
    { id: 'today', g: 0, t: 'La page Aujourd’hui', k: 'accueil machines taches echeances',
      b: ['Elle rassemble ce qui compte maintenant :',
        '- l’état de chaque machine, avec la progression en direct si les imprimantes sont connectées ;',
        '- les impressions du jour, tes tâches et rendez-vous, les commandes à rendre dans les 3 jours ;',
        '- les stocks bas, les bobines chargées, les entretiens à prévoir, les nouveaux commentaires ;',
        '- qui est présent ou absent aujourd’hui.',
        'Un clic sur une ligne ouvre l’élément concerné.'] },
    { id: 'calendar', g: 0, t: 'Le calendrier', k: 'mois semaine agenda rendez-vous',
      b: ['Deux vues : **Mois** et **Semaine**. Les rendez-vous sont en rouge, les impressions en gris-bleu, les échéances de commandes ont un cadre rouge, les absences et blocages de machines sont hachurés.',
        '- **Double-clic** sur un jour pour y ajouter une tâche (sur écran tactile : bouton + Nouveau).',
        '- Touche le numéro d’un jour pour voir sa semaine.'] },
    { id: 'search', g: 0, t: 'Recherche et codes QR', k: 'ctrl k scanner lecteur code retrouver telephone appareil photo qr etiquette',
      b: ['**Ctrl + K** ouvre la recherche. Elle fouille les commandes, clients, impressions, tâches, matières, bobines, modèles, commentaires et noms de fichiers, sans tenir compte des accents.',
        '- **Entrée** ouvre le premier résultat.',
        '- Avec un lecteur de codes USB, scanne une étiquette n’importe où dans l’appli : la commande, la matière ou la bobine s’ouvre toute seule.',
        '- Sans lecteur, tape le code écrit sous le QR (par exemple D3D:C:abcdef12).',
        '- **Avec le téléphone** : le QR des étiquettes contient l’adresse de l’appli web. Scanne-le avec l’appareil photo (iPhone ou Android) : la commande, la bobine ou la matière s’ouvre dans l’appli web. La première fois, connecte-toi avec ton compte d’équipe ; ensuite la session reste ouverte.',
        '- Les étiquettes imprimées avant la version 2.9.0 ne contiennent que le code : elles marchent avec un lecteur USB ou Ctrl + K, mais pas avec l’appareil photo d’un téléphone. Réimprime-les pour qu’elles s’ouvrent au scan.'] },

    { id: 'orders', g: 1, t: 'Les commandes', k: 'commande etat priorite etiquette prix photos fichiers qr cout matiere',
      b: ['Une commande a un client, un objet, une échéance, un prix, des étiquettes (laser, cadeau…) et une **priorité** : les urgentes passent en tête de colonne.',
        '- Dans le tableau, **glisse** une commande d’une colonne à l’autre pour changer son état (À faire, En cours, Terminé). Sur tablette ou téléphone, ouvre la commande et change l’état dedans.',
        '- Dans la commande : les **matières ajoutées** (vis, colle…) avec le coût matière et ce qu’il reste sur le prix de vente, les **photos avant / après**, les **fichiers** (STL, plans), les **commentaires** de l’équipe, l’**Étiquette QR** et **Planifier les impressions**.',
        '- Les filtres en haut du tableau : Toutes / Urgentes, et par étiquette.',
        '- Quand une commande passe à **Terminé**, ses matières ajoutées sont déduites du stock. Si tu la remets en arrière, elles sont rendues.'] },
    { id: 'clients', g: 1, t: 'Les clients', k: 'fiche client telephone adresse facturation export csv exporter',
      b: ['Une fiche par client : téléphone, e-mail, adresse, notes, et la liste de ses commandes avec le total.',
        '- Dans une commande, choisis la **Fiche client** : le nom se remplit tout seul.',
        '- Si tes commandes ont déjà des noms de clients, le bouton **Créer les fiches depuis les commandes** crée les fiches et relie tout en une fois.',
        '- **Envoyer vers la facturation** : envoie tes clients (nom, e-mail, téléphone, adresse, NPA, localité) directement dans la base de l’application de facturation. Connecte-toi une fois avec ton compte de la facturation ; l’appli te montre ce qui sera créé, puis tu confirmes. Les clients déjà présents ne sont jamais dupliqués ni écrasés (leurs infos manquantes peuvent être complétées).',
        '- Autres méthodes dans la même fenêtre : script SQL à coller dans Supabase de la facturation, ou fichier CSV.'] },
    { id: 'comments', g: 1, t: 'Commentaires, photos et fichiers d’une commande', k: 'message equipe avant apres stl pastille nouveau',
      b: ['- **Commentaires** : écris un message à l’équipe en bas de la commande (Ctrl + Entrée pour envoyer). Une pastille rouge signale les nouveaux, et chacun a sa propre lecture.',
        '- **Photos avant / après** : « Ajouter » dans la zone Avant ou Après. Un clic sur une miniature l’agrandit. Les photos sont réduites automatiquement pour ne pas remplir le stockage.',
        '- **Fichiers joints** : STL, plans, documents. Enregistre d’abord une nouvelle commande avant d’y ajouter des photos ou des commentaires.'] },

    { id: 'machines', g: 2, t: 'Machines, impressions et blocages', k: 'frise impression planifiee terminee echec blocage chevauchement modele',
      b: ['La frise montre 14 jours par machine.',
        '- **Double-clic** sur une machine, ou **+ Impression**, pour planifier une impression.',
        '- Une impression est **Planifiée**, **En impression**, **Terminée** ou en **Échec** (avec sa cause).',
        '- Note les **matières utilisées** : le stock baisse quand l’impression passe à Terminée ou Échec.',
        '- **+ Blocage** réserve une machine (entretien, panne). Si une impression en chevauche une autre ou un blocage, l’appli te prévient et la frise l’entoure de rouge.',
        '- **+ Modèle** enregistre une pièce refaite souvent (machine, durée, matières) ; **Créer l’impression** la replanifie en un clic. Dans une impression existante : **Enregistrer comme modèle**.'] },
    { id: 'planner', g: 2, t: 'La planification automatique', k: 'planifier automatique echeance creneau machine',
      b: ['**Planifier** (page Machines) ou **Planifier les impressions** (dans une commande).',
        '- Indique chaque pièce : nom, durée en heures, nombre d’exemplaires, machine imposée ou non. Tu peux aussi partir d’un modèle.',
        '- **Proposer un planning** place chaque pièce sur la machine qui la termine le plus tôt, sans toucher aux impressions existantes ni aux blocages, et dit si l’échéance est tenue.',
        '- Tu choisis les heures de démarrage (une impression peut tourner la nuit) et si les week-ends comptent. **Créer les impressions** les ajoute.'] },
    { id: 'failures', g: 2, t: 'Les échecs d’impression', k: 'echec cause gaspillage taux reussite',
      b: ['Passe l’impression à **Échec** et indique la cause (décollement du plateau, bourrage, filament, coupure de courant…).',
        '- Le filament noté sur l’impression est compté comme perdu : le stock baisse.',
        '- Les **Statistiques** montrent le taux de réussite, la matière perdue (en grammes et en francs) et les causes les plus fréquentes.'] },
    { id: 'maintenance', g: 2, t: 'L’entretien selon les heures', k: 'entretien buse axes graisser heures',
      b: ['Page Machines, **+ Entretien** : par exemple graisser les axes tous les 200 h, changer la buse tous les 100 h.',
        '- L’appli additionne les heures d’impression de la machine depuis le dernier entretien et affiche une barre de progression.',
        '- À 100 %, l’entretien est « à faire » : pastille rouge sur Machines, bloc sur Aujourd’hui et rappel le matin.',
        '- Le bouton **Fait** remet le compteur à zéro.'] },

    { id: 'stock', g: 3, t: 'Le stock de matières', k: 'matiere filament bois seuil racheter ajuster',
      b: ['Trois catégories : filaments (en grammes), bois et plaques, autres consommables. **+ Matière** : nom, unité, quantité, seuil d’alerte et prix (par exemple 25 CHF pour 1000 g).',
        '- Le stock **baisse automatiquement** quand une impression ou une commande passe à Terminée, et remonte si tu la remets en arrière.',
        '- **Ajuster** : achat, perte ou correction, inventaire. Chaque mouvement est gardé.',
        '- Sous le seuil, la matière apparaît dans **À racheter** avec une quantité proposée ; **Copier la liste** la prépare pour ton fournisseur.'] },
    { id: 'spools', g: 3, t: 'Les bobines individuelles', k: 'bobine charger machine reste grammes',
      b: ['**+ Bobine** : matière, nom ou numéro, poids neuf, reste, machine.',
        '- **Charger / Décharger** indique dans quelle machine elle est.',
        '- Quand une impression est terminée, le stock de la matière **et** la bobine chargée dans la machine baissent.',
        '- Dans une impression, l’appli indique la bobine utilisée et te prévient si elle ne suffit pas. Sous le seuil (100 g par défaut), tu es prévenu.',
        '- Le reste de la bobine est le sien ; le stock de la matière compte tout ce que tu possèdes.'] },
    { id: 'filaments', g: 3, t: 'Le gestionnaire de filaments', k: 'filament bobine couleur marque peser pesee balance secher sechage catalogue emplacement humidite temperature',
      b: ['Page **Filaments** : deux onglets, **Bobines** (ce que tu as sur l’étagère) et **Catalogue** (les références).',
        '- **+ Filament** crée une référence : marque, matière (PLA, PETG, ABS, ASA, TPU, PA, PC, PVA), couleur et teinte, diamètre, températures de buse et de plateau, séchage conseillé, prix. Les températures se proposent toutes seules selon la matière (valeurs indicatives, la notice du fabricant fait foi).',
        '- **+ Bobine** crée l’objet physique : poids neuf et reste, poids de la bobine vide, prix payé, fournisseur, emplacement (étagère, boîte), dates d’achat, d’ouverture et de séchage. Coche « ajouter au stock » si l’achat n’est pas encore compté.',
        '- **Peser** : pose la bobine sur une balance et saisis le poids ; l’appli retire le poids de la bobine vide et corrige le reste (le stock suit).',
        '- **Séchée** note le séchage du jour. Un filament qui craint l’humidité (PETG, TPU, PA, PC, PVA) ouvert depuis plus de 30 jours sans séchage affiche « À sécher ? », sauf s’il est « stocké au sec ».',
        '- Les filtres (en service, chargées, en réserve, bientôt vides, à sécher, terminées), le type et la recherche retrouvent une bobine par sa marque, sa couleur ou son emplacement.',
        '- En haut : le nombre de bobines, le poids de filament restant et la valeur du stock.'] },
    { id: 'labels', g: 3, t: 'Les étiquettes QR', k: 'etiquette qr imprimer brother dymo a4',
      b: ['Bouton **Étiquette QR** dans une commande, une matière ou une bobine.',
        '- Choisis le format (rouleau 62 × 29 mm, 50 × 30, 70 × 40 ou feuille A4) et le nombre d’exemplaires, puis **Imprimer**.',
        '- La boîte d’impression de Windows s’ouvre : tu peux aussi enregistrer en PDF.',
        '- Scanner l’étiquette ouvre l’élément (voir « Recherche et codes QR »).'] },

    { id: 'tasks', g: 4, t: 'Tâches et rendez-vous', k: 'tache rendez-vous repetition recurrente machine rappel',
      b: ['- Une tâche peut avoir une date, un responsable et une machine concernée.',
        '- **Répétition** : chaque jour, semaine ou mois. Quand tu coches la tâche, la suivante est créée toute seule, jamais dans le passé.',
        '- Un rappel Windows te prévient avant une tâche ou un rendez-vous (délai réglable dans Réglages).'] },
    { id: 'team', g: 4, t: 'Équipe et disponibilités', k: 'absence present vacances',
      b: ['La page Équipe montre la semaine de chacun. Clique sur une case pour indiquer **Présent**, **Partiel** ou **Absent**, avec une note.',
        'Les absences apparaissent aussi dans le calendrier et sur la page Aujourd’hui.'] },
    { id: 'volunteers', g: 4, t: 'Les heures de bénévolat', k: 'benevole heures membre association',
      b: ['**+ Heures** : membre, date, heures, activité, note. Le membre est un simple nom : il n’a pas besoin de compte.',
        '- Les noms déjà utilisés sont proposés, et « léa » et « Léa » sont regroupés.',
        '- La page montre le total, la moyenne, le membre le plus actif, et les heures par membre et par activité, sur le mois, 3 mois ou l’année.'] },

    { id: 'atelier', g: 5, t: 'L’affichage atelier', k: 'plein ecran television tablette ecran fixe',
      b: ['Page **Affichage atelier**, bouton **Plein écran** : pour une tablette ou une télé fixée à l’atelier.',
        '- Il montre chaque machine avec sa barre de progression, le travail en cours et le suivant, l’horloge, les tâches et commandes à rendre, les alertes et l’équipe du jour.',
        '- Il se met à jour tout seul et garde l’écran allumé. **Échap** quitte le plein écran.',
        '- Sur une tablette : ajoute **#atelier** à l’adresse de l’application web pour qu’elle s’ouvre directement dans ce mode.'] },
    { id: 'printers', g: 5, t: 'Connecter les imprimantes', k: 'imprimante wifi bambu klipper moonraker relais ip',
      b: ['Un ordinateur de l’atelier (celui qui reste allumé) lit les imprimantes du Wi-Fi et partage leur état avec toute l’équipe. C’est de la lecture seule : rien n’est envoyé aux imprimantes.',
        '- Sur cet ordinateur : **Réglages > Imprimantes**. Coche « Cet ordinateur relaie… », puis **Chercher les imprimantes sur le Wi-Fi** et clique sur **Utiliser**.',
        '- Bambu Lab : il faut le mode « réseau local » et le code d’accès. Creality K1 et Elegoo Neptune 4 : l’adresse IP suffit.',
        '- **Tester**, puis **Enregistrer les imprimantes**.',
        '- Avec « Mettre à jour les impressions automatiquement », une impression planifiée passe à En impression au démarrage, puis à Terminée à la fin.'] },

    { id: 'settings', g: 6, t: 'Réglages et rappels', k: 'notification rappel demarrage windows horloge',
      b: ['Bouton **Réglages** en bas à gauche.',
        '- Rappels : avant une tâche, impression à vérifier, commandes à rendre, stock ou bobine bas, entretien, commentaires, fin ou erreur d’impression.',
        '- « Garder l’application active en fermant la fenêtre » : elle reste près de l’horloge pour envoyer les rappels. Pour la quitter vraiment : clic droit sur son icône, puis Quitter.',
        '- « Lancer l’application au démarrage de Windows » : pratique pour l’ordinateur de l’atelier.'] },
    { id: 'mobile', g: 6, t: 'Tablette et téléphone', k: 'android iphone ipad installer ecran accueil web',
      b: ['La version web s’ouvre dans le navigateur et s’installe sur l’écran d’accueil.',
        '- Android (Chrome) : menu ⋮, puis « Installer l’application ». iPhone et iPad (Safari) : bouton Partager, puis « Sur l’écran d’accueil ».',
        '- Au doigt, le glisser-déposer des commandes ne marche pas : ouvre la commande pour changer son état.',
        '- Les notifications se règlent dans Réglages > « Autoriser les notifications ».'] },
    { id: 'stats', g: 6, t: 'Les statistiques', k: 'chiffre affaires delai heures occupation clients',
      b: ['Choisis la période (30 jours, 3 mois, 12 mois). Tu y trouves les commandes terminées, le chiffre d’affaires, le coût matière, les heures d’impression et l’occupation des machines, le délai moyen, les commandes rendues à l’heure, le taux de réussite, les échecs, les meilleurs clients et les matières les plus utilisées.',
        'Les heures comptent les impressions En impression, Terminée ou en Échec : pense à passer une impression à Terminée.'] },
    { id: 'history_trash', g: 6, t: 'Historique et corbeille', k: 'supprimer restaurer annuler modification',
      b: ['- **Historique** : qui a créé, modifié ou supprimé quoi, et quand (les 200 dernières actions).',
        '- **Corbeille** : une commande, tâche, impression, client ou modèle supprimé y reste 30 jours. **Restaurer** le remet avec ses matières, commentaires, photos et fichiers.'] },

    { id: 'fix-blank', g: 7, t: 'L’appli affiche un écran vide ou une erreur', k: 'ecran blanc noir vide erreur demarrer',
      b: ['L’application affiche maintenant un message d’erreur avec un bouton **Copier le message**. Tes données ne sont pas touchées : elles sont dans Supabase.',
        '- Installe la dernière version de l’application, ou ré-ouvre-la une fois connecté à internet : elle se met à jour toute seule.',
        '- Envoie-moi le message copié si le problème continue.'] },
    { id: 'fix-schema', g: 7, t: '« Base non initialisée » ou une page qui affiche une erreur', k: 'sql supabase schema mise a jour table',
      b: ['Après une mise à jour, il faut parfois relancer le script de la base : dans Supabase, **SQL Editor > New query**, colle tout le contenu de **supabase-schema.sql**, puis **Run**.',
        'Le script peut être relancé sans danger autant de fois que nécessaire.'] },
    { id: 'fix-printers', g: 7, t: 'Une imprimante est « hors ligne » ou introuvable', k: 'imprimante hors ligne wifi test adresse',
      b: ['- L’ordinateur relais doit être allumé, avec l’appli ouverte (elle peut rester près de l’horloge), sur le **même Wi-Fi** que les imprimantes (pas le réseau invité).',
        '- Dans la box, l’option « isolation des appareils » doit être désactivée. Réserve une adresse IP fixe pour chaque imprimante.',
        '- Bambu Lab : le mode « réseau local » doit être activé et le code d’accès exact.',
        '- Réglages > Imprimantes > **Tester** affiche la cause.'] },
    { id: 'fix-notif', g: 7, t: 'Je ne reçois pas les rappels', k: 'notification rappel windows silence',
      b: ['- Vérifie dans Réglages que les rappels sont activés, et le type de rappel voulu.',
        '- Les rappels n’arrivent que si l’application est ouverte ou active près de l’horloge (option « Garder l’application active »).',
        '- Dans Windows : Paramètres > Système > Notifications, et désactive le mode « Ne pas déranger ».',
        '- Sur téléphone : Réglages > Autoriser les notifications ; sur iPhone, installe d’abord l’appli sur l’écran d’accueil.'] },
    { id: 'fix-sync', g: 7, t: 'Les données ne se mettent pas à jour', k: 'synchronisation hors ligne internet',
      b: ['Le voyant en bas à gauche indique **Synchronisé en direct** ou **Hors ligne**.',
        '- Hors ligne : vérifie la connexion internet. L’appli recharge les données toute seule au retour du réseau.',
        '- Sur un téléphone en veille, les données se rechargent quand tu rouvres l’appli.',
        '- En cas de doute, ferme et rouvre l’application.'] }
  ];
  const HELP_BY_VIEW = { today: 'today', atelier: 'atelier', calendar: 'calendar', machines: 'machines', orders: 'orders', clients: 'clients', stock: 'stock', filaments: 'filaments', tasks: 'tasks', team: 'team', volunteers: 'volunteers', stats: 'stats', history: 'history_trash', trash: 'history_trash', help: 'start' };

  const helpMd = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  function helpBody(lines) {
    let html = '';
    let list = [];
    const flush = () => { if (list.length) { html += `<ul>${list.join('')}</ul>`; list = []; } };
    lines.forEach((l) => { if (l.startsWith('- ')) list.push(`<li>${helpMd(l.slice(2))}</li>`); else { flush(); html += `<p>${helpMd(l)}</p>`; } });
    flush();
    return html;
  }

  function helpResultsHtml(q) {
    const terms = norm(q).split(/\s+/).filter(Boolean);
    const hit = (h) => terms.every((t) => norm(`${h.t} ${h.k} ${h.b.join(' ')}`).includes(t));
    const groups = HELP_GROUPS.map((name, gi) => ({ name, items: HELP.filter((h) => h.g === gi && (!terms.length || hit(h))) })).filter((g) => g.items.length);
    if (!groups.length) return `<div class="empty">Aucun article ne correspond à « ${esc(q)} ». Essaie un autre mot, ou ouvre la visite guidée.</div>`;
    return groups.map((g) => `<section class="help-group"><h3>${esc(g.name)}</h3>${g.items.map((h) => `
      <details class="help-item" id="help-${h.id}" ${terms.length || state.helpOpen === h.id ? 'open' : ''}><summary>${esc(h.t)}</summary><div class="help-body">${helpBody(h.b)}</div></details>`).join('')}</section>`).join('');
  }

  function helpHtml() {
    const open = state.helpOpen;
    const html = `<div class="help-top">
        <div class="help-card"><h3>Visite guidée</h3><p>Fais le tour de l’application en 2 minutes : on te montre les vrais boutons, page après page.</p><button type="button" class="btn btn-primary" data-act="tour">Lancer la visite guidée</button></div>
        <div class="help-card"><h3>Raccourcis</h3><ul class="help-keys"><li><kbd>Ctrl</kbd> + <kbd>K</kbd> recherche</li><li><kbd>F1</kbd> aide de la page</li><li><kbd>Échap</kbd> ferme une fenêtre</li><li>Scanner un QR ouvre l’élément</li></ul></div>
      </div>
      <label class="field help-search"><span>Chercher dans l’aide</span><input id="help-search" type="search" placeholder="Par exemple : bobine, rappel, imprimante, photo…" value="${esc(state.helpQuery)}" autocomplete="off"></label>
      <div id="help-results">${helpResultsHtml(state.helpQuery)}</div>`;
    if (open) setTimeout(() => { const el = document.getElementById(`help-${open}`); if (el) { el.open = true; if (el.scrollIntoView) el.scrollIntoView({ block: 'start' }); } state.helpOpen = ''; }, 30);
    return `<div class="help-page">${html}</div>`;
  }

  function openHelp(id) {
    const h = HELP.find((x) => x.id === id) || HELP[0];
    $('#layer-root').innerHTML = `
      <div class="overlay layer" id="help-overlay">
        <div class="modal help" role="dialog" aria-modal="true" aria-label="Aide">
          <div class="modal-head"><h3>${esc(h.t)}</h3><button type="button" class="btn btn-quiet icon-btn" data-hclose aria-label="Fermer">✕</button></div>
          <div class="modal-body help-body">${helpBody(h.b)}</div>
          <div class="modal-foot"><button type="button" class="btn btn-quiet" data-act="tour" data-hclose>Visite guidée</button><span class="grow"></span>
            <button type="button" class="btn" data-act="help-all" data-id="${h.id}">Toute l’aide</button><button type="button" class="btn btn-primary" data-hclose>Fermer</button></div>
        </div>
      </div>`;
    const close = () => { $('#layer-root').innerHTML = ''; };
    $('#help-overlay').querySelectorAll('[data-hclose]').forEach((b) => b.addEventListener('click', close));
    $('#help-overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'help-overlay') close(); });
  }

  /* ---------- Visite guidée ---------- */
  const TOUR_STEPS = [
    { view: 'today', target: '.side', title: 'Bienvenue !', text: 'Le menu donne accès à toutes les pages de l’atelier. Tout ce que tu fais est partagé avec l’équipe en direct.', side: true },
    { view: 'today', target: '#open-search', title: 'Tout retrouver en un instant', text: 'Ctrl + K (ou ce bouton) cherche une commande, un client, une pièce, un fichier… Avec un lecteur de codes, scanner une étiquette QR ouvre l’élément.', side: true },
    { view: 'today', target: '.today-grid', title: 'Aujourd’hui', text: 'Ta page de départ : machines, impressions du jour, tâches, commandes à rendre, stocks bas, entretiens, nouveaux commentaires. Un clic ouvre l’élément.' },
    { view: 'orders', target: '.board', title: 'Les commandes', text: 'Glisse une commande d’une colonne à l’autre pour changer son état. Ouvre-la pour ajouter matières, photos avant / après, fichiers, commentaires et étiquette QR.' },
    { view: 'orders', target: '.top .btn-primary', title: 'Créer une commande', text: '« + Commande » : client, objet, échéance, prix, priorité et étiquettes. Pense à choisir la fiche client.' },
    { view: 'machines', target: '.tl', title: 'Les machines', text: 'La frise montre 14 jours par machine. Double-clic sur une machine pour planifier une impression. Les conflits sont entourés de rouge.' },
    { view: 'machines', target: '.top [data-act="plan"]', title: 'Planification automatique', text: 'Indique les pièces à imprimer : l’appli propose la machine et l’heure qui terminent le plus tôt, en tenant compte de l’échéance.' },
    { view: 'stock', target: '.list', title: 'Le stock', text: 'Filaments, bois, consommables et bobines. Le stock baisse tout seul quand une impression passe à « Terminée », et « À racheter » prépare ta commande fournisseur.' },
    { view: 'filaments', target: '.fil-kpis', title: 'Les filaments', text: 'Chaque bobine avec sa couleur, ce qu’il reste (« Peser » pour le corriger avec une balance), son emplacement et son séchage. Le catalogue garde marque, températures et prix.' },
    { view: 'tasks', target: '.list', title: 'Les tâches', text: 'Coche une tâche pour la terminer. Une tâche répétée (nettoyage, entretien) se recrée toute seule.' },
    { view: 'volunteers', target: '.kpis', title: 'Le bénévolat', text: '« + Heures » : le membre est un simple nom, sans compte nécessaire. Les totaux se calculent par membre et par activité.' },
    { view: 'atelier', target: '.atelier', title: 'L’affichage atelier', text: 'Pour une tablette ou une télé à l’atelier : machines, progression, échéances et alertes en grand, mis à jour tout seul. Bouton « Plein écran ».' },
    { view: 'atelier', target: '#open-settings', title: 'Réglages et rappels', text: 'Choisis tes rappels, et sur l’ordinateur de l’atelier connecte les imprimantes du Wi-Fi pour voir leur progression en direct.', side: true },
    { view: 'help', target: '.help-top', title: 'Tu n’es jamais bloqué', text: 'Le bouton « ? » de chaque page (ou la touche F1) donne l’aide du moment, et cette page contient tout, avec une recherche et un coin dépannage.' }
  ];
  let tour = null;
  const tourKey = () => `dayan_tour_${state.me ? state.me.id : 'x'}`;
  const isNarrow = () => window.matchMedia && window.matchMedia('(max-width: 900px)').matches;

  function startTour() {
    $('#layer-root').innerHTML = '';
    $('#tour-root').innerHTML = '';
    if (document.body.classList.contains('kiosk')) exitKiosk();
    tour = { i: 0 };
    tourShow();
  }
  function endTour(finished) {
    tour = null;
    $('#tour-root').innerHTML = '';
    document.body.classList.remove('nav-open');
    try { localStorage.setItem(tourKey(), 'done'); } catch (e) { /* ignoré */ }
    if (finished) toast('Visite terminée. Le bouton « ? » est toujours là en cas de doute.');
    window.removeEventListener('resize', tourPlace);
  }
  function tourGo(d) {
    if (!tour) return;
    const next = tour.i + d;
    if (next < 0) return;
    if (next >= TOUR_STEPS.length) { endTour(true); return; }
    tour.i = next;
    tourShow();
  }
  function tourShow() {
    const s = TOUR_STEPS[tour.i];
    if (s.view && state.view !== s.view) { state.view = s.view; render(); const v = $('#view'); if (v) v.scrollTop = 0; }
    if (isNarrow()) document.body.classList.toggle('nav-open', !!s.side); else document.body.classList.remove('nav-open');
    window.addEventListener('resize', tourPlace);
    setTimeout(tourPlace, isNarrow() && s.side ? 260 : 40);
  }
  function tourPlace() {
    if (!tour) return;
    const s = TOUR_STEPS[tour.i];
    const total = TOUR_STEPS.length;
    const el = s.target ? document.querySelector(s.target) : null;
    const r = el ? el.getBoundingClientRect() : null;
    const vw = window.innerWidth, vh = window.innerHeight;
    const usable = r && r.width > 0 && r.height > 0;
    const pad = 6;
    const spot = usable ? `<div class="tour-spot" style="left:${Math.max(0, r.left - pad)}px;top:${Math.max(0, r.top - pad)}px;width:${Math.min(vw, r.width + pad * 2)}px;height:${Math.min(vh, r.height + pad * 2)}px"></div>` : '';
    const w = Math.min(360, vw - 24);
    let left = 12, top = 12;
    if (usable) {
      const tall = r.height > vh * 0.6;
      if (!tall && r.bottom + 190 < vh) { top = r.bottom + 14; left = Math.min(Math.max(12, r.left), vw - w - 12); }
      else if (!tall && r.top > 200) { top = Math.max(12, r.top - 200); left = Math.min(Math.max(12, r.left), vw - w - 12); }
      else if (r.right + w + 24 < vw) { left = r.right + 16; top = Math.min(Math.max(12, r.top + 12), vh - 240); }
      else { top = vh - 230; left = Math.max(12, (vw - w) / 2); }
    } else { top = Math.max(12, vh / 2 - 110); left = Math.max(12, (vw - w) / 2); }
    $('#tour-root').innerHTML = `<div class="tour-block"></div>${spot}
      <div class="tour-card" role="dialog" aria-label="Visite guidée" style="left:${left}px;top:${top}px;width:${w}px">
        <div class="tour-step">Étape ${tour.i + 1} sur ${total}</div><h4>${esc(s.title)}</h4><p>${esc(s.text)}</p>
        <div class="tour-actions"><button type="button" class="btn btn-quiet btn-small" data-act="tour-quit">Quitter</button><span class="grow"></span>
          ${tour.i > 0 ? '<button type="button" class="btn btn-small" data-act="tour-prev">Précédent</button>' : ''}
          <button type="button" class="btn btn-small btn-primary" data-act="tour-next">${tour.i === total - 1 ? 'Terminer' : 'Suivant'}</button></div></div>`;
  }

  // première visite : on propose la visite guidée, sans jamais l'imposer
  function maybeOfferTour() {
    if (!state.me || tour || document.body.classList.contains('kiosk')) return;
    let done = null;
    try { done = localStorage.getItem(tourKey()); } catch (e) { /* ignoré */ }
    let later = null;
    try { later = sessionStorage.getItem('dayan_tour_later'); } catch (e) { /* ignoré */ }
    if (done || later || $('#tour-root').innerHTML) return;
    $('#tour-root').innerHTML = `<div class="tour-offer" role="dialog" aria-label="Visite guidée"><h4>Première visite ?</h4>
      <p>Fais le tour de l’application en 2 minutes : on te montre les vrais boutons, page après page.</p>
      <div class="tour-actions"><button type="button" class="btn btn-small btn-primary" data-act="tour-offer-start">Commencer la visite</button>
      <button type="button" class="btn btn-small" data-act="tour-offer-later">Plus tard</button><button type="button" class="btn btn-quiet btn-small" data-act="tour-offer-never">Ne plus proposer</button></div></div>`;
  }
  function dismissOffer(never) {
    $('#tour-root').innerHTML = '';
    if (never) { try { localStorage.setItem(tourKey(), 'done'); } catch (e) { /* ignoré */ } }
    else { try { sessionStorage.setItem('dayan_tour_later', '1'); } catch (e) { /* ignoré */ } }
  }

  /* ------------------------------------------------------------------ */
  /*  Vue : bénévolat                                                    */
  /* ------------------------------------------------------------------ */
  function volunteersHtml() {
    const now = new Date();
    const start = state.volRange === 'year' ? `${now.getFullYear()}-01-01` : state.volRange === 'quarter' ? ymd(addDays(now, -90)) : `${ymd(now).slice(0, 8)}01`;
    const list = state.volunteer_hours.filter((h) => h.day >= start).sort((x, y) => y.day.localeCompare(x.day) || new Date(y.created_at) - new Date(x.created_at));
    const total = list.reduce((s, h) => s + Number(h.hours), 0);
    const by = (keyFn) => {
      const m = new Map();
      list.forEach((h) => {
        const k = keyFn(h);
        const e = m.get(norm(k)) || { name: k, hours: 0, n: 0 };
        if (e.name === e.name.toLowerCase() && k !== k.toLowerCase()) e.name = k; // « léa » et « Léa » : on affiche « Léa »
        e.hours += Number(h.hours);
        e.n += 1;
        m.set(norm(k), e);
      });
      return [...m.values()].sort((x, y) => y.hours - x.hours);
    };
    const members = by((h) => h.member);
    const acts = by((h) => h.activity);
    const maxM = Math.max(1, ...members.map((x) => x.hours));
    const maxA = Math.max(1, ...acts.map((x) => x.hours));
    const meName = norm((state.profiles.find((p) => p.id === state.me.id) || {}).name);
    const fmtHrs = (h) => `${fmtNum(Math.round(h * 100) / 100)} h`;
    const bars = (rows, max, mine) => rows.map((r) => `<div class="srow ${mine && norm(r.name) === meName ? 'me' : ''}"><span class="sl">${esc(r.name)}</span><span class="strack"><span class="sfill" style="width:${(r.hours / max) * 100}%"></span></span><span class="sv">${esc(fmtHrs(r.hours))}<small>${r.n} saisie${r.n > 1 ? 's' : ''}</small></span></div>`).join('');
    const kpi = (l, v, s) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
    const recent = list.slice(0, 15).map((h) => `<button type="button" class="tl-item" data-act="edit" data-kind="volunteer" data-id="${h.id}"><span class="ti-main">${esc(h.member)} : ${esc(fmtHrs(h.hours))}</span>
      <span class="sub">${esc(h.activity)}, ${esc(fmtShort(parseYmd(h.day)))}${h.note ? `, ${esc(h.note)}` : ''}</span></button>`).join('');
    return `<div class="kpis">
        ${kpi('Heures données', esc(fmtHrs(total)), list.length ? `${list.length} saisie${list.length > 1 ? 's' : ''}` : 'Aucune saisie sur la période')}
        ${kpi('Membres actifs', String(members.length), '')}
        ${kpi('Moyenne par membre', members.length ? esc(fmtHrs(total / members.length)) : '–', '')}
        ${kpi('Plus actif', members.length ? esc(members[0].name) : '–', members.length ? esc(fmtHrs(members[0].hours)) : '')}
      </div>
      <div class="today-grid stats-grid">
        <section class="panel"><header><h3>Par membre</h3><span class="count">${members.length}</span></header><div class="spad">${bars(members, maxM, true) || '<div class="empty-day">Aucune heure sur la période</div>'}</div></section>
        <section class="panel"><header><h3>Par activité</h3><span class="count">${acts.length}</span></header><div class="spad">${bars(acts, maxA, false) || '<div class="empty-day">Aucune heure sur la période</div>'}</div></section>
        <section class="panel"><header><h3>Dernières saisies</h3><span class="count">${Math.min(15, list.length)}</span></header>${recent || '<div class="empty-day">Ajoute des heures avec « + Heures ».</div>'}</section>
      </div>`;
  }

  /* ------------------------------------------------------------------ */
  /*  Vue : affichage atelier (écran fixe, tablette ou télé)             */
  /* ------------------------------------------------------------------ */
  function atelierHtml() {
    const now = new Date(), d0 = startOfDay(now), d1 = addDays(d0, 1), todayKey = ymd(now);
    const clock = now.toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit' });
    const date = cap(now.toLocaleDateString('fr-CH', { weekday: 'long', day: 'numeric', month: 'long' }));
    const until = (iso) => { const mins = Math.round((new Date(iso) - now) / 60000); return mins > 0 ? `dans ${fmtRemain(mins)}` : 'maintenant'; };

    const cards = state.machines.map((m) => {
      const blk = state.machine_blocks.find((b) => b.machine_id === m.id && new Date(b.start_at) <= now && new Date(b.end_at) >= now);
      const lv = liveOf(m.id);
      const cur = state.prints.find((p) => p.machine_id === m.id && isActivePrint(p) && (p.status === 'printing' || (new Date(p.start_at) <= now && new Date(p.end_at) >= now)));
      const next = state.prints.filter((p) => p.machine_id === m.id && p.status === 'planned' && new Date(p.start_at) > now).sort((x, y) => new Date(x.start_at) - new Date(y.start_at))[0];
      let cls = 'free', pill = 'Libre', title = '', pct = null, line = '', extra = '';
      if (blk) { cls = 'blocked'; pill = 'Bloquée'; title = blk.reason; line = `jusqu’au ${fmtDateTime(blk.end_at)}`; }
      else if (lv && lv.state === 'printing') {
        cls = 'busy'; pill = 'En impression'; title = lv.file_name || (cur && cur.title) || 'Impression'; pct = Number(lv.progress) || 0;
        line = lv.remaining_min != null ? `Encore ${fmtRemain(lv.remaining_min)}, fin vers ${new Date(Date.now() + lv.remaining_min * 60000).toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit' })}` : '';
        extra = [lv.nozzle_c != null ? `Buse ${Math.round(lv.nozzle_c)}°` : '', lv.bed_c != null ? `Plateau ${Math.round(lv.bed_c)}°` : '', lv.layer != null && lv.total_layers ? `Couche ${lv.layer}/${lv.total_layers}` : ''].filter(Boolean).join('  ');
      } else if (lv && (lv.state === 'paused' || lv.state === 'error')) {
        cls = 'alert'; pill = LIVE_FR[lv.state]; title = lv.file_name || (cur && cur.title) || 'Impression'; pct = Number(lv.progress) || 0; line = lv.state === 'error' ? 'À vérifier à l’imprimante' : 'En attente de reprise';
      } else if (lv && lv.state === 'finished') {
        cls = 'done'; pill = 'Terminée'; title = lv.file_name || (cur && cur.title) || 'Impression'; pct = 100; line = 'À vider';
      } else if (cur) {
        cls = 'busy'; pill = 'En impression'; title = cur.title;
        const s = +new Date(cur.start_at), e = +new Date(cur.end_at);
        pct = Math.max(0, Math.min(100, ((+now - s) / Math.max(1, e - s)) * 100));
        line = `Fin prévue ${fmtTime(cur.end_at)} (${until(cur.end_at)})`;
      }
      const nextTxt = next ? `Ensuite : ${next.title}, ${fmtDayLong(new Date(next.start_at))} ${fmtTime(next.start_at)}` : '';
      return `<div class="at-card ${cls}"><div class="at-top"><span class="at-name">${esc(m.name)}</span><span class="at-pill">${esc(pill)}</span></div>
        ${title ? `<div class="at-job">${esc(title)}</div>` : ''}
        ${pct != null ? `<div class="at-bar"><span style="width:${pct}%"></span><b>${Math.round(pct)} %</b></div>` : ''}
        ${line ? `<div class="at-line">${esc(line)}</div>` : ''}${extra ? `<div class="at-line">${esc(extra)}</div>` : ''}
        ${nextTxt ? `<div class="at-next">${esc(nextTxt)}</div>` : ''}</div>`;
    }).join('');

    const items = [];
    state.tasks.filter((t) => !t.done && t.start_at && new Date(t.start_at) < d1).sort((x, y) => new Date(x.start_at) - new Date(y.start_at)).slice(0, 6)
      .forEach((t) => items.push(`<li><b>${esc(t.title)}</b><span>${t.kind === 'rdv' ? 'Rendez-vous, ' : ''}${esc(sameDay(new Date(t.start_at), now) ? fmtTime(t.start_at) : fmtDateTime(t.start_at))}</span></li>`));
    state.orders.filter((o) => o.status !== 'done' && o.due_date && o.due_date <= ymd(addDays(d0, 3))).sort((x, y) => x.due_date.localeCompare(y.due_date)).slice(0, 6)
      .forEach((o) => { const diff = Math.round((parseYmd(o.due_date) - d0) / 864e5); items.push(`<li class="${diff < 0 ? 'bad' : ''}"><b>${esc(orderLabel(o))}</b><span>${diff < 0 ? `en retard de ${-diff} j` : diff === 0 ? 'à rendre aujourd’hui' : `dans ${diff} j`}</span></li>`); });

    const alerts = [];
    state.machines.forEach((m) => { const lv = liveOf(m.id); if (lv && lv.state === 'error') alerts.push(`Erreur d’impression : ${esc(m.name)}`); });
    lowStock().slice(0, 4).forEach((m) => alerts.push(`Stock bas : ${esc(m.name)} (${esc(fmtNum(m.quantity))} ${esc(unitFor(m, m.quantity))})`));
    lowSpools().slice(0, 3).forEach((s) => alerts.push(`Bobine bientôt vide : ${esc(spoolName(s))} (${esc(fmtNum(Math.round(spoolLeft(s))))} g)`));
    state.spools.filter(needsDrying).slice(0, 2).forEach((s) => alerts.push(`À sécher : ${esc(filTitle(materialById(s.material_id)))}`));
    dueRules().slice(0, 3).forEach((r) => alerts.push(`Entretien à faire : ${esc(r.name)} (${esc(machineName(r.machine_id))})`));

    const team = state.profiles.map((p) => {
      const a = state.availability.filter((x) => x.user_id === p.id && x.date_from <= todayKey && x.date_to >= todayKey)[0];
      return `<li class="${a && a.kind === 'absent' ? 'bad' : ''}"><b>${esc(p.name)}</b><span>${a ? esc(AVAIL_LABEL[a.kind]) : '–'}</span></li>`;
    }).join('');

    return `<div class="atelier">
      <header class="at-head"><img src="img/logo.png" alt=""><div class="at-brand">DAYAN 3D<small>Atelier</small></div>
        <div class="at-clock"><b>${esc(clock)}</b><span>${esc(date)}</span></div>
        <button type="button" class="btn btn-quiet at-exit" data-act="kiosk-off">Quitter le plein écran</button></header>
      <div class="at-machines">${cards || '<div class="empty-day">Aucune machine</div>'}</div>
      <div class="at-cols">
        <section><h3>À faire et à rendre</h3><ul>${items.join('') || '<li><span>Rien de prévu</span></li>'}</ul></section>
        <section><h3>Alertes</h3><ul>${alerts.map((x) => `<li class="bad"><b>${x}</b></li>`).join('') || '<li><span>Tout est en ordre</span></li>'}</ul></section>
        <section><h3>Équipe aujourd’hui</h3><ul>${team || '<li><span>–</span></li>'}</ul></section>
      </div></div>`;
  }

  let wakeLock = null;
  async function keepAwake() {
    try { if (navigator.wakeLock && document.body.classList.contains('kiosk')) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* non pris en charge */ }
  }
  function enterKiosk() {
    state.view = 'atelier';
    document.body.classList.add('kiosk');
    document.body.classList.remove('nav-open');
    render();
    try { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {}); } catch (e) { /* ignoré */ }
    keepAwake();
  }
  function exitKiosk() {
    document.body.classList.remove('kiosk');
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {}); } catch (e) { /* ignoré */ }
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignoré */ } wakeLock = null; }
    render();
  }
  // l'écran fixe se rafraîchit tout seul : l'heure et les barres toutes les 30 s, les données toutes les 2 minutes
  let kioskTicks = 0;
  setInterval(() => {
    if (!state.started || state.view !== 'atelier') return;
    kioskTicks += 1;
    if (kioskTicks % 4 === 0) loadAll().then(render); else render();
  }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

  /* ------------------------------------------------------------------ */
  /*  Vue : corbeille                                                    */
  /* ------------------------------------------------------------------ */
  function trashHtml() {
    if (!state.trash.length) return '<div class="list"><div class="empty">La corbeille est vide. Les éléments supprimés y restent 30 jours.</div></div>';
    return `<div class="list"><div class="rows">${state.trash.map((t) => `
      <div class="trash-item"><span class="tag soft">${esc(TRASH_LABEL[t.table_name] || t.table_name)}</span>
        <span class="tname">${esc(t.label || 'Sans nom')}<span class="sub">supprimé par ${esc(t.deleted_by ? profileName(t.deleted_by) : 'le système')}, ${esc(fmtDateTime(t.deleted_at))}</span></span>
        <span class="tbtn"><button type="button" class="btn btn-small" data-act="trash-restore" data-id="${t.id}">Restaurer</button>
        <button type="button" class="btn btn-small btn-danger" data-act="trash-delete" data-id="${t.id}">Supprimer</button></span></div>`).join('')}</div></div>`;
  }

  async function restoreTrash(id) {
    const { data, error } = await sb.rpc('restore_trash', { p_id: Number(id) });
    if (error) { toast(`Restauration impossible : ${error.message}`, true); return; }
    await loadAll();
    render();
    if (data === 'ok') toast('Élément restauré');
    else toast(data === 'déjà présent' ? 'Cet élément existe déjà' : 'Élément introuvable', true);
  }

  async function purgeTrashItems(items) {
    for (const t of items) {
      if (t.table_name === 'orders' || t.table_name === 'prints') {
        for (const f of state.attachments.filter((x) => x.parent_id === t.row_id)) await removeAttachment(f.id, true);
      }
      await sb.from('trash').delete().eq('id', t.id);
    }
    await Promise.all([loadTable('trash'), loadTable('attachments')]);
  }

  async function deleteTrash(id) {
    const t = state.trash.find((x) => String(x.id) === String(id));
    if (!t || !window.confirm('Supprimer définitivement cet élément (et ses photos et fichiers) ? C’est irréversible.')) return;
    await purgeTrashItems([t]);
    render();
    toast('Supprimé définitivement');
  }

  async function purgeOldTrash() {
    const cutoff = Date.now() - 30 * 864e5;
    const old = state.trash.filter((t) => +new Date(t.deleted_at) < cutoff);
    if (old.length) await purgeTrashItems(old);
  }

  /* ------------------------------------------------------------------ */
  /*  Vue : statistiques                                                 */
  /* ------------------------------------------------------------------ */
  function statsHtml() {
    const now = new Date();
    const days = state.statsRange;
    const start = new Date(+now - days * 864e5);
    const doneAt = (o) => new Date(o.done_at || o.updated_at);
    const price = (o) => Number(o.price_chf) || 0;
    const fmtH = (h) => `${fmtNum(h >= 10 ? Math.round(h) : Math.round(h * 10) / 10)} h`;

    const doneOrders = state.orders.filter((o) => o.status === 'done' && doneAt(o) >= start && doneAt(o) <= now);
    const revenue = doneOrders.reduce((s, o) => s + price(o), 0);
    const matCost = doneOrders.reduce((s, o) => s + orderCost(o.id).total, 0);
    const delays = doneOrders.map((o) => (doneAt(o) - new Date(o.created_at)) / 864e5).filter((d) => d >= 0);
    const avgDelay = delays.length ? delays.reduce((x, y) => x + y, 0) / delays.length : null;
    const withDue = doneOrders.filter((o) => o.due_date);
    const onTime = withDue.filter((o) => ymd(doneAt(o)) <= o.due_date).length;

    const hoursOf = (p) => Math.max(0, Math.min(+new Date(p.end_at), +now) - Math.max(+new Date(p.start_at), +start)) / 36e5;
    const real = state.prints.filter((p) => p.status === 'done' || p.status === 'printing' || p.status === 'failed');
    const totalH = real.reduce((s, p) => s + hoursOf(p), 0);
    const perMachine = state.machines.map((m) => ({ m, h: real.filter((p) => p.machine_id === m.id).reduce((s, p) => s + hoursOf(p), 0) }));
    const capacity = days * 24;
    const avgOcc = state.machines.length ? (totalH / (capacity * state.machines.length)) * 100 : 0;

    const finished = state.prints.filter((p) => (p.status === 'done' || p.status === 'failed') && new Date(p.end_at) >= start && new Date(p.end_at) <= now);
    const failedP = finished.filter((p) => p.status === 'failed');
    const failedIds = new Set(failedP.map((p) => p.id));
    const lostUses = state.material_uses.filter((u) => u.print_id && failedIds.has(u.print_id));
    const lostCost = costOfRows(lostUses).total;
    const lostGrams = lostUses.reduce((s, u) => { const m = materialById(u.material_id); return s + (m && m.unit === 'g' ? Number(u.qty) : 0); }, 0);
    const successRate = finished.length ? Math.round(((finished.length - failedP.length) / finished.length) * 100) : null;
    const reasons = new Map();
    failedP.forEach((p) => { const k = p.fail_reason || 'Non précisée'; reasons.set(k, (reasons.get(k) || 0) + 1); });
    const topReasons = [...reasons.entries()].sort((x, y) => y[1] - x[1]);

    const kpi = (label, value, sub) => `<div class="kpi"><div class="l">${label}</div><div class="v">${value}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
    const kpis = `<div class="kpis">
      ${kpi('Commandes terminées', String(doneOrders.length), doneOrders.length ? '' : 'Aucune sur la période')}
      ${kpi('Chiffre d’affaires', esc(fmtMoney(revenue)), doneOrders.length ? `${doneOrders.filter((o) => o.price_chf != null).length} commande(s) avec un prix` : '')}
      ${kpi('Coût matière', esc(fmtMoney(matCost)), `Reste ${esc(fmtMoney(revenue - matCost))} après la matière`)}
      ${kpi('Heures d’impression', esc(fmtH(totalH)), `${Math.round(avgOcc)} % d’occupation moyenne`)}
      ${kpi('Délai moyen', avgDelay == null ? '–' : `${esc(fmtNum(Math.round(avgDelay * 10) / 10))} jours`, 'De la création à la fin de la commande')}
      ${kpi('Taux de réussite', successRate == null ? '–' : `${successRate} %`, finished.length ? `${finished.length - failedP.length} impressions réussies sur ${finished.length}` : 'Aucune impression terminée')}
      ${kpi('Rendues à l’heure', withDue.length ? `${Math.round((onTime / withDue.length) * 100)} %` : '–', withDue.length ? `${onTime} sur ${withDue.length} avec échéance` : 'Aucune commande avec échéance')}
    </div>`;

    const maxH = Math.max(1, ...perMachine.map((x) => x.h));
    const machineBars = perMachine.map(({ m, h }) => {
      const occ = Math.round((h / capacity) * 100);
      return `<div class="srow"><span class="sl">${esc(m.name)}</span><span class="strack"><span class="sfill" style="width:${(h / maxH) * 100}%"></span></span><span class="sv">${esc(fmtH(h))}<small>${occ} %</small></span></div>`;
    }).join('');

    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
      return { key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, label: d.toLocaleDateString('fr-CH', { month: 'short' }), count: 0, revenue: 0 };
    });
    state.orders.filter((o) => o.status === 'done').forEach((o) => {
      const d = doneAt(o);
      const mo = months.find((x) => x.key === `${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
      if (mo) { mo.count += 1; mo.revenue += price(o); }
    });
    const maxC = Math.max(1, ...months.map((x) => x.count));
    const chart = `<div class="mchart">${months.map((mo) => `<div class="mcol" title="${esc(`${mo.label} : ${mo.count} commande(s), ${fmtMoney(mo.revenue)}`)}">
      <span class="mv">${mo.count || ''}</span><div class="mwrap"><div class="mbar" style="height:${(mo.count / maxC) * 100}%"></div></div><span class="ml">${esc(mo.label)}</span></div>`).join('')}</div>`;

    const byClient = new Map();
    doneOrders.forEach((o) => {
      const c = o.client_id ? clientById(o.client_id) : null;
      const name = (c && c.name) || o.client || 'Sans nom';
      const e = byClient.get(name) || { name, n: 0, total: 0 };
      e.n += 1; e.total += price(o);
      byClient.set(name, e);
    });
    const topClients = [...byClient.values()].sort((x, y) => y.total - x.total || y.n - x.n).slice(0, 5);

    const usage = new Map();
    state.material_uses.filter((u) => u.applied).forEach((u) => {
      let when = null;
      if (u.print_id) { const p = state.prints.find((x) => x.id === u.print_id); when = p ? new Date(p.end_at) : null; }
      else if (u.order_id) { const o = state.orders.find((x) => x.id === u.order_id); when = o && o.status === 'done' ? doneAt(o) : null; }
      if (!when || when < start || when > now) return;
      const m = materialById(u.material_id);
      if (!m) return;
      const e = usage.get(m.id) || { m, qty: 0, cost: 0 };
      e.qty += Number(u.qty);
      const c = unitCost(m);
      if (c != null) e.cost += c * Number(u.qty);
      usage.set(m.id, e);
    });
    const topMats = [...usage.values()].sort((x, y) => y.cost - x.cost || y.qty - x.qty).slice(0, 5);

    const list = (rows, empty) => (rows.length ? rows.join('') : `<div class="empty-day">${empty}</div>`);
    return `${kpis}
      <div class="today-grid stats-grid">
        <section class="panel"><header><h3>Heures d’impression par machine</h3><span class="count">${esc(fmtH(totalH))}</span></header><div class="spad">${machineBars || '<div class="empty-day">Aucune machine</div>'}</div></section>
        <section class="panel"><header><h3>Commandes terminées par mois</h3><span class="count">12 mois</span></header>${chart}</section>
        <section class="panel"><header><h3>Échecs d’impression</h3><span class="count">${failedP.length}</span></header>
          ${failedP.length ? `<div class="tl-item static"><span class="ti-main">Matière perdue</span><span class="sub">${esc(fmtNum(Math.round(lostGrams)))} g${lostCost > 0 ? `, environ ${esc(fmtMoney(lostCost))}` : ''}</span></div>${topReasons.map(([k, n]) => `<div class="tl-item static"><span class="ti-main">${esc(k)}</span><span class="sub">${n} fois</span></div>`).join('')}` : '<div class="empty-day">Aucun échec sur la période</div>'}</section>
        <section class="panel"><header><h3>Meilleurs clients</h3><span class="count">${topClients.length}</span></header>
          ${list(topClients.map((c) => `<div class="tl-item static"><span class="ti-main">${esc(c.name)}</span><span class="sub">${c.n} commande${c.n > 1 ? 's' : ''}${c.total > 0 ? `, ${esc(fmtMoney(c.total))}` : ''}</span></div>`), 'Aucune commande terminée sur la période')}</section>
        <section class="panel"><header><h3>Matières les plus utilisées</h3><span class="count">${topMats.length}</span></header>
          ${list(topMats.map((x) => `<div class="tl-item static"><span class="ti-main">${esc(x.m.name)}</span><span class="sub">${esc(fmtNum(x.qty))} ${esc(unitFor(x.m, x.qty))}${x.cost > 0 ? `, ${esc(fmtMoney(x.cost))}` : ''}</span></div>`), 'Aucune matière consommée sur la période')}</section>
      </div>`;
  }

  /* ------------------------------------------------------------------ */
  /*  Vue : clients                                                      */
  /* ------------------------------------------------------------------ */
  function clientsHtml() {
    if (!state.clients.length) {
      return `<div class="list"><div class="empty">Aucune fiche client. Ajoute un client avec « + Client »${orphanOrders().length ? ', ou crée les fiches à partir des noms déjà saisis dans tes commandes.' : '.'}</div></div>`;
    }
    const rows = state.clients.slice().sort((x, y) => x.name.localeCompare(y.name, 'fr')).map((c) => {
      const st = clientStats(c);
      const contact = [c.phone, c.email].filter(Boolean).join(', ');
      return `<div class="row client-row"><span class="avatar">${esc(initials(c.name))}</span>
        <button type="button" class="title" data-act="edit" data-kind="client" data-id="${c.id}">${esc(c.name)}${contact ? `<span class="sub">${esc(contact)}</span>` : ''}</button>
        <span class="meta">${st.n ? `${st.n} commande${st.n > 1 ? 's' : ''}` : 'Aucune commande'}</span>
        <span class="when">${st.total > 0 ? esc(fmtMoney(st.total)) : ''}</span></div>`;
    }).join('');
    return `<div class="list"><div class="rows">${rows}</div></div>`;
  }

  async function importClientsFromOrders() {
    const orders = orphanOrders();
    const names = new Map();
    orders.forEach((o) => { const k = norm(o.client.trim()); if (!names.has(k)) names.set(k, o.client.trim()); });
    if (!names.size) { toast('Toutes les commandes ont déjà une fiche client'); return; }
    if (!window.confirm(`Créer ou relier ${names.size} fiche${names.size > 1 ? 's' : ''} client à partir des noms saisis dans tes commandes ?`)) return;
    let created = 0;
    for (const [k, name] of names) {
      let c = state.clients.find((x) => norm(x.name) === k);
      if (!c) {
        const { data, error } = await sb.from('clients').insert({ name }).select().single();
        if (error) { toast(`Fiche non créée : ${error.message}`, true); return; }
        c = data;
        state.clients.push(c);
        created += 1;
      }
      for (const o of orders.filter((x) => norm(x.client.trim()) === k)) {
        const { error } = await sb.from('orders').update({ client_id: c.id }).eq('id', o.id);
        if (error) { toast(`Commande non reliée : ${error.message}`, true); return; }
      }
    }
    await Promise.all([loadTable('clients'), loadTable('orders')]);
    render();
    toast(`${created} fiche${created > 1 ? 's' : ''} créée${created > 1 ? 's' : ''}, commandes reliées`);
  }

  /* ------------------------------------------------------------------ */
  /*  Export des clients vers l'application de facturation               */
  /* ------------------------------------------------------------------ */
  // La facturation a sa propre base Supabase : on prépare un script SQL (ou un fichier CSV) au format de sa table « clients ».
  const BILLING_COLS = ['name', 'contact', 'address', 'postal_code', 'city', 'country', 'email', 'phone', 'notes'];
  const COUNTRY_FR = { ch: 'Suisse', suisse: 'Suisse', switzerland: 'Suisse', fr: 'France', france: 'France', de: 'Allemagne', allemagne: 'Allemagne', it: 'Italie', italie: 'Italie' };

  // « Rue du Pont 8, 2400 Le Locle, CH » devient adresse, NPA, localité et pays
  function splitAddress(raw) {
    const t = String(raw || '').replace(/\s*\n\s*/g, ', ').trim();
    if (!t) return { address: null, postal_code: null, city: null, country: 'Suisse' };
    const m = /(?:^|,\s*)(?:CH[-\s]?)?(\d{4})\s+([^,]+?)(?:,\s*(CH|Suisse|Switzerland|FR|France|DE|Allemagne|IT|Italie))?\s*$/i.exec(t);
    if (!m) {
      const tail = /,?\s*(France|Allemagne|Italie|Belgique|Autriche|Espagne|Portugal)\s*$/i.exec(t);
      return { address: t, postal_code: null, city: null, country: tail ? tail[1].charAt(0).toUpperCase() + tail[1].slice(1).toLowerCase() : 'Suisse' };
    }
    const before = t.slice(0, m.index).replace(/[,\s]+$/, '');
    return { address: before || null, postal_code: m[1], city: m[2].trim(), country: m[3] ? (COUNTRY_FR[m[3].toLowerCase()] || 'Suisse') : 'Suisse' };
  }

  const sqlLit = (v) => (v == null || String(v).trim() === '' ? 'null' : `'${String(v).trim().replace(/'/g, "''")}'`);
  const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

  function billingExport(list, opts = {}) {
    const clean = (v) => ((v == null ? '' : String(v)).trim() || null);
    const score = (c) => ['email', 'phone', 'address', 'notes'].filter((k) => clean(c[k])).length;
    const nice = (n) => n !== n.toLowerCase() && n !== n.toUpperCase();
    const recs = list.filter((c) => clean(c.name)).map((c) => ({ c, name: clean(c.name), email: clean(c.email), phone: clean(c.phone), address: clean(c.address), notes: clean(c.notes) }));
    const skippedNoName = list.length - recs.length;
    // doublons : deux fiches qui partagent le même nom ou le même e-mail sont regroupées (même de proche en proche)
    const parent = recs.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const seen = new Map();
    recs.forEach((r, i) => {
      [norm(r.name), r.email ? `@${r.email.toLowerCase()}` : null].filter(Boolean).forEach((k) => {
        if (seen.has(k)) parent[find(i)] = find(seen.get(k)); else seen.set(k, i);
      });
    });
    const groups = new Map();
    recs.forEach((r, i) => { const g = find(i); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); });
    let skippedDup = 0;
    const all = [];
    groups.forEach((members) => {
      // la fiche la plus complète sert de base ; on reprend de l'autre ce qui lui manque
      members.sort((x, y) => score(y) - score(x) || x.name.localeCompare(y.name, 'fr'));
      skippedDup += members.length - 1;
      const first = (k) => (members.find((m) => m[k]) || {})[k] || null;
      const base = members[0];
      const name = nice(base.name) ? base.name : ((members.find((m) => nice(m.name)) || base).name);
      const addr = splitAddress(base.address || first('address'));
      all.push({ name, contact: null, address: addr.address, postal_code: addr.postal_code, city: addr.city, country: addr.country, email: base.email || first('email'), phone: base.phone || first('phone'), notes: base.notes || first('notes') });
    });
    const rows = all.filter((r) => !opts.onlyContact || r.email || r.phone).sort((x, y) => x.name.localeCompare(y.name, 'fr'));
    const day = new Date().toLocaleDateString('fr-CH');
    const sqlCols = ['name', 'address', 'postal_code', 'city', 'country', 'email', 'phone', 'notes'];
    const sql = rows.length ? [
      `-- Clients exportés du planning Dayan 3D le ${day} (${rows.length} client${rows.length > 1 ? 's' : ''}).`,
      '-- À lancer dans le projet Supabase de la FACTURATION (SQL Editor > New query > Run).',
      '-- Un client déjà présent (même e-mail ou même nom) n’est pas dupliqué : le script peut être relancé sans danger.',
      `insert into public.clients (${sqlCols.join(', ')})`,
      `select ${sqlCols.map((k) => `v.${k}`).join(', ')}`,
      'from (values',
      rows.map((r) => `  (${sqlCols.map((k) => sqlLit(r[k])).join(', ')})`).join(',\n'),
      `) as v(${sqlCols.join(', ')})`,
      'where not exists (',
      '  select 1 from public.clients c',
      '  where lower(c.name) = lower(v.name)',
      '     or (v.email is not null and lower(c.email) = lower(v.email))',
      ');'
    ].join('\n') : '';
    const csv = [BILLING_COLS.join(',')].concat(rows.map((r) => BILLING_COLS.map((k) => csvCell(r[k])).join(','))).join('\r\n') + '\r\n';
    return { rows, sql, csv, skippedNoName, skippedDup };
  }

  function downloadText(filename, mime, text) {
    const a2 = document.createElement('a');
    a2.download = filename;
    a2.href = (window.URL && URL.createObjectURL)
      ? URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
      : `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
    document.body.appendChild(a2);
    a2.click();
    a2.remove();
  }

  /* ---------- Envoi direct vers la base de la facturation ---------- */
  // Un second client Supabase, avec sa propre session (clé de stockage séparée), pointe vers le projet de la facturation.
  let billingSb = null;
  function billingClient() {
    const cfg = window.CONFIG || {};
    if (!cfg.BILLING_URL || !cfg.BILLING_KEY) return null;
    if (!billingSb) billingSb = window.supabase.createClient(cfg.BILLING_URL, cfg.BILLING_KEY, { auth: { storageKey: 'dayan-billing-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    return billingSb;
  }
  async function billingExisting(bc) {
    let all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await bc.from('clients').select('id,name,email,phone,address,postal_code,city,notes').order('name').range(from, from + 999);
      if (error) throw error;
      all = all.concat(data || []);
      if (!data || data.length < 1000) break;
    }
    return all;
  }
  const blank = (v) => !(v != null && String(v).trim());
  // ce qu'il faut créer, et ce qu'on peut compléter chez les clients déjà présents (jamais d'écrasement)
  function billingPlan(rows, existing, fill) {
    const byEmail = new Map();
    const byName = new Map();
    existing.forEach((e) => { if (!blank(e.email)) byEmail.set(String(e.email).trim().toLowerCase(), e); byName.set(norm(e.name), e); });
    const toCreate = [];
    const toFill = [];
    let present = 0;
    rows.forEach((r) => {
      const e = (r.email && byEmail.get(r.email.toLowerCase())) || byName.get(norm(r.name));
      if (!e) { toCreate.push(r); return; }
      present += 1;
      if (!fill) return;
      const patch = {};
      if (blank(e.email) && r.email) patch.email = r.email;
      if (blank(e.phone) && r.phone) patch.phone = r.phone;
      if (blank(e.address) && blank(e.postal_code) && blank(e.city) && (r.address || r.postal_code || r.city)) { patch.address = r.address; patch.postal_code = r.postal_code; patch.city = r.city; }
      if (blank(e.notes) && r.notes) patch.notes = r.notes;
      if (Object.keys(patch).length) toFill.push({ id: e.id, name: e.name, patch });
    });
    return { toCreate, toFill, present };
  }
  function billingError(e) {
    const m = String((e && (e.message || e.error_description)) || e);
    if (/JWT|expired|token|not authenticated/i.test(m)) return { text: 'Session expirée : reconnecte-toi à la facturation.', relogin: true };
    if (/row-level security|permission denied|not allowed/i.test(m)) return { text: 'Ton compte de la facturation n’a pas le droit de créer des clients.' };
    if (/relation .* does not exist|schema cache|clients/i.test(m) && /not exist|schema cache|find the table/i.test(m)) return { text: 'La table « clients » est introuvable : vérifie que l’adresse de la facturation est la bonne.' };
    if (/Failed to fetch|NetworkError|network/i.test(m)) return { text: 'Connexion impossible : vérifie ta connexion internet.' };
    if (/Invalid login credentials/i.test(m)) return { text: 'E-mail ou mot de passe incorrect (ceux de l’application de facturation).' };
    if (/rate limit|too many/i.test(m)) return { text: 'Trop de tentatives : attends quelques minutes avant de réessayer.' };
    return { text: m };
  }

  async function openBillingExport() {
    const bc = billingClient();
    $('#layer-root').innerHTML = `
      <div class="overlay layer" id="bx-overlay">
        <div class="modal export" role="dialog" aria-modal="true" aria-label="Envoyer les clients vers la facturation">
          <div class="modal-head"><h3>Envoyer les clients vers la facturation</h3><button type="button" class="btn btn-quiet icon-btn" data-bxclose aria-label="Fermer">✕</button></div>
          <div class="modal-body">
            <p class="bx-intro">Tes clients (nom, e-mail, téléphone, adresse) sont envoyés directement dans la base de la facturation. Rien n’est envoyé sans ton clic, et rien n’est écrasé.</p>
            <label class="checkline"><input type="checkbox" id="bx-only"><span>Seulement les clients qui ont un e-mail ou un téléphone</span></label>
            <div id="bx-count" class="bx-count"></div>
            <div id="bx-preview" class="bx-preview"></div>
            <div id="bx-phase"></div>
            <details class="bx-other"><summary>Autres méthodes : script SQL ou fichier CSV</summary>
              <ol class="bx-steps">
                <li>Clique sur <b>Copier le script SQL</b>.</li>
                <li>Ouvre le projet Supabase <b>de la facturation</b> (pas celui du planning) puis <b>SQL Editor</b> &gt; <b>New query</b>, colle et clique sur <b>Run</b>.</li>
              </ol>
              <small class="hint-line">Fichier CSV : dans Supabase de la facturation, Table Editor &gt; clients &gt; Insert &gt; Import data from CSV.</small>
              <div class="bx-alt"><button type="button" class="btn btn-small" id="bx-copy">Copier le script SQL</button><button type="button" class="btn btn-small" id="bx-csv">Télécharger le fichier CSV</button></div>
            </details>
          </div>
          <div class="modal-foot" id="bx-foot"></div>
        </div>
      </div>`;
    const close = () => { $('#layer-root').innerHTML = ''; };
    const st = { phase: 'init', email: '', existing: [], plan: null, only: false, fill: true, err: '', ok: '', exp: null };

    const computeExport = () => {
      st.only = $('#bx-only').checked;
      st.exp = billingExport(state.clients, { onlyContact: st.only });
      const n = st.exp.rows.length;
      const noContact = st.exp.rows.filter((r) => !r.email && !r.phone).length;
      $('#bx-count').textContent = n
        ? `${n} client${n > 1 ? 's' : ''} à exporter${noContact ? ` (dont ${noContact} sans e-mail ni téléphone)` : ''}${st.exp.skippedDup ? `, ${st.exp.skippedDup} doublon${st.exp.skippedDup > 1 ? 's' : ''} ignoré${st.exp.skippedDup > 1 ? 's' : ''}` : ''}.`
        : 'Aucun client à exporter avec ces critères.';
      $('#bx-preview').innerHTML = st.exp.rows.slice(0, 5).map((r) => `<div class="bx-row"><b>${esc(r.name)}</b><span>${esc([r.email, r.phone].filter(Boolean).join('  ') || 'sans e-mail ni téléphone')}</span></div>`).join('')
        + (n > 5 ? `<div class="bx-row more">… et ${n - 5} autre${n - 5 > 1 ? 's' : ''}</div>` : '');
      $('#bx-copy').disabled = !n;
      $('#bx-csv').disabled = !n;
      st.plan = st.phase === 'ready' ? billingPlan(st.exp.rows, st.existing, st.fill) : null;
    };

    const paint = () => {
      computeExport();
      const phase = $('#bx-phase');
      const foot = $('#bx-foot');
      const closeBtn = '<button type="button" class="btn" data-bxclose>Fermer</button>';
      const errLine = st.err ? `<div class="form-error" role="alert">${esc(st.err)}</div>` : '';
      if (!bc) {
        phase.innerHTML = '<div class="bx-note">L’envoi direct n’est pas configuré dans cette version : utilise le script SQL ou le fichier CSV ci-dessous.</div>';
        foot.innerHTML = `<span class="grow"></span>${closeBtn}`;
        phase.closest('.modal-body').querySelector('details').open = true;
        return;
      }
      if (st.phase === 'init' || st.phase === 'loading') {
        phase.innerHTML = `<div class="bx-note">${st.phase === 'init' ? 'Connexion à la facturation…' : 'Lecture des clients de la facturation…'}</div>`;
        foot.innerHTML = `<span class="grow"></span>${closeBtn}`;
        return;
      }
      if (st.phase === 'login') {
        phase.innerHTML = `<div class="bx-login"><p>Connecte-toi une fois avec ton compte de l’<b>application de facturation</b> (même e-mail, même mot de passe). Le mot de passe n’est pas enregistré.</p>
          <label class="field"><span>E-mail de la facturation</span><input id="bx-mail" type="email" autocomplete="username" value="${esc(st.email)}"></label>
          <label class="field"><span>Mot de passe</span><input id="bx-pass" type="password" autocomplete="current-password"></label>${errLine}</div>`;
        foot.innerHTML = `<span class="grow"></span>${closeBtn}<button type="button" class="btn btn-primary" id="bx-login">Se connecter</button>`;
        return;
      }
      // connecté
      const p = st.plan || { toCreate: [], toFill: [], present: 0 };
      const nothing = !p.toCreate.length && !p.toFill.length;
      phase.innerHTML = `<div class="bx-who">Connecté à la facturation : <b>${esc(st.email)}</b> <button type="button" class="linkbtn" id="bx-logout">Se déconnecter</button></div>
        <label class="checkline"><input type="checkbox" id="bx-fill" ${st.fill ? 'checked' : ''}><span>Compléter les clients déjà présents (e-mail, téléphone ou adresse manquants, sans rien écraser)</span></label>
        <div class="bx-plan ${nothing ? 'done' : ''}">${st.exp.rows.length
          ? (nothing ? 'Tout est déjà à jour dans la facturation.' : `<b>${p.toCreate.length}</b> nouveau${p.toCreate.length > 1 ? 'x' : ''} client${p.toCreate.length > 1 ? 's' : ''} à créer, <b>${p.present}</b> déjà présent${p.present > 1 ? 's' : ''}${p.toFill.length ? ` dont <b>${p.toFill.length}</b> à compléter` : ''}.`)
          : ''}</div>
        ${st.ok ? `<div class="bx-ok" role="status">${esc(st.ok)}</div>` : ''}${errLine}`;
      const label = p.toCreate.length ? `Envoyer ${p.toCreate.length} client${p.toCreate.length > 1 ? 's' : ''}` : (p.toFill.length ? `Compléter ${p.toFill.length} client${p.toFill.length > 1 ? 's' : ''}` : 'Envoyer vers la facturation');
      foot.innerHTML = `<span class="grow"></span>${closeBtn}<button type="button" class="btn btn-primary" id="bx-send" ${nothing || st.phase === 'sending' ? 'disabled' : ''}>${st.phase === 'sending' ? 'Envoi en cours…' : label}</button>`;
    };

    const loadExisting = async () => {
      st.phase = 'loading'; paint();
      try {
        st.existing = await billingExisting(bc);
        st.phase = 'ready'; st.err = '';
      } catch (e) {
        const be = billingError(e);
        st.err = be.text;
        st.phase = be.relogin ? 'login' : 'ready';
        if (!be.relogin) st.existing = [];
      }
      paint();
    };
    const doLogin = async () => {
      const email = ($('#bx-mail').value || '').trim();
      const password = $('#bx-pass').value || '';
      if (!email || !password) { st.err = 'Saisis l’e-mail et le mot de passe de la facturation.'; st.email = email; paint(); return; }
      st.email = email;
      const btn = $('#bx-login');
      btn.disabled = true; btn.textContent = 'Connexion…';
      const { data, error } = await bc.auth.signInWithPassword({ email, password });
      if (error || !data || !data.session) { st.err = billingError(error || 'Invalid login credentials').text; paint(); return; }
      try { localStorage.setItem('dayan_billing_email', email); } catch (e) { /* ignoré */ }
      st.email = data.session.user.email || email;
      st.err = ''; st.ok = '';
      await loadExisting();
    };
    const doSend = async () => {
      const p = st.plan;
      if (!p || (!p.toCreate.length && !p.toFill.length)) return;
      st.phase = 'sending'; st.err = ''; st.ok = ''; paint();
      let created = 0;
      let filled = 0;
      try {
        for (let i = 0; i < p.toCreate.length; i += 200) {
          const chunk = p.toCreate.slice(i, i + 200).map((r) => ({ name: r.name, address: r.address, postal_code: r.postal_code, city: r.city, country: r.country, email: r.email, phone: r.phone, notes: r.notes }));
          const { error } = await bc.from('clients').insert(chunk);
          if (error) throw error;
          created += chunk.length;
        }
        for (const f of p.toFill) {
          const { error } = await bc.from('clients').update(f.patch).eq('id', f.id);
          if (error) throw error;
          filled += 1;
        }
        st.ok = `${created ? `${created} client${created > 1 ? 's' : ''} créé${created > 1 ? 's' : ''}` : ''}${created && filled ? ' et ' : ''}${filled ? `${filled} complété${filled > 1 ? 's' : ''}` : ''} dans la facturation. Ils apparaissent tout de suite dans l’application de facturation.`;
        toast('Clients envoyés vers la facturation');
      } catch (e) {
        const be = billingError(e);
        st.err = `${be.text}${created || filled ? ` (déjà fait avant l’erreur : ${created} créé${created > 1 ? 's' : ''}, ${filled} complété${filled > 1 ? 's' : ''})` : ''}`;
        if (be.relogin) { st.phase = 'login'; paint(); return; }
      }
      try { st.existing = await billingExisting(bc); } catch (e) { /* la liste sera relue à la prochaine ouverture */ }
      st.phase = 'ready';
      paint();
    };
    const doLogout = async () => {
      try { await bc.auth.signOut({ scope: 'local' }); } catch (e) { /* ignoré */ }
      st.phase = 'login'; st.err = ''; st.ok = ''; st.existing = [];
      paint();
    };

    const ov = $('#bx-overlay');
    ov.addEventListener('mousedown', (e) => { if (e.target.id === 'bx-overlay') close(); });
    ov.addEventListener('click', (e) => {
      if (e.target.closest('[data-bxclose]')) { close(); return; }
      const id = (e.target.closest('button') || {}).id;
      if (id === 'bx-login') doLogin();
      else if (id === 'bx-send') doSend();
      else if (id === 'bx-logout') doLogout();
      else if (id === 'bx-copy') copyText(st.exp.sql).then((ok) => toast(ok ? 'Script copié : colle-le dans le SQL Editor de la facturation' : 'Copie impossible : utilise le fichier CSV', !ok));
      else if (id === 'bx-csv') { downloadText(`clients-dayan3d-${ymd(new Date())}.csv`, 'text/csv', st.exp.csv); toast('Fichier CSV préparé'); }
    });
    ov.addEventListener('change', (e) => {
      if (e.target.id === 'bx-only') paint();
      if (e.target.id === 'bx-fill') { st.fill = e.target.checked; paint(); }
    });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'bx-pass') { e.preventDefault(); doLogin(); } });

    try { st.email = localStorage.getItem('dayan_billing_email') || ''; } catch (e) { /* ignoré */ }
    paint();
    if (!bc) return;
    const { data } = await bc.auth.getSession();
    if (data && data.session) { st.email = data.session.user.email || st.email; await loadExisting(); }
    else { st.phase = 'login'; paint(); }
  }

  /* ------------------------------------------------------------------ */
  /*  Vue : stock                                                        */
  /* ------------------------------------------------------------------ */
  function stockRow(m) {
    const low = isLow(m);
    const alert = Number(m.min_quantity) > 0 ? ` – alerte sous ${fmtNum(m.min_quantity)} ${unitFor(m, m.min_quantity)}` : '';
    return `<div class="row stock-row ${low ? 'low' : ''}">
      <button type="button" class="title" data-act="edit" data-kind="material" data-id="${m.id}">${esc(m.name)}<span class="sub">${esc(priceLabel(m))}${esc(alert)}</span></button>
      <span class="qty ${low ? 'late' : ''}">${esc(fmtNum(m.quantity))} ${esc(unitFor(m, m.quantity))}</span>
      ${low ? '<span class="tag">Stock bas</span>' : '<span></span>'}
      <button type="button" class="btn btn-small" data-act="adjust" data-id="${m.id}">Ajuster</button>
    </div>`;
  }

  function spoolRow(s) {
    const left = spoolLeft(s);
    const pct = Math.min(100, (left / Math.max(1, Number(s.initial_g))) * 100);
    const low = s.status === 'active' && s.machine_id && left <= Number(s.alert_g);
    const where = s.status === 'empty' ? 'Terminée' : s.machine_id ? `Dans ${machineName(s.machine_id)}` : 'En réserve';
    const action = s.status === 'empty' ? '' : s.machine_id
      ? `<button type="button" class="btn btn-small" data-act="spool-unload" data-id="${s.id}">Décharger</button>`
      : `<button type="button" class="btn btn-small" data-act="spool-load-menu" data-id="${s.id}">Charger</button>`;
    return `<div class="spool-row ${low ? 'due' : ''}"><button type="button" class="tl-item" data-act="edit" data-kind="spool" data-id="${s.id}"><span class="ti-main">${esc(spoolName(s))}</span>
      <span class="sub">${esc(where)}${low ? ', bientôt vide' : ''}</span></button>
      <div class="maint-prog"><span class="strack"><span class="sfill" style="width:${pct}%"></span></span><span class="mt">${esc(fmtNum(Math.round(left)))} / ${esc(fmtNum(s.initial_g))} g</span></div>${action || '<span></span>'}</div>`;
  }

  function spoolsPanel() {
    if (!state.spools.length) return '';
    const sort = (x, y) => spoolName(x).localeCompare(spoolName(y), 'fr');
    const loaded = state.spools.filter((s) => s.status === 'active' && s.machine_id).sort(sort);
    const reserve = state.spools.filter((s) => s.status === 'active' && !s.machine_id).sort(sort);
    const empty = state.spools.filter((s) => s.status === 'empty').sort(sort);
    const group = (title, list) => (list.length ? `<div class="spool-group"><h4>${title}</h4>${list.map(spoolRow).join('')}</div>` : '');
    return `<section class="panel spools"><header><h3>Bobines</h3><span class="count">${loaded.length} chargée${loaded.length > 1 ? 's' : ''}</span></header>
      ${group('Chargées dans une machine', loaded)}${group('En réserve (entamées ou neuves)', reserve)}
      ${empty.length ? `<details class="spool-group"><summary>Terminées (${empty.length})</summary>${empty.map(spoolRow).join('')}</details>` : ''}</section>`;
  }

  function openSpoolMenu(anchor, id) {
    closeMenu();
    const r = anchor.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'pop';
    el.style.top = `${r.bottom + 6}px`;
    el.style.right = `${window.innerWidth - r.right}px`;
    el.innerHTML = state.machines.map((m) => `<button type="button" data-act="spool-load" data-id="${id}" data-machine="${m.id}">${esc(m.name)}</button>`).join('');
    $('#menu-root').appendChild(el);
  }

  async function setSpoolMachine(id, machineId) {
    closeMenu();
    const s = spoolById(id);
    if (!s) return;
    const patch = { machine_id: machineId };
    if (machineId && !s.opened_at) patch.opened_at = ymd(new Date());
    $('#layer-root').innerHTML = '';
    const { error } = await sb.from('spools').update(patch).eq('id', id);
    if (error) { toast(`Modification impossible : ${error.message}`, true); return; }
    await loadTable('spools');
    render();
    toast(machineId ? `${spoolName(s)} chargée dans ${machineName(machineId)}` : `${spoolName(s)} déchargée`);
  }

  function stockHtml() {
    if (!state.materials.length) {
      return '<div class="list"><div class="empty">Aucune matière pour le moment. Ajoute tes filaments, plaques de bois et consommables avec « + Matière ».</div></div>';
    }
    const byName = (x, y) => x.name.localeCompare(y.name, 'fr');
    const lines = reorderLines();
    const total = lines.reduce((s, l) => s + (l.cost || 0), 0);
    const reorder = lines.length ? `<section class="panel reorder"><header><h3>À racheter</h3><span class="count">${lines.length}</span>
        <button type="button" class="btn btn-small" data-act="copy-reorder">Copier la liste</button></header>
        ${lines.map((l) => `<div class="tl-item static"><span class="ti-main">${esc(l.m.name)}</span><span class="sub">${esc(fmtNum(l.q))} ${esc(unitFor(l.m, l.q))}${l.cost != null ? `, environ ${esc(fmtMoney(l.cost))}` : ''}</span></div>`).join('')}
        ${total > 0 ? `<div class="reorder-total">Total estimé : <b>${esc(fmtMoney(total))}</b></div>` : ''}</section>` : '';
    return `<div class="list">${reorder}${spoolsPanel()}${MAT_CATS.map(([k, label]) => {
      const items = state.materials.filter((m) => m.category === k).sort(byName);
      return items.length ? `<div><h3>${label} (${items.length})</h3><div class="rows">${items.map(stockRow).join('')}</div></div>` : '';
    }).join('')}</div>`;
  }

  /* ------------------------------------------------------------------ */
  /*  Vue : filaments                                                    */
  /* ------------------------------------------------------------------ */
  function filFiltered() {
    const q = norm(state.filQuery);
    return state.spools.filter((s) => {
      const m = materialById(s.material_id);
      if (state.filType && filType(m) !== state.filType) return false;
      if (q && !norm([filTitle(m), m && m.name, s.label, s.location, s.supplier, s.notes].filter(Boolean).join(' ')).includes(q)) return false;
      const left = spoolLeft(s);
      switch (state.filFilter) {
        case 'loaded': return s.status === 'active' && !!s.machine_id;
        case 'reserve': return s.status === 'active' && !s.machine_id;
        case 'low': return s.status === 'active' && left <= Number(s.alert_g);
        case 'dry': return needsDrying(s);
        case 'empty': return s.status === 'empty';
        default: return s.status === 'active';
      }
    }).sort((x, y) => (!!y.machine_id - !!x.machine_id) || filTitle(materialById(x.material_id)).localeCompare(filTitle(materialById(y.material_id)), 'fr') || String(x.label || '').localeCompare(String(y.label || ''), 'fr', { numeric: true }));
  }

  function filCard(s) {
    const m = materialById(s.material_id);
    const left = spoolLeft(s);
    const pct = Math.min(100, (left / Math.max(1, Number(s.initial_g))) * 100);
    const empty = s.status === 'empty';
    const low = !empty && left <= Number(s.alert_g);
    const dry = needsDrying(s);
    const where = empty ? 'Terminée' : s.machine_id ? `Dans ${machineName(s.machine_id)}` : (s.location ? `Rangée : ${s.location}` : 'En réserve');
    const ppk = pricePerKg(s, m);
    const meta = [ppk ? `${fmtMoney(ppk)} / kg` : '', s.opened_at ? `ouverte le ${fmtShort(parseYmd(s.opened_at))}` : '', s.dried_at ? `séchée le ${fmtShort(parseYmd(s.dried_at))}` : ''].filter(Boolean).join(' · ');
    const loadBtn = empty ? '' : s.machine_id
      ? `<button type="button" class="btn btn-small" data-act="spool-unload" data-id="${s.id}">Décharger</button>`
      : `<button type="button" class="btn btn-small" data-act="spool-load-menu" data-id="${s.id}">Charger</button>`;
    return `<article class="fil-card ${low ? 'low' : ''} ${empty ? 'is-empty' : ''}" data-spool="${s.id}">
      <button type="button" class="fil-head" data-act="spool-detail" data-id="${s.id}">${swatchHtml(m, true)}
        <span class="fil-title">${esc(filTitle(m))}${s.label ? ` <small>#${esc(s.label)}</small>` : ''}<small class="fil-where">${esc(where)}</small></span></button>
      <div class="fil-tags">${filType(m) ? `<span class="tag soft">${esc(filType(m))}</span>` : ''}${m && m.diameter ? `<span class="tag soft">${esc(fmtNum(m.diameter))} mm</span>` : ''}${low ? '<span class="tag">Bientôt vide</span>' : ''}${dry ? '<span class="tag warn">À sécher ?</span>' : ''}</div>
      <div class="fil-bar"><span class="strack"><span class="sfill" style="width:${pct}%"></span></span><span class="fil-g">${esc(fmtNum(Math.round(left)))} <small>/ ${esc(fmtNum(s.initial_g))} g</small></span></div>
      ${meta ? `<div class="fil-meta">${esc(meta)}</div>` : ''}
      <div class="fil-actions">${empty ? '' : `<button type="button" class="btn btn-small" data-act="spool-weigh" data-id="${s.id}">Peser</button>`}${loadBtn}${empty ? '' : `<button type="button" class="btn btn-small ${dry ? 'btn-primary' : ''}" data-act="spool-dry" data-id="${s.id}" title="Noter que la bobine a été séchée aujourd’hui">Séchée</button>`}</div>
    </article>`;
  }

  function filResultsHtml() {
    const list = filFiltered();
    if (!state.materials.some((m) => m.category === 'filament') && !state.spools.length) {
      return '<div class="empty">Commence par « + Filament » : marque, matière, couleur et températures. Ajoute ensuite tes bobines avec « + Bobine ».</div>';
    }
    if (!state.spools.length) return '<div class="empty">Aucune bobine pour le moment. Ajoute celles que tu as avec « + Bobine » (ou « + Bobine » dans le catalogue, sur la ligne du filament).</div>';
    if (!list.length) return '<div class="empty">Aucune bobine ne correspond à ces filtres.</div>';
    return `<div class="fil-grid">${list.map(filCard).join('')}</div>`;
  }

  function filSpoolsHtml() {
    const active = state.spools.filter((s) => s.status === 'active');
    const grams = active.reduce((t, s) => t + spoolLeft(s), 0);
    let value = 0;
    let priced = 0;
    active.forEach((s) => { const p = pricePerKg(s, materialById(s.material_id)); if (p) { value += (spoolLeft(s) / 1000) * p; priced += 1; } });
    const loaded = active.filter((s) => s.machine_id).length;
    const nLow = active.filter((s) => spoolLeft(s) <= Number(s.alert_g)).length;
    const nDry = state.spools.filter(needsDrying).length;
    const counts = { all: active.length, loaded, reserve: active.length - loaded, low: nLow, dry: nDry, empty: state.spools.filter((s) => s.status === 'empty').length };
    const types = [...new Set(state.spools.map((s) => filType(materialById(s.material_id))).filter(Boolean))].sort();
    const kpi = (l, v, s) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
    return `<div class="kpis fil-kpis">
        ${kpi('Bobines en service', String(active.length), `${loaded} chargée${loaded > 1 ? 's' : ''} dans une machine`)}
        ${kpi('Filament restant', `${esc(fmtNum(Math.round(grams / 100) / 10))} kg`, `${esc(fmtNum(Math.round(grams)))} g`)}
        ${kpi('Valeur du stock', priced ? esc(fmtMoney(value)) : '–', priced ? (priced < active.length ? `prix connu pour ${priced} bobine${priced > 1 ? 's' : ''} sur ${active.length}` : 'au prix payé') : 'Indique un prix')}
        ${kpi('À surveiller', String(nLow + nDry), `${nLow} bientôt vide${nLow > 1 ? 's' : ''}, ${nDry} à sécher`)}
      </div>
      <div class="fil-filters">
        <div class="fchips" role="group" aria-label="Filtre">${FIL_FILTERS.map(([k, l]) => `<button type="button" class="fchip" data-act="fil-filter" data-f="${k}" aria-pressed="${state.filFilter === k}">${l}${counts[k] ? ` <small>${counts[k]}</small>` : ''}</button>`).join('')}</div>
        <select id="fil-type" aria-label="Matière"><option value="">Toutes les matières</option>${types.map((t) => `<option value="${esc(t)}" ${state.filType === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <input id="fil-search" type="search" placeholder="Marque, couleur, emplacement…" value="${esc(state.filQuery)}" autocomplete="off">
      </div>
      <div id="fil-results">${filResultsHtml()}</div>`;
  }

  function filCatalogHtml() {
    const mats = state.materials.filter((m) => m.category === 'filament' && m.unit === 'g');
    if (!mats.length) return '<div class="empty">Aucun filament dans le catalogue. Ajoute-en un avec « + Filament ».</div>';
    const groups = [...FIL_TYPE_LIST, ''].map((t) => ({ t, items: mats.filter((m) => (filType(m) || '') === t).sort((x, y) => filTitle(x).localeCompare(filTitle(y), 'fr')) })).filter((g) => g.items.length);
    return groups.map((g) => `<section class="fil-group"><h3>${esc(g.t || 'À compléter (matière non indiquée)')} <small>${g.items.length}</small></h3>
      ${g.items.map((m) => {
        const n = state.spools.filter((s) => s.material_id === m.id && s.status === 'active').length;
        const low = Number(m.min_quantity) > 0 && Number(m.quantity) <= Number(m.min_quantity);
        const ppk = m.cost_chf && m.cost_qty ? (Number(m.cost_chf) / Number(m.cost_qty)) * 1000 : null;
        const sub = [m.diameter ? `${fmtNum(m.diameter)} mm` : '', m.nozzle_min && m.nozzle_max ? `buse ${m.nozzle_min}–${m.nozzle_max} °C` : '', m.bed_c ? `plateau ${m.bed_c} °C` : '', ppk ? `${fmtMoney(ppk)} / kg` : ''].filter(Boolean).join(' · ');
        return `<div class="fil-row ${low ? 'low' : ''}"><button type="button" class="fil-main" data-act="edit" data-kind="filament" data-id="${m.id}">${swatchHtml(m)}<span><b>${esc(filTitle(m))}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span></button>
          <span class="fil-stock ${low ? 'late' : ''}">${esc(fmtNum(Math.round(m.quantity)))} g</span><span class="fil-count">${n} bobine${n > 1 ? 's' : ''}</span>
          <button type="button" class="btn btn-small" data-act="newitem" data-kind="spool" data-material="${m.id}">+ Bobine</button></div>`;
      }).join('')}</section>`).join('');
  }

  function filamentsHtml() {
    return state.filTab === 'catalog' ? `<div class="fil-page">${filCatalogHtml()}</div>` : `<div class="fil-page">${filSpoolsHtml()}</div>`;
  }

  function openSpoolDetail(id) {
    const s = spoolById(id);
    if (!s) return;
    if ($('#modal-root .modal.search')) closeModal();
    const m = materialById(s.material_id);
    const left = spoolLeft(s);
    const ppk = pricePerKg(s, m);
    const empty = s.status === 'empty';
    const dry = needsDrying(s);
    const row = (l, v) => (v ? `<div class="d-row"><span>${esc(l)}</span><b>${esc(v)}</b></div>` : '');
    const hist = state.stock_moves.filter((mv) => mv.spool_id === s.id).sort((x, y) => new Date(y.at) - new Date(x.at)).slice(0, 12);
    $('#layer-root').innerHTML = `
      <div class="overlay layer" id="sd-overlay">
        <div class="modal fil-detail" role="dialog" aria-modal="true" aria-label="Fiche de la bobine">
          <div class="modal-head"><div class="w-title">${swatchHtml(m, true)}<h3>${esc(filTitle(m))}${s.label ? ` #${esc(s.label)}` : ''}</h3></div><button type="button" class="btn btn-quiet icon-btn" data-sdclose aria-label="Fermer">✕</button></div>
          <div class="modal-body">
            ${dry ? `<div class="bx-plan">À sécher ? Ouverte depuis plus de ${DRY_AFTER_DAYS} jours sans séchage récent. Conseil : ${esc(dryAdvice(m))}.</div>` : ''}
            <div class="d-grid">
              <div><h4>Bobine</h4>
                ${row('Reste', `${fmtNum(Math.round(left))} g sur ${fmtNum(s.initial_g)} g`)}
                ${row('État', empty ? 'Terminée' : s.machine_id ? `Dans ${machineName(s.machine_id)}` : 'En réserve')}
                ${row('Emplacement', s.location)}
                ${row('Poids à vide', s.tare_g != null ? `${fmtNum(s.tare_g)} g` : '')}
                ${row('Prix payé', Number(s.price_chf) > 0 ? `${fmtMoney(s.price_chf)}${ppk ? ` (${fmtMoney(ppk)} / kg)` : ''}` : (ppk ? `${fmtMoney(ppk)} / kg (prix habituel)` : ''))}
                ${row('Achetée le', s.purchased_at ? fmtShort(parseYmd(s.purchased_at)) : '')}
                ${row('Fournisseur', s.supplier)}
                ${row('Ouverte le', s.opened_at ? fmtShort(parseYmd(s.opened_at)) : '')}
                ${row('Dernier séchage', s.dried_at ? fmtShort(parseYmd(s.dried_at)) : '')}
                ${row('Rangement', s.dry_storage ? 'Stockée au sec' : '')}
              </div>
              <div><h4>Filament</h4>
                ${row('Marque', m && m.brand)}
                ${row('Matière', filType(m))}
                ${row('Couleur', m && m.color_name)}
                ${row('Diamètre', m && m.diameter ? `${fmtNum(m.diameter)} mm` : '')}
                ${row('Buse', m && m.nozzle_min && m.nozzle_max ? `${m.nozzle_min} à ${m.nozzle_max} °C` : '')}
                ${row('Plateau', m && m.bed_c ? `${m.bed_c} °C` : '')}
                ${row('Séchage conseillé', dryAdvice(m))}
              </div>
            </div>
            ${s.notes ? `<p class="d-notes">${esc(s.notes)}</p>` : ''}
            <h4>Historique de cette bobine</h4>
            <div class="d-hist">${hist.length ? hist.map((mv) => `<div class="d-row"><span>${esc(fmtShort(new Date(mv.at)))} · ${esc(MOVE_FR[mv.reason] || mv.reason)}${mv.note ? ` · ${esc(mv.note)}` : ''}</span><b class="${Number(mv.delta) < 0 ? '' : 'plus'}">${Number(mv.delta) > 0 ? '+' : ''}${esc(fmtNum(round1(mv.delta)))} g</b></div>`).join('') : '<div class="empty-day">Aucun mouvement enregistré pour cette bobine.</div>'}</div>
          </div>
          <div class="modal-foot">
            ${empty ? '' : `<button type="button" class="btn" data-act="spool-weigh" data-id="${s.id}">Peser</button><button type="button" class="btn" data-act="spool-dry" data-id="${s.id}">Séchée aujourd’hui</button>${s.machine_id ? `<button type="button" class="btn" data-act="spool-unload" data-id="${s.id}">Décharger</button>` : `<button type="button" class="btn" data-act="spool-load-menu" data-id="${s.id}">Charger</button>`}`}
            <button type="button" class="btn" data-act="spool-label" data-id="${s.id}">Étiquette QR</button><span class="grow"></span>
            <button type="button" class="btn" data-act="spool-edit" data-id="${s.id}">Modifier</button><button type="button" class="btn btn-primary" data-sdclose>Fermer</button>
          </div>
        </div>
      </div>`;
    const close = () => { $('#layer-root').innerHTML = ''; };
    $('#sd-overlay').querySelectorAll('[data-sdclose]').forEach((b) => b.addEventListener('click', close));
    $('#sd-overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'sd-overlay') close(); });
  }

  // pesée : le poids sur la balance, moins la bobine vide, donne le reste ; le stock suit
  function openWeigh(id) {
    const s = spoolById(id);
    if (!s) return;
    const m = materialById(s.material_id);
    const left = spoolLeft(s);
    $('#layer-root').innerHTML = `
      <div class="overlay layer" id="w-overlay">
        <div class="modal weigh" role="dialog" aria-modal="true" aria-label="Peser la bobine">
          <div class="modal-head"><h3>Peser la bobine</h3><button type="button" class="btn btn-quiet icon-btn" data-wclose aria-label="Fermer">✕</button></div>
          <div class="modal-body">
            <div class="w-title">${swatchHtml(m, true)}<b>${esc(filTitle(m))}${s.label ? ` #${esc(s.label)}` : ''}</b></div>
            <p class="bx-intro">Pose la bobine sur la balance : l’appli retire le poids de la bobine vide et corrige ce qu’il reste de filament.</p>
            <div class="two">
              <label class="field"><span>Poids sur la balance (g)</span><input id="pw-gross" type="number" step="any" min="0" inputmode="decimal"></label>
              <label class="field"><span>Poids de la bobine vide (g)</span><input id="pw-tare" type="number" step="any" min="0" inputmode="decimal" value="${s.tare_g != null ? esc(s.tare_g) : ''}"></label>
            </div>
            <div class="w-presets">Bobine vide : <button type="button" class="fchip" data-tare="140">carton ≈ 140 g</button> <button type="button" class="fchip" data-tare="250">plastique ≈ 250 g</button></div>
            <label class="field"><span>Reste de filament (g)</span><input id="pw-rest" type="number" step="any" min="0" inputmode="decimal"><small class="hint-line">Tu peux aussi saisir directement le reste si tu le connais.</small></label>
            <div class="bx-plan" id="pw-result">Avant : <b>${esc(fmtNum(Math.round(left)))} g</b></div>
            <p class="form-error" id="pw-error" role="alert"></p>
          </div>
          <div class="modal-foot"><span class="grow"></span><button type="button" class="btn" data-wclose>Annuler</button><button type="button" class="btn btn-primary" id="pw-save">Enregistrer le poids</button></div>
        </div>
      </div>`;
    const g = $('#pw-gross'), t = $('#pw-tare'), r = $('#pw-rest');
    const num = (el) => (el.value === '' ? null : Number(el.value));
    const show = () => {
      const rest = num(r);
      $('#pw-result').innerHTML = rest == null ? `Avant : <b>${esc(fmtNum(Math.round(left)))} g</b>` : `Avant : <b>${esc(fmtNum(Math.round(left)))} g</b> → Après : <b>${esc(fmtNum(round1(rest)))} g</b> (${rest - left >= 0 ? '+' : '−'}${esc(fmtNum(Math.abs(round1(rest - left))))} g)`;
    };
    const fromGross = () => { if (num(g) != null && num(t) != null) r.value = String(Math.max(0, round1(num(g) - num(t)))); show(); };
    g.addEventListener('input', fromGross);
    t.addEventListener('input', () => { if (num(g) != null) fromGross(); else if (num(r) != null && num(t) != null) g.value = String(round1(num(r) + num(t))); show(); });
    r.addEventListener('input', () => { if (num(t) != null && num(r) != null) g.value = String(round1(num(r) + num(t))); show(); });
    $('#w-overlay').querySelectorAll('[data-tare]').forEach((b) => b.addEventListener('click', () => { t.value = b.dataset.tare; t.dispatchEvent(new Event('input', { bubbles: true })); }));
    const close = () => { $('#layer-root').innerHTML = ''; };
    $('#w-overlay').querySelectorAll('[data-wclose]').forEach((b) => b.addEventListener('click', close));
    $('#w-overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'w-overlay') close(); });
    g.focus();
    $('#pw-save').addEventListener('click', async () => {
      const err = $('#pw-error');
      err.textContent = '';
      const rest = num(r);
      if (rest == null || rest < 0) { err.textContent = 'Saisis le poids sur la balance, ou directement le reste.'; return; }
      if (num(g) != null && num(t) != null && num(g) < num(t)) { err.textContent = 'Le poids sur la balance est inférieur au poids de la bobine vide : vérifie les deux valeurs.'; return; }
      const delta = round1(rest - left);
      const btn = $('#pw-save');
      btn.disabled = true;
      if (num(t) != null && Number(s.tare_g) !== num(t)) {
        const u = await sb.from('spools').update({ tare_g: num(t) }).eq('id', s.id);
        if (u.error) { err.textContent = `Enregistrement impossible : ${u.error.message}`; btn.disabled = false; return; }
      }
      if (Math.abs(delta) >= 0.05) {
        const mv = await sb.from('stock_moves').insert({ material_id: s.material_id, spool_id: s.id, delta, reason: 'inventory', note: 'Pesée' });
        if (mv.error) { err.textContent = `Enregistrement impossible : ${mv.error.message}`; btn.disabled = false; return; }
      }
      await Promise.all([loadTable('spools'), loadTable('materials'), loadTable('stock_moves')]);
      close();
      render();
      toast(rest <= 0 ? 'Bobine vide : marquée comme terminée' : `Pesée enregistrée : il reste ${fmtNum(round1(rest))} g`);
    });
  }

  async function markDried(id) {
    const s = spoolById(id);
    if (!s) return;
    const today = ymd(new Date());
    const patch = { dried_at: today };
    if (!s.opened_at) patch.opened_at = today;
    const { error } = await sb.from('spools').update(patch).eq('id', id);
    if (error) { toast(`Modification impossible : ${error.message}`, true); return; }
    await loadTable('spools');
    render();
    toast(`Séchage noté : ${filTitle(materialById(s.material_id))}${s.label ? ` #${s.label}` : ''}`);
  }

  /* ------------------------------------------------------------------ */
  /*  Vue : tâches                                                       */
  /* ------------------------------------------------------------------ */
  const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function taskRow(t) {
    const sub = [t.machine_id ? machineName(t.machine_id) : '', t.notes ? t.notes.split('\n')[0] : ''].filter(Boolean).join(' – ');
    const late = !t.done && t.kind === 'task' && t.start_at && new Date(t.end_at || t.start_at) < new Date();
    return `<div class="row ${t.done ? 'is-done' : ''}">
      <button type="button" class="check ${t.done ? 'on' : ''}" data-act="toggle-task" data-id="${t.id}" aria-label="${t.done ? 'Marquer à faire' : 'Marquer terminée'}">${CHECK_SVG}</button>
      <button type="button" class="title" data-act="edit" data-kind="task" data-id="${t.id}">${esc(t.title)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</button>
      <span class="meta">${t.kind === 'rdv' ? '<span class="tag">Rendez-vous</span>' : ''}${t.recurrence && t.recurrence !== 'none' ? `<span class="tag soft">${esc(RECURRENCE_LABEL[t.recurrence])}</span>` : ''}${t.start_at ? `<span class="when ${late ? 'late' : ''}">${esc(fmtDateTime(t.start_at))}</span>` : ''}</span>
      ${t.assignee ? `<span class="avatar small" title="${esc(profileName(t.assignee))}">${esc(initials(profileName(t.assignee)))}</span>` : '<span></span>'}
    </div>`;
  }

  function tasksHtml() {
    let list = state.tasks.slice();
    if (state.taskFilter === 'mine') list = list.filter((t) => t.assignee === state.me.id);
    const byDate = (a, b) => {
      if (!a.start_at && !b.start_at) return new Date(a.created_at) - new Date(b.created_at);
      if (!a.start_at) return 1;
      if (!b.start_at) return -1;
      return new Date(a.start_at) - new Date(b.start_at);
    };
    const open = list.filter((t) => !t.done).sort(byDate);
    const done = list.filter((t) => t.done).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 20);
    return `<div class="list">
      <div><h3>À faire (${open.length})</h3><div class="rows">${open.length ? open.map(taskRow).join('') : '<div class="empty">Rien à faire pour le moment.</div>'}</div></div>
      ${done.length ? `<div><h3>Terminées</h3><div class="rows">${done.map(taskRow).join('')}</div></div>` : ''}
    </div>`;
  }

  /* ------------------------------------------------------------------ */
  /*  Vue : équipe (disponibilités)                                      */
  /* ------------------------------------------------------------------ */
  const AVAIL_LABEL = { present: 'Présent', partial: 'Partiel', absent: 'Absent' };

  function teamHtml() {
    const start = state.teamStart;
    const todayKey = ymd(new Date());
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const head = `<div class="team-row team-head"><div>Collaborateur</div>${days.map((d) => `<div class="${ymd(d) === todayKey ? 'today' : ''}">${esc(fmtDayLong(d))}</div>`).join('')}</div>`;
    const rows = state.profiles.map((p) => {
      const cells = days.map((d) => {
        const key = ymd(d);
        const a = state.availability
          .filter((x) => x.user_id === p.id && x.date_from <= key && x.date_to >= key)
          .sort((x, y) => new Date(y.updated_at) - new Date(x.updated_at))[0];
        const inner = a ? `<span class="pill ${a.kind}">${AVAIL_LABEL[a.kind]}${a.note ? `<small>${esc(a.note)}</small>` : ''}</span>` : '';
        return `<button type="button" class="team-cell ${isWeekend(d) ? 'weekend' : ''}" data-act="${a ? 'edit' : 'newitem'}" data-kind="avail" ${a ? `data-id="${a.id}"` : `data-user="${p.id}" data-date="${key}"`} aria-label="${esc(p.name)}, ${esc(fmtDayLong(d))}">${inner}</button>`;
      }).join('');
      return `<div class="team-row"><div class="team-who"><span class="avatar">${esc(initials(p.name))}</span><span>${esc(p.name)}${p.id === state.me.id ? ' (moi)' : ''}</span></div>${cells}</div>`;
    }).join('');
    return `<div class="team">${head}${rows}</div>`;
  }

  /* ------------------------------------------------------------------ */
  /*  Vue : historique                                                   */
  /* ------------------------------------------------------------------ */
  const FIELD_FR = {
    status: 'statut', due_date: 'échéance', price_chf: 'prix', title: 'titre', client: 'client', notes: 'notes',
    start_at: 'début', end_at: 'fin', machine_id: 'machine', order_id: 'commande', assignee: 'responsable',
    done: 'terminée', kind: 'type', kind: 'type', source: 'origine', stripe_session_id: 'paiement Stripe', member: 'membre', day: 'date', hours: 'heures', activity: 'activité', remaining_g: 'reste (g)', brand: 'marque', filament_type: 'matière', color_name: 'couleur', color_hex: 'teinte', diameter: 'diamètre (mm)', nozzle_min: 'buse min (°C)', nozzle_max: 'buse max (°C)', bed_c: 'plateau (°C)', dry_c: 'séchage (°C)', dry_h: 'séchage (h)', tare_g: 'poids à vide (g)', price_chf: 'prix payé', purchased_at: 'acheté le', supplier: 'fournisseur', location: 'emplacement', opened_at: 'ouverte le', dried_at: 'séchée le', dry_storage: 'stockée au sec', initial_g: 'poids neuf (g)', alert_g: 'seuil d’alerte (g)', label: 'nom', every_h: 'tous les (h)', last_done_at: 'dernier entretien', fail_reason: 'cause de l’échec', done_at: 'terminée le', priority: 'priorité', tags: 'étiquettes', client_id: 'fiche client', duration_h: 'durée (h)', phone: 'téléphone', email: 'e-mail', address: 'adresse', reason: 'raison', reorder_qty: 'quantité à commander', quantity: 'quantité en stock', min_quantity: 'seuil d’alerte', cost_chf: 'prix payé', cost_qty: 'quantité du prix', category: 'catégorie', unit: 'unité', recurrence: 'répétition', recur_until: 'répétition jusqu’au', date_from: 'du', date_to: 'au', user_id: 'personne', note: 'note', name: 'nom'
  };
  const VAL_FR = {
    todo: 'à faire', doing: 'en cours', done: 'terminé', planned: 'planifiée', printing: 'en impression',
    task: 'tâche', rdv: 'rendez-vous', present: 'présent', partial: 'partiel', absent: 'absent', true: 'oui', false: 'non', failed: 'échec', file: 'fichier', before: 'avant', after: 'après', manual: 'saisie manuelle', boutique: 'boutique', active: 'en service', empty: 'terminée', normal: 'normale', urgent: 'urgente', filament: 'filament', wood: 'bois / plaques', other: 'consommable', none: 'aucune', daily: 'chaque jour', weekly: 'chaque semaine', monthly: 'chaque mois', '∅': 'vide'
  };
  const OBJ_FR = { orders: 'la commande', prints: 'l’impression', tasks: 'la tâche', availability: 'la disponibilité', attachments: 'le fichier', materials: 'la matière', comments: 'le commentaire', machine_blocks: 'le blocage', clients: 'la fiche client', print_templates: 'le modèle', maintenance_rules: 'l’entretien', spools: 'la bobine', volunteer_hours: 'les heures de bénévolat' };

  function prettyVal(k, v) {
    if (k === 'machine_id') return state.machines.find((m) => m.id === v)?.name || 'aucune';
    if (k === 'assignee' || k === 'user_id') return state.profiles.find((p) => p.id === v)?.name || 'personne';
    if (k === 'client_id') { const c = clientById(v); return c ? c.name : 'aucune'; }
    if (k === 'tags' && v.startsWith('[')) { try { return JSON.parse(v).join(', ') || 'aucune'; } catch (e) { return v; } }
    if (k === 'order_id') { const o = state.orders.find((x) => x.id === v); return o ? orderLabel(o) : 'aucune'; }
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtDateTime(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtShort(parseYmd(v));
    return VAL_FR[v] ?? v;
  }

  function historyDetail(h) {
    if (h.action !== 'update' || !h.detail) return '';
    return h.detail.split('; ').map((part) => {
      const [k, ...rest] = part.split(' → ');
      return `${FIELD_FR[k] || k} → ${prettyVal(k, rest.join(' → '))}`;
    }).join(' ; ');
  }

  function historyHtml() {
    if (!state.history.length) return '<div class="list"><div class="empty">Aucune modification pour le moment.</div></div>';
    const groups = [];
    state.history.forEach((h) => {
      const key = ymd(new Date(h.at));
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) { g = { key, items: [] }; groups.push(g); }
      g.items.push(h);
    });
    return `<div class="hist">${groups.map((g) => `
      <div><h3>${esc(cap(new Date(g.items[0].at).toLocaleDateString('fr-CH', { weekday: 'long', day: 'numeric', month: 'long' })))}</h3>
      <div class="rows">${g.items.map((h) => {
        const who = h.user_id ? profileName(h.user_id) : 'Le système';
        let verb = { insert: 'a créé', update: 'a modifié', delete: 'a supprimé' }[h.action] || h.action;
        if (h.table_name === 'attachments' || h.table_name === 'comments') verb = h.action === 'insert' ? 'a ajouté' : 'a retiré';
        const det = historyDetail(h);
        return `<div class="hist-item"><span class="time">${esc(fmtTime(h.at))}</span>
          <span class="avatar small">${esc(initials(who))}</span>
          <div><div class="what">${esc(who)} ${verb} ${OBJ_FR[h.table_name] || ''} ${h.summary ? `« ${esc(h.summary)} »` : ''}</div>
          ${det ? `<div class="detail">${esc(det)}</div>` : ''}</div></div>`;
      }).join('')}</div></div>`).join('')}</div>`;
  }

  /* ------------------------------------------------------------------ */
  /*  Formulaires (fenêtres)                                             */
  /* ------------------------------------------------------------------ */
  const clientsOpt = () => state.clients.slice().sort((x, y) => x.name.localeCompare(y.name, 'fr')).map((c) => [c.id, c.name]);
  const people = () => state.profiles.map((p) => [p.id, p.name]);
  const machinesOpt = () => state.machines.map((m) => [m.id, m.name]);
  const ordersOpt = () => state.orders.slice().sort((a, b) => (a.status === 'done') - (b.status === 'done')).map((o) => [o.id, orderLabel(o)]);

  function clientOrdersHtml(c) {
    const os = state.orders.filter((o) => o.client_id === c.id).sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
    const total = os.reduce((s, o) => s + (Number(o.price_chf) || 0), 0);
    const rows = os.map((o) => `<button type="button" class="file link" data-act="edit" data-kind="order" data-id="${o.id}"><span class="nm">${esc(o.title)}</span>
      <span class="sz">${esc((ORDER_STATUS.find((s) => s[0] === o.status) || [])[1] || '')}</span><b>${o.price_chf != null ? esc(fmtMoney(o.price_chf)) : ''}</b></button>`).join('');
    return `<div class="files"><h4>Commandes (${os.length})${total > 0 ? `, total ${esc(fmtMoney(total))}` : ''}</h4>${rows || '<small class="hint-line">Aucune commande liée à cette fiche.</small>'}</div>`;
  }

  function movesHtml(m) {
    const moves = state.stock_moves.filter((x) => x.material_id === m.id).slice(0, 8);
    const rows = moves.map((x) => `<div class="file"><span class="nm">${esc(x.note || { use: 'Utilisation', return: 'Remis en stock', purchase: 'Achat', adjust: 'Correction', inventory: 'Inventaire' }[x.reason] || '')}</span>
      <span class="sz">${esc(fmtDayLong(new Date(x.at)))}</span><b class="${x.delta < 0 ? 'late' : ''}">${x.delta > 0 ? '+' : ''}${esc(fmtNum(x.delta))} ${esc(unitFor(m, x.delta))}</b></div>`).join('');
    return `<div class="files"><h4>En stock : ${esc(fmtNum(m.quantity))} ${esc(unitFor(m, m.quantity))} (pour changer la quantité, utilise « Ajuster » dans la liste)</h4>${rows || '<small class="hint-line">Aucun mouvement.</small>'}</div>`;
  }

  const ACTIVITIES = ['Atelier (impression, entretien)', 'Accueil et événements', 'Réunion', 'Formation', 'Administration', 'Autre'];
  const memberNames = () => [...new Set([...state.profiles.map((p) => p.name), ...state.volunteer_hours.map((h) => h.member)])].sort((x, y) => x.localeCompare(y, 'fr'));

  let pendingAddStock = false;
  const RECURRENCE = [['none', 'Aucune'], ['daily', 'Chaque jour'], ['weekly', 'Chaque semaine'], ['monthly', 'Chaque mois']];
  const RECURRENCE_LABEL = Object.fromEntries(RECURRENCE);

  const KINDS = {
    task: {
      table: 'tasks', names: ['Nouvelle tâche', 'Modifier la tâche'],
      defaults: () => ({ kind: 'task', assignee: state.me.id, done: false, recurrence: 'none' }),
      fields: [
        { k: 'title', l: 'Titre', t: 'text', req: true },
        [{ k: 'kind', l: 'Type', t: 'select', o: () => [['task', 'Tâche'], ['rdv', 'Rendez-vous']] },
          { k: 'assignee', l: 'Responsable', t: 'select', o: people, empty: 'Personne' }],
        [{ k: 'start_at', l: 'Date et heure', t: 'datetime' }, { k: 'end_at', l: 'Fin (facultatif)', t: 'datetime' }],
        [{ k: 'recurrence', l: 'Répétition', t: 'select', o: () => RECURRENCE },
          { k: 'recur_until', l: 'Répéter jusqu’au (facultatif)', t: 'date' }],
        { k: 'machine_id', l: 'Machine concernée (facultatif)', t: 'select', o: machinesOpt, empty: 'Aucune' },
        { k: 'notes', l: 'Notes', t: 'textarea' },
        { k: 'done', l: 'Terminée', t: 'check' }
      ],
      validate: (v) => {
        if (v.start_at && v.end_at && new Date(v.end_at) < new Date(v.start_at)) return 'La fin doit être après le début.';
        if (v.recurrence !== 'none' && !v.start_at) return 'Une tâche qui se répète a besoin d’une date et d’une heure.';
        if (v.recur_until && v.start_at && v.recur_until < v.start_at.slice(0, 10)) return 'La fin de la répétition doit être après le début.';
        return '';
      }
    },
    order: {
      table: 'orders', names: ['Nouvelle commande', 'Modifier la commande'], files: 'order', uses: 'order', comments: true, photos: true,
      defaults: () => ({ status: 'todo', priority: 'normal' }),
      fields: [
        [{ k: 'client_id', l: 'Fiche client', t: 'select', o: clientsOpt, empty: 'Aucune fiche' }, { k: 'priority', l: 'Priorité', t: 'select', o: () => [['normal', 'Normale'], ['urgent', 'Urgente']] }],
        [{ k: 'client', l: 'Nom du client', t: 'text' }, { k: 'status', l: 'État', t: 'select', o: () => ORDER_STATUS }],
        { k: 'title', l: 'Objet de la commande', t: 'text', req: true },
        [{ k: 'due_date', l: 'Échéance', t: 'date' }, { k: 'price_chf', l: 'Prix (CHF)', t: 'number', step: '0.05' }],
        { k: 'tags', l: 'Étiquettes (séparées par des virgules)', t: 'text', hint: 'Exemples : laser, impression 3D, cadeau' },
        { k: 'notes', l: 'Notes', t: 'textarea' }
      ],
      extraHtml: (rec) => (rec && rec.source === 'boutique'
        ? `<div class="files"><h4>Commande de la boutique du site</h4><small class="hint-line">Payée par carte via Stripe${rec.stripe_session_id ? ` (${esc(rec.stripe_session_id)})` : ''}. Le détail des articles et l’adresse sont dans les notes.</small></div>` : ''),
      prepare: (v) => {
        v.tags = v.tags ? v.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
        if (v.client_id && !v.client) { const c = clientById(v.client_id); v.client = c ? c.name : null; }
      }
    },
    client: {
      table: 'clients', names: ['Nouveau client', 'Modifier le client'],
      defaults: () => ({}),
      fields: [
        { k: 'name', l: 'Nom', t: 'text', req: true },
        [{ k: 'phone', l: 'Téléphone', t: 'text' }, { k: 'email', l: 'E-mail', t: 'text' }],
        { k: 'address', l: 'Adresse', t: 'textarea' },
        { k: 'notes', l: 'Notes (préférences, remarques)', t: 'textarea' }
      ],
      extraHtml: (rec) => (rec ? clientOrdersHtml(rec) : '')
    },
    template: {
      table: 'print_templates', names: ['Nouveau modèle d’impression', 'Modifier le modèle'], uses: 'template',
      defaults: () => ({ duration_h: 1 }),
      fields: [
        { k: 'name', l: 'Nom de la pièce', t: 'text', req: true },
        [{ k: 'machine_id', l: 'Machine habituelle', t: 'select', o: machinesOpt, empty: 'Toutes les machines' }, { k: 'duration_h', l: 'Durée (heures)', t: 'number', step: '0.25', req: true }],
        { k: 'notes', l: 'Notes (réglages, filament…)', t: 'textarea' }
      ],
      validate: (v) => (!(v.duration_h > 0) ? 'La durée doit être supérieure à zéro.' : '')
    },
    print: {
      table: 'prints', names: ['Nouvelle impression', 'Modifier l’impression'], files: 'print', uses: 'print',
      defaults: () => {
        const d = startOfDay(new Date());
        return { status: 'planned', machine_id: state.machines[0]?.id || null, start_at: new Date(+d + 8 * 36e5).toISOString(), end_at: new Date(+d + 18 * 36e5).toISOString() };
      },
      fields: [
        { k: 'title', l: 'Pièce à imprimer', t: 'text', req: true },
        [{ k: 'machine_id', l: 'Machine', t: 'select', o: machinesOpt, empty: 'Sans machine' }, { k: 'status', l: 'État', t: 'select', o: () => [['planned', 'Planifiée'], ['printing', 'En impression'], ['done', 'Terminée'], ['failed', 'Échec']] }],
        { k: 'fail_reason', l: 'Cause de l’échec (si échec)', t: 'select', o: () => FAIL_REASONS.map((r) => [r, r]), empty: '—' },
        [{ k: 'start_at', l: 'Début', t: 'datetime', req: true }, { k: 'end_at', l: 'Fin', t: 'datetime', req: true }],
        { k: 'order_id', l: 'Commande liée', t: 'select', o: ordersOpt, empty: 'Aucune' },
        { k: 'notes', l: 'Notes (réglages, filament…)', t: 'textarea' }
      ],
      validate: (v) => {
        if (v.start_at && v.end_at && new Date(v.end_at) <= new Date(v.start_at)) return 'La fin doit être après le début.';
        if (v.status === 'failed' && !v.fail_reason) return 'Indique la cause de l’échec : elle sert aux statistiques.';
        if (v.status !== 'failed') v.fail_reason = null;
        return '';
      },
      warn: (v, rec) => {
        if (!['planned', 'printing'].includes(v.status)) return '';
        const c = printConflicts(v.machine_id, v.start_at, v.end_at, rec && rec.id);
        return c.length ? `Cette impression chevauche ${c.join(' et ')}.` : '';
      }
    },
    block: {
      table: 'machine_blocks', names: ['Bloquer une machine', 'Modifier le blocage'],
      defaults: () => {
        const d = startOfDay(new Date());
        return { machine_id: state.machines[0]?.id || null, reason: 'Entretien', start_at: new Date(+d + 8 * 36e5).toISOString(), end_at: new Date(+d + 18 * 36e5).toISOString() };
      },
      fields: [
        [{ k: 'machine_id', l: 'Machine', t: 'select', o: machinesOpt, req: true }, { k: 'reason', l: 'Raison (entretien, panne…)', t: 'text', req: true }],
        [{ k: 'start_at', l: 'Du', t: 'datetime', req: true }, { k: 'end_at', l: 'Au', t: 'datetime', req: true }]
      ],
      validate: (v) => (v.start_at && v.end_at && new Date(v.end_at) <= new Date(v.start_at) ? 'La fin doit être après le début.' : ''),
      warn: (v) => {
        const c = state.prints.filter((p) => p.machine_id === v.machine_id && isActivePrint(p) && rangesOverlap(new Date(v.start_at), new Date(v.end_at), new Date(p.start_at), new Date(p.end_at))).map((p) => `l’impression « ${p.title} »`);
        return c.length ? `Ce blocage chevauche ${c.join(' et ')}.` : '';
      }
    },
    material: {
      table: 'materials', names: ['Nouvelle matière', 'Modifier la matière'],
      defaults: () => ({ category: 'filament', unit: 'g', min_quantity: 200, cost_qty: 1000 }),
      fields: (rec) => [
        { k: 'name', l: 'Nom (ex. PLA noir Bambu Lab)', t: 'text', req: true },
        [{ k: 'category', l: 'Catégorie', t: 'select', o: () => MAT_CATS }, { k: 'unit', l: 'Unité de stock', t: 'select', o: () => MAT_UNITS }],
        ...(rec ? [] : [{ k: 'quantity', l: 'Quantité actuelle en stock', t: 'number', step: 'any', hint: 'Dans l’unité choisie, par exemple 1000 pour une bobine de 1 kg.' }]),
        [{ k: 'min_quantity', l: 'Alerte quand le stock passe sous', t: 'number', step: 'any', hint: 'Laisse 0 pour ne pas être prévenu.' },
          { k: 'reorder_qty', l: 'Quantité habituelle à commander', t: 'number', step: 'any', hint: 'Sert à la liste « à racheter ».' }],
        [{ k: 'cost_chf', l: 'Prix payé (CHF)', t: 'number', step: '0.01' }, { k: 'cost_qty', l: 'pour une quantité de', t: 'number', step: 'any', req: true }],
        { k: 'notes', l: 'Notes (fournisseur, couleur, référence)', t: 'textarea' }
      ],
      extraHtml: (rec) => (rec ? movesHtml(rec) : '<small class="hint-line">Exemple de prix : 25 CHF pour 1000 g, ou 12 CHF pour 1 plaque.</small>'),
      validate: (v) => (!(v.cost_qty > 0) ? 'La quantité du prix doit être supérieure à zéro.' : '')
    },
    maintenance: {
      table: 'maintenance_rules', names: ['Nouvel entretien', 'Modifier l’entretien'],
      defaults: () => ({ machine_id: state.machines[0]?.id || null, every_h: 200, last_done_at: new Date().toISOString() }),
      fields: [
        { k: 'name', l: 'Entretien (ex. graisser les axes)', t: 'text', req: true },
        [{ k: 'machine_id', l: 'Machine', t: 'select', o: machinesOpt, req: true }, { k: 'every_h', l: 'Tous les (heures d’impression)', t: 'number', step: '10', req: true }],
        { k: 'last_done_at', l: 'Dernier entretien fait le', t: 'datetime', req: true },
        { k: 'notes', l: 'Notes (pièce, produit, procédure)', t: 'textarea' }
      ],
      validate: (v) => (!(v.every_h > 0) ? 'Indique un nombre d’heures supérieur à zéro.' : '')
    },
    filament: {
      table: 'materials', names: ['Nouveau filament', 'Modifier le filament'],
      defaults: () => ({ category: 'filament', unit: 'g', min_quantity: 200, cost_qty: 1000, filament_type: 'PLA', diameter: 1.75, color_hex: '#222222', nozzle_min: 190, nozzle_max: 220, bed_c: 60, dry_c: 45, dry_h: 5 }),
      fields: [
        [{ k: 'brand', l: 'Marque', t: 'text', suggest: () => [...new Set(state.materials.map((m) => m.brand).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'fr')) },
          { k: 'filament_type', l: 'Matière', t: 'select', o: () => FIL_TYPE_LIST.map((t) => [t, t]) }],
        [{ k: 'color_name', l: 'Couleur (nom)', t: 'text' }, { k: 'color_hex', l: 'Teinte', t: 'color' }],
        [{ k: 'diameter', l: 'Diamètre (mm)', t: 'number', step: '0.05' }, { k: 'bed_c', l: 'Plateau (°C)', t: 'number', step: '5' }],
        [{ k: 'nozzle_min', l: 'Buse min (°C)', t: 'number', step: '5' }, { k: 'nozzle_max', l: 'Buse max (°C)', t: 'number', step: '5' }],
        [{ k: 'dry_c', l: 'Séchage (°C)', t: 'number', step: '5' }, { k: 'dry_h', l: 'Séchage (heures)', t: 'number', step: '1' }],
        [{ k: 'cost_chf', l: 'Prix habituel (CHF)', t: 'number', step: '0.01' }, { k: 'cost_qty', l: 'pour (g)', t: 'number', step: 'any', req: true }],
        [{ k: 'min_quantity', l: 'Alerte quand le stock passe sous (g)', t: 'number', step: 'any' }, { k: 'reorder_qty', l: 'Quantité habituelle à commander (g)', t: 'number', step: 'any' }],
        { k: 'name', l: 'Nom affiché (facultatif : sinon marque + matière + couleur)', t: 'text' },
        { k: 'notes', l: 'Notes (fournisseur, référence, particularités)', t: 'textarea' }
      ],
      extraHtml: (rec) => `<small class="hint-line">Températures et séchage : valeurs indicatives, la notice du fabricant fait foi. Le stock se règle avec « Ajuster » (page Stock) ou en ajoutant une bobine achetée.</small>${rec ? movesHtml(rec) : ''}`,
      setup: (form) => {
        const sel = form.querySelector('#f_filament_type');
        let prev = sel.value;
        sel.addEventListener('change', () => {
          const t = FIL_TYPES[sel.value] || {};
          const p = FIL_TYPES[prev] || {};
          const fill = (id, val, old) => { const el = form.querySelector(`#f_${id}`); if (el && val != null && (el.value === '' || Number(el.value) === old)) el.value = val; };
          fill('nozzle_min', t.nozzle && t.nozzle[0], p.nozzle && p.nozzle[0]);
          fill('nozzle_max', t.nozzle && t.nozzle[1], p.nozzle && p.nozzle[1]);
          fill('bed_c', t.bed, p.bed);
          fill('dry_c', t.dry && t.dry[0], p.dry && p.dry[0]);
          fill('dry_h', t.dry && t.dry[1], p.dry && p.dry[1]);
          prev = sel.value;
        });
      },
      prepare: (v) => {
        v.category = 'filament';
        v.unit = 'g';
        if (!v.name) v.name = [v.brand, v.filament_type, v.color_name].filter(Boolean).join(' ') || 'Filament';
      },
      validate: (v) => (!(v.cost_qty > 0) ? 'La quantité du prix doit être supérieure à zéro.' : '')
    },
    spool: {
      table: 'spools', names: ['Nouvelle bobine', 'Modifier la bobine'],
      defaults: () => ({ initial_g: 1000, remaining_g: 1000, alert_g: 100, status: 'active', dry_storage: false }),
      fields: (rec) => [
        { k: 'material_id', l: 'Matière (filament)', t: 'select', o: () => state.materials.filter((m) => m.unit === 'g').map((m) => [m.id, m.name]), req: true },
        [{ k: 'label', l: 'Nom ou numéro (facultatif)', t: 'text' }, { k: 'machine_id', l: 'Chargée dans', t: 'select', o: machinesOpt, empty: 'Pas chargée' }],
        [{ k: 'initial_g', l: 'Poids neuf (g)', t: 'number', step: 'any', req: true }, { k: 'remaining_g', l: 'Reste (g)', t: 'number', step: 'any', req: true }],
        [{ k: 'tare_g', l: 'Poids de la bobine vide (g)', t: 'number', step: 'any', hint: 'Sert à la pesée : carton ≈ 140 g, plastique ≈ 250 g.' }, { k: 'alert_g', l: 'Prévenir sous (g)', t: 'number', step: 'any' }],
        [{ k: 'price_chf', l: 'Prix payé pour cette bobine (CHF)', t: 'number', step: '0.01' }, { k: 'purchased_at', l: 'Achetée le', t: 'date' }],
        [{ k: 'supplier', l: 'Fournisseur', t: 'text' }, { k: 'location', l: 'Emplacement (étagère, boîte)', t: 'text' }],
        [{ k: 'opened_at', l: 'Ouverte le', t: 'date' }, { k: 'dried_at', l: 'Dernier séchage', t: 'date' }],
        { k: 'dry_storage', l: 'Stockée au sec (boîte étanche avec dessiccant) : pas de rappel de séchage', t: 'check' },
        { k: 'status', l: 'État', t: 'select', o: () => [['active', 'En service'], ['empty', 'Terminée']] },
        ...(rec ? [] : [{ k: 'addstock', l: 'Ajouter aussi cette bobine au stock de la matière (achat pas encore compté)', t: 'check' }]),
        { k: 'notes', l: 'Notes (couleur exacte, lot, particularités)', t: 'textarea' }
      ],
      prepare: (v) => { if (v.alert_g == null) v.alert_g = 100; pendingAddStock = !!v.addstock; delete v.addstock; },
      afterSave: async (data, v, rec) => {
        if (rec || !pendingAddStock || !data || !(Number(data.remaining_g) > 0)) return;
        const { error } = await sb.from('stock_moves').insert({ material_id: data.material_id, delta: Number(data.remaining_g), reason: 'purchase', note: `Bobine ajoutée${data.label ? ` (${data.label})` : ''}` });
        if (error) throw error;
        await Promise.all([loadTable('materials'), loadTable('stock_moves')]);
      },
      validate: (v) => (!(v.initial_g > 0) ? 'Le poids neuf doit être supérieur à zéro.' : '')
    },
    volunteer: {
      table: 'volunteer_hours', names: ['Nouvelles heures de bénévolat', 'Modifier les heures'],
      defaults: () => ({ member: (state.profiles.find((p) => p.id === state.me.id) || {}).name || '', day: ymd(new Date()), hours: 2, activity: ACTIVITIES[0] }),
      fields: [
        { k: 'member', l: 'Membre', t: 'text', req: true, suggest: () => memberNames() },
        [{ k: 'day', l: 'Date', t: 'date', req: true }, { k: 'hours', l: 'Heures', t: 'number', step: '0.25', req: true }],
        { k: 'activity', l: 'Activité', t: 'select', o: () => ACTIVITIES.map((x) => [x, x]) },
        { k: 'note', l: 'Note (facultatif)', t: 'text' }
      ],
      prepare: (v) => { if (v.member) v.member = v.member.trim(); },
      validate: (v) => (!(v.hours > 0 && v.hours <= 24) ? 'Les heures doivent être comprises entre 0 et 24.' : '')
    },
    avail: {
      table: 'availability', names: ['Nouvelle disponibilité', 'Modifier la disponibilité'],
      defaults: () => ({ user_id: state.me.id, kind: 'absent', date_from: ymd(new Date()), date_to: ymd(new Date()) }),
      fields: [
        [{ k: 'user_id', l: 'Collaborateur', t: 'select', o: people }, { k: 'kind', l: 'État', t: 'select', o: () => [['absent', 'Absent'], ['partial', 'Partiel'], ['present', 'Présent']] }],
        [{ k: 'date_from', l: 'Du', t: 'date', req: true }, { k: 'date_to', l: 'Au', t: 'date', req: true }],
        { k: 'note', l: 'Note (vacances, matin seulement…)', t: 'text' }
      ],
      validate: (v) => (v.date_from && v.date_to && v.date_to < v.date_from ? 'La date de fin doit être après la date de début.' : '')
    }
  };

  function fieldHtml(f, v) {
    const id = `f_${f.k}`;
    if (f.t === 'check') return `<label class="checkline"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}><span>${esc(f.l)}</span></label>`;
    let input;
    if (f.t === 'textarea') {
      input = `<textarea id="${id}">${esc(v ?? '')}</textarea>`;
    } else if (f.t === 'select') {
      input = `<select id="${id}">${f.empty ? `<option value="">${esc(f.empty)}</option>` : ''}${f.o().map(([val, lab]) => `<option value="${esc(val)}" ${val === v ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
    } else {
      const type = { text: 'text', number: 'number', date: 'date', datetime: 'datetime-local', color: 'color' }[f.t];
      const val = f.t === 'datetime' ? toLocalInput(v) : f.t === 'color' ? (v || '#222222') : (v ?? '');
      input = `<input id="${id}" type="${type}" value="${esc(val)}" ${f.step ? `step="${f.step}"` : ''} ${f.req ? 'required' : ''} ${f.suggest ? `list="sl_${f.k}"` : ''}>`;
      if (f.suggest) input += `<datalist id="sl_${f.k}">${f.suggest().map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;
    }
    return `<label class="field"><span>${esc(f.l)}</span>${input}${f.hint ? `<small class="hint-line">${esc(f.hint)}</small>` : ''}</label>`;
  }

  function readForm(fields, root) {
    const out = {};
    for (const f of flat(fields)) {
      const el = root.querySelector(`#f_${f.k}`);
      let v;
      if (f.t === 'check') v = el.checked;
      else if (f.t === 'datetime') v = fromLocalInput(el.value);
      else if (f.t === 'number') v = el.value === '' ? null : Number(el.value);
      else { v = el.value.trim(); if (v === '') v = null; }
      out[f.k] = v;
    }
    return out;
  }

  function closeModal() {
    $('#modal-root').innerHTML = '';
    state.modalRefresh = null;
    state.openOrderId = null;
  }

  function openForm(kind, id, preset = {}) {
    const def = KINDS[kind];
    const rec = id ? state[def.table].find((r) => r.id === id) : null;
    if (id && !rec) return;
    const vals = rec ? { ...rec } : { ...def.defaults(), ...preset };
    Object.keys(vals).forEach((k) => { if (Array.isArray(vals[k])) vals[k] = vals[k].join(', '); });
    const queue = []; // fichiers en attente d'envoi
    const fields = typeof def.fields === 'function' ? def.fields(rec) : def.fields;

    const body = fields.map((f) => (Array.isArray(f)
      ? `<div class="two">${f.map((x) => fieldHtml(x, vals[x.k])).join('')}</div>`
      : fieldHtml(f, vals[f.k]))).join('');

    const filesHtml = def.files ? `
      <div class="files"><h4>Fichiers joints (STL, plans, documents)</h4><div id="file-list"></div>
        <label class="btn btn-small" style="width:fit-content">Ajouter des fichiers<input type="file" id="file-input" multiple hidden></label></div>` : '';

    const useKey = def.uses === 'print' ? 'print_id' : def.uses === 'order' ? 'order_id' : def.uses === 'template' ? 'template_id' : null;
    const useRows = useKey && rec ? state.material_uses.filter((u) => u[useKey] === rec.id).map((u) => ({ id: u.id, material_id: u.material_id, qty: u.qty })) : [];
    const usesHtml = useKey ? `
      <div class="files uses"><h4>${def.uses === 'print' ? 'Matières utilisées (poids du filament, plaques…)' : def.uses === 'template' ? 'Matières nécessaires pour cette pièce' : 'Matières ajoutées à la commande (vis, colle, emballages…)'}</h4>
        <div id="use-list"></div>
        <div><button type="button" class="btn btn-small" id="use-add">+ Matière</button></div>
        <div class="cost-box" id="cost-box"></div></div>` : '';
    const extraHtml = def.extraHtml ? def.extraHtml(rec) : '';
    const tplHtml = def.table === 'prints' && !rec && state.print_templates.length ? `
      <label class="field"><span>Partir d’un modèle (facultatif)</span>
        <select id="tpl-select"><option value="">Aucun modèle</option>${state.print_templates.slice().sort((x, y) => x.name.localeCompare(y.name, 'fr')).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>` : '';
    const commentsHtml = def.comments ? (rec ? `
      <div class="files comments"><h4>Commentaires de l’équipe</h4>
        <div id="comment-list" class="comment-list"></div>
        <div class="comment-new"><textarea id="comment-input" placeholder="Écris un message à l’équipe… (Ctrl + Entrée pour envoyer)"></textarea>
          <button type="button" class="btn btn-small btn-primary" id="comment-send">Envoyer</button></div></div>`
      : '<div class="files comments"><h4>Commentaires de l’équipe</h4><small class="hint-line">Enregistre d’abord la commande pour pouvoir écrire un commentaire.</small></div>') : '';
    const photosHtml = def.photos ? (rec ? `
      <div class="files photos"><h4>Photos avant et après</h4>
        <div class="photo-cols">${['before', 'after'].map((k) => `
          <div class="photo-col"><div class="photo-head"><span>${k === 'before' ? 'Avant' : 'Après'}</span>
            <label class="btn btn-small">Ajouter<input type="file" accept="image/*" multiple hidden data-photo-input="${k}"></label></div>
            <div class="photo-grid" id="photos-${k}"></div></div>`).join('')}</div></div>`
      : '<div class="files photos"><h4>Photos avant et après</h4><small class="hint-line">Enregistre d’abord la commande pour pouvoir ajouter des photos.</small></div>') : '';
    state.openOrderId = def.comments && rec ? rec.id : null;

    $('#modal-root').innerHTML = `
      <div class="overlay" id="overlay">
        <form class="modal" id="mform" role="dialog" aria-modal="true" aria-label="${esc(def.names[rec ? 1 : 0])}">
          <div class="modal-head"><h3>${esc(def.names[rec ? 1 : 0])}</h3>
            <button type="button" class="btn btn-quiet icon-btn" data-close aria-label="Fermer">✕</button></div>
          <div class="modal-body">${tplHtml}${body}${usesHtml}${photosHtml}${filesHtml}${commentsHtml}${extraHtml}<p class="form-error" id="form-error" role="alert"></p></div>
          <div class="modal-foot">
            ${rec ? '<button type="button" class="btn btn-danger" id="btn-delete">Supprimer</button>' : ''}
            ${rec && def.table === 'prints' ? '<button type="button" class="btn" id="btn-template">Enregistrer comme modèle</button>' : ''}
            ${rec && (def.table === 'orders' || def.table === 'materials' || def.table === 'spools') ? '<button type="button" class="btn" id="btn-label">Étiquette QR</button>' : ''}
            ${rec && def.table === 'orders' ? `<button type="button" class="btn" id="btn-plan" data-act="plan" data-order="${rec.id}">Planifier les impressions</button>` : ''}
            <span class="grow"></span>
            <button type="button" class="btn" data-close>Annuler</button>
            <button type="submit" class="btn btn-primary" id="btn-save">Enregistrer</button>
          </div>
        </form>
      </div>`;

    const form = $('#mform');
    const ov = $('#overlay');
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeModal(); });
    form.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
    if (def.setup) def.setup(form, rec);
    const first = form.querySelector('input:not([type=checkbox]), select');
    if (first && !rec) first.focus();

    /* matières utilisées */
    const matOptions = (sel) => `<option value="">Choisir une matière…</option>${MAT_CATS.map(([k, label]) => {
      const items = state.materials.filter((m) => m.category === k).sort((x, y) => x.name.localeCompare(y.name, 'fr'));
      return items.length ? `<optgroup label="${esc(label)}">${items.map((m) => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>` : '';
    }).join('')}`;

    function refreshCost() {
      const box = $('#cost-box');
      if (!box) return;
      const rows = useRows.filter((r) => r.material_id && Number(r.qty) > 0);
      let html = '';
      if (def.uses === 'print' || def.uses === 'template') {
        const c = costOfRows(rows);
        html = rows.length ? `Coût matière estimé : <b>${esc(fmtMoney(c.total))}</b>` : '';
        if (c.missing.length) html += `<small class="hint-line">Prix manquant pour : ${esc(c.missing.join(', '))}</small>`;
        const mach = $('#f_machine_id') ? $('#f_machine_id').value : '';
        if (def.uses === 'print' && mach) {
          rows.forEach((r) => {
            const m = materialById(r.material_id);
            if (!m || m.unit !== 'g') return;
            const sp = loadedSpool(m.id, mach);
            html += sp
              ? `<small class="hint-line">${esc(m.name)} : bobine ${esc(sp.label || '')} dans ${esc(machineName(mach))}, ${esc(fmtNum(Math.round(spoolLeft(sp))))} g avant l’impression, ${esc(fmtNum(Math.max(0, Math.round(spoolLeft(sp) - Number(r.qty)))))} g après.${spoolLeft(sp) < Number(r.qty) ? ' Attention : la bobine ne suffit pas.' : ''}</small>`
              : `<small class="hint-line">${esc(m.name)} : aucune bobine chargée dans ${esc(machineName(mach))}, seul le stock de la matière baissera.</small>`;
          });
        }
      } else {
        const c = orderCost(rec ? rec.id : null, rows);
        const priceEl = $('#f_price_chf');
        const price = priceEl && priceEl.value !== '' ? Number(priceEl.value) : null;
        const hours = rec ? printHours(rec.id) : '';
        const lines = [];
        if (c.prints > 0) lines.push(`Impressions liées : ${esc(fmtMoney(c.prints))}`);
        if (c.extras > 0) lines.push(`Matières ajoutées : ${esc(fmtMoney(c.extras))}`);
        if (lines.length || c.total > 0) {
          html = `${lines.join('<br>')}<div>Coût matière : <b>${esc(fmtMoney(c.total))}</b></div>`;
          if (price != null && !Number.isNaN(price)) html += `<div>Prix de vente ${esc(fmtMoney(price))}, il reste <b>${esc(fmtMoney(price - c.total))}</b> après la matière</div>`;
        }
        if (hours) html += `<small class="hint-line">Temps d’impression planifié : ${esc(hours)}</small>`;
        if (c.missing.length) html += `<small class="hint-line">Prix manquant pour : ${esc(c.missing.join(', '))}</small>`;
      }
      box.innerHTML = html;
      box.classList.toggle('hidden', !html);
    }

    function renderUses() {
      const list = $('#use-list');
      if (!list) return;
      list.innerHTML = useRows.length ? useRows.map((r, i) => {
        const m = materialById(r.material_id);
        return `<div class="use-row" data-i="${i}">
          <select data-f="m" aria-label="Matière">${matOptions(r.material_id)}</select>
          <input type="number" data-f="q" min="0" step="any" value="${esc(r.qty ?? '')}" aria-label="Quantité utilisée">
          <span class="unit">${esc(m ? m.unit : '')}</span>
          <button type="button" class="x" data-f="x" aria-label="Retirer cette matière">✕</button></div>`;
      }).join('') : '<div class="hint-line">Aucune matière notée.</div>';
      refreshCost();
    }
    function applyTemplate(t) {
      const set = (sel, val) => { const el = $(sel); if (el && val != null) el.value = val; };
      set('#f_title', t.name);
      if (t.machine_id) set('#f_machine_id', t.machine_id);
      const st = $('#f_start_at');
      if (st && st.value) set('#f_end_at', toLocalInput(new Date(new Date(st.value).getTime() + Number(t.duration_h) * 36e5).toISOString()));
      const notes = $('#f_notes');
      if (notes && !notes.value) notes.value = t.notes || '';
      useRows.length = 0;
      state.material_uses.filter((u) => u.template_id === t.id).forEach((u) => useRows.push({ material_id: u.material_id, qty: u.qty }));
      renderUses();
    }
    if (useKey) {
      renderUses();
      const tsel = $('#tpl-select');
      if (tsel) tsel.addEventListener('change', (e) => { const t = state.print_templates.find((x) => x.id === e.target.value); if (t) applyTemplate(t); });
      if (preset.templateId) { const t = state.print_templates.find((x) => x.id === preset.templateId); if (t) { applyTemplate(t); if (tsel) tsel.value = t.id; } }
      $('#use-add').addEventListener('click', () => { useRows.push({ material_id: '', qty: '' }); renderUses(); });
      const ul = $('#use-list');
      ul.addEventListener('change', (e) => {
        const row = e.target.closest('.use-row');
        if (!row) return;
        const r = useRows[Number(row.dataset.i)];
        if (e.target.dataset.f === 'm') { r.material_id = e.target.value; renderUses(); }
        if (e.target.dataset.f === 'q') { r.qty = e.target.value; refreshCost(); }
      });
      ul.addEventListener('input', (e) => {
        const row = e.target.closest('.use-row');
        if (row && e.target.dataset.f === 'q') { useRows[Number(row.dataset.i)].qty = e.target.value; refreshCost(); }
      });
      ul.addEventListener('click', (e) => {
        const x = e.target.closest('[data-f="x"]');
        if (x) { useRows.splice(Number(x.closest('.use-row').dataset.i), 1); renderUses(); }
      });
      const priceEl = $('#f_price_chf');
      if (priceEl) priceEl.addEventListener('input', refreshCost);
      const machEl = $('#f_machine_id');
      if (machEl && def.uses === 'print') machEl.addEventListener('change', refreshCost);
    }

    const tplBtn = $('#btn-template');
    if (tplBtn) {
      tplBtn.addEventListener('click', async () => {
        tplBtn.disabled = true;
        const hours = Math.max(0.25, Math.round(((new Date(rec.end_at) - new Date(rec.start_at)) / 36e5) * 4) / 4);
        const { data, error } = await sb.from('print_templates').insert({ name: rec.title, machine_id: rec.machine_id, duration_h: hours, notes: rec.notes }).select().single();
        if (error) { toast(`Modèle non créé : ${error.message}`, true); tplBtn.disabled = false; return; }
        for (const r of useRows) {
          if (!r.material_id || !(Number(r.qty) > 0)) continue;
          const e2 = await sb.from('material_uses').insert({ template_id: data.id, material_id: r.material_id, qty: Number(r.qty) });
          if (e2.error) { toast(`Matières du modèle non enregistrées : ${e2.error.message}`, true); break; }
        }
        await Promise.all([loadTable('print_templates'), loadTable('material_uses')]);
        render();
        tplBtn.disabled = false;
        toast(`Modèle créé : ${rec.title}`);
      });
    }

    const clientSel = $('#f_client_id');
    if (clientSel) {
      clientSel.addEventListener('change', () => {
        const c = clientById(clientSel.value);
        const nameEl = $('#f_client');
        if (c && nameEl && (!nameEl.value.trim() || state.clients.some((x) => x.name === nameEl.value.trim()))) nameEl.value = c.name;
      });
    }

    /* photos avant / après */
    async function renderPhotos() {
      if (!def.photos || !rec) return;
      const photos = state.attachments.filter((x) => x.parent_type === 'order' && x.parent_id === rec.id && (x.kind === 'before' || x.kind === 'after'));
      await signedUrls(photos.map((p) => p.path));
      ['before', 'after'].forEach((k) => {
        const el = $(`#photos-${k}`);
        if (!el) return;
        const items = photos.filter((p) => p.kind === k);
        el.innerHTML = items.length ? items.map((p) => {
          const u = photoCache.get(p.path);
          return `<div class="thumb"><button type="button" data-photo="${p.id}" title="${esc(p.name)}">${u ? `<img src="${esc(u.url)}" alt="${esc(p.name)}">` : '<span class="thumb-ph">Photo</span>'}</button>
            <button type="button" class="x" data-del-photo="${p.id}" aria-label="Retirer cette photo">✕</button></div>`;
        }).join('') : '<div class="hint-line">Aucune photo</div>';
      });
    }
    if (def.photos && rec) {
      renderPhotos();
      const box = $('.photos');
      box.addEventListener('change', async (e) => {
        const input = e.target.closest('[data-photo-input]');
        if (!input) return;
        const kind = input.dataset.photoInput;
        const list = [...input.files];
        input.value = '';
        if (!list.length) return;
        toast(`Envoi de ${list.length} photo${list.length > 1 ? 's' : ''}…`);
        try {
          for (const f of list) await uploadFile('order', rec.id, await shrinkImage(f), kind);
        } catch (ex) { toast(`Photo non envoyée : ${ex.message}`, true); }
        await loadTable('attachments');
        await renderPhotos();
        render();
      });
      box.addEventListener('click', async (e) => {
        const del = e.target.closest('[data-del-photo]');
        const open = e.target.closest('[data-photo]');
        if (del) {
          if (window.confirm('Retirer cette photo ?')) { await removeAttachment(del.dataset.delPhoto); await renderPhotos(); render(); }
        } else if (open) {
          const p = state.attachments.find((x) => x.id === open.dataset.photo);
          const u = p && photoCache.get(p.path);
          if (u) openLightbox(u.url, p.name);
        }
      });
    }
    const labelBtn = $('#btn-label');
    if (labelBtn) labelBtn.addEventListener('click', () => openLabelDialog(def.table === 'orders' ? 'C' : def.table === 'spools' ? 'S' : 'M', rec.id));
    // nouvelle bobine : le reste suit le poids neuf tant qu'on ne l'a pas modifié
    const initEl = $('#f_initial_g');
    if (initEl && !rec) {
      let prev = initEl.value;
      initEl.addEventListener('input', () => {
        const rem = $('#f_remaining_g');
        if (rem && rem.value === prev) rem.value = initEl.value;
        prev = initEl.value;
      });
    }

    /* pièces jointes */
    function renderFiles() {
      if (!def.files) return;
      const existing = rec ? state.attachments.filter((a) => a.parent_type === def.files && a.parent_id === rec.id && (!a.kind || a.kind === 'file')) : [];
      const list = $('#file-list');
      if (!list) return;
      list.innerHTML = existing.map((a) => `
        <div class="file"><button type="button" class="nm" data-open-file="${a.id}" title="Ouvrir">${esc(a.name)}</button><span class="sz">${fmtSize(a.size)}</span>
          <button type="button" class="x" data-del-file="${a.id}" aria-label="Retirer ${esc(a.name)}">✕</button></div>`).join('')
        + queue.map((f, i) => `
        <div class="file pending"><span class="nm">${esc(f.name)}</span><span class="sz">${fmtSize(f.size)} (envoi à l’enregistrement)</span>
          <button type="button" class="x" data-rm-pending="${i}" aria-label="Retirer ${esc(f.name)}">✕</button></div>`).join('');
    }
    renderFiles();

    /* commentaires */
    function renderComments() {
      const list = $('#comment-list');
      if (!list || !rec) return;
      const items = commentsOf(rec.id);
      list.innerHTML = items.length ? items.map((c) => `
        <div class="comment"><span class="avatar small">${esc(initials(profileName(c.created_by)))}</span>
          <div class="cbody"><div class="chead"><b>${esc(profileName(c.created_by))}</b><span>${esc(fmtDateTime(c.created_at))}</span>
            <button type="button" class="x" data-del-comment="${c.id}" aria-label="Supprimer ce commentaire">✕</button></div>
            <div class="ctext">${esc(c.body)}</div></div></div>`).join('') : '<div class="hint-line">Aucun commentaire pour le moment.</div>';
      list.scrollTop = list.scrollHeight;
    }
    async function sendComment() {
      const input = $('#comment-input');
      const body = input.value.trim();
      if (!body) return;
      const btn = $('#comment-send');
      btn.disabled = true;
      const { error } = await sb.from('comments').insert({ order_id: rec.id, body });
      btn.disabled = false;
      if (error) { toast(`Commentaire non envoyé : ${error.message}`, true); return; }
      input.value = '';
      await loadTable('comments');
      renderComments();
      render();
    }
    if (def.comments && rec) {
      renderComments();
      if (unreadOf(rec.id) > 0) markRead(rec.id);
      $('#comment-send').addEventListener('click', sendComment);
      $('#comment-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendComment(); }
      });
      $('#comment-list').addEventListener('click', async (e) => {
        const del = e.target.closest('[data-del-comment]');
        if (!del || !window.confirm('Supprimer ce commentaire ?')) return;
        const { error } = await sb.from('comments').delete().eq('id', del.dataset.delComment);
        if (error) { toast(`Suppression impossible : ${error.message}`, true); return; }
        await loadTable('comments');
        renderComments();
        render();
      });
    }
    state.modalRefresh = () => {
      renderFiles();
      renderPhotos();
      renderComments();
      if (def.comments && rec && unreadOf(rec.id) > 0) markRead(rec.id);
    };

    if (def.files) {
      $('#file-input').addEventListener('change', (e) => {
        queue.push(...e.target.files);
        e.target.value = '';
        renderFiles();
      });
      $('#file-list').addEventListener('click', async (e) => {
        const open = e.target.closest('[data-open-file]');
        const del = e.target.closest('[data-del-file]');
        const rm = e.target.closest('[data-rm-pending]');
        if (open) await openAttachment(open.dataset.openFile);
        if (rm) { queue.splice(Number(rm.dataset.rmPending), 1); renderFiles(); }
        if (del && window.confirm('Retirer ce fichier ?')) {
          await removeAttachment(del.dataset.delFile);
          renderFiles();
        }
      });
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#form-error');
      err.textContent = '';
      const v = readForm(fields, form);
      const bad = flat(fields).find((f) => f.req && (v[f.k] == null || v[f.k] === ''));
      if (bad) { err.textContent = `Le champ « ${bad.l} » est obligatoire.`; return; }
      const msg = def.validate ? def.validate(v) : '';
      if (msg) { err.textContent = msg; return; }
      const warn = def.warn ? def.warn(v, rec) : '';
      if (warn && !window.confirm(`${warn}\n\nEnregistrer quand même ?`)) return;

      if (def.prepare) def.prepare(v);
      let initialQty = 0;
      if (def.table === 'materials') {
        if (!rec) initialQty = Number(v.quantity) || 0;
        delete v.quantity;
        v.min_quantity = v.min_quantity ?? 0;
        v.cost_qty = v.cost_qty ?? 1;
      }
      if (useKey) {
        const bad2 = useRows.find((r) => (r.material_id && !(Number(r.qty) > 0)) || (!r.material_id && r.qty !== '' && r.qty != null));
        if (bad2) { err.textContent = 'Chaque matière doit avoir une quantité supérieure à zéro (ou retire la ligne).'; return; }
      }

      const btn = $('#btn-save');
      btn.disabled = true;
      btn.textContent = 'Enregistrement…';
      const q = rec
        ? sb.from(def.table).update(v).eq('id', rec.id).select().single()
        : sb.from(def.table).insert(v).select().single();
      const { data, error } = await q;
      if (error) {
        err.textContent = `Enregistrement impossible : ${error.message}`;
        btn.disabled = false;
        btn.textContent = 'Enregistrer';
        return;
      }
      if (initialQty) {
        const mv = await sb.from('stock_moves').insert({ material_id: data.id, delta: initialQty, reason: 'inventory', note: 'Stock initial' });
        if (mv.error) toast(`Stock initial non enregistré : ${mv.error.message}`, true);
      }
      if (def.afterSave) {
        try { await def.afterSave(data, v, rec); } catch (ex) { toast(`Étape supplémentaire non enregistrée : ${ex.message}`, true); }
      }
      if (useKey) {
        try { await saveUses(useKey, data.id, useRows); } catch (ex) { toast(`Matières non enregistrées : ${ex.message}`, true); }
      }
      if (def.files && queue.length) {
        try {
          for (const f of queue) await uploadFile(def.files, data.id, f);
        } catch (ex) {
          toast(`Fichier non envoyé : ${ex.message}`, true);
        }
        await loadTable('attachments');
      }
      await Promise.all([loadTable(def.table), ...(useKey || def.table === 'materials' ? ['materials', 'material_uses', 'stock_moves'].map(loadTable) : [])]);
      closeModal();
      render();
      toast('Enregistré');
    });

    const delBtn = $('#btn-delete');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!window.confirm(TRASH_TABLES.has(def.table) ? 'Mettre à la corbeille ? Tu pourras le restaurer pendant 30 jours.' : def.table === 'materials' ? 'Supprimer cette matière et son historique de stock ?' : 'Supprimer définitivement cet élément ?')) return;
        delBtn.disabled = true;
        if (def.files && !TRASH_TABLES.has(def.table)) {
          const atts = state.attachments.filter((a) => a.parent_type === def.files && a.parent_id === rec.id);
          for (const a of atts) await removeAttachment(a.id, true);
        }
        const { error } = await sb.from(def.table).delete().eq('id', rec.id);
        if (error) { $('#form-error').textContent = `Suppression impossible : ${error.message}`; delBtn.disabled = false; return; }
        await Promise.all([loadTable(def.table), loadTable('attachments'), loadTable('materials'), loadTable('material_uses'), loadTable('stock_moves'), loadTable('trash')]);
        closeModal();
        render();
        toast('Supprimé');
      });
    }
  }

  async function saveUses(useKey, parentId, rows) {
    const existing = state.material_uses.filter((u) => u[useKey] === parentId);
    const keep = new Set(rows.filter((r) => r.id).map((r) => r.id));
    for (const u of existing) {
      if (keep.has(u.id)) continue;
      const { error } = await sb.from('material_uses').delete().eq('id', u.id);
      if (error) throw error;
    }
    for (const r of rows) {
      const qty = Number(r.qty);
      if (!r.material_id || !(qty > 0)) continue;
      if (r.id) {
        const old = existing.find((u) => u.id === r.id);
        if (old && (old.material_id !== r.material_id || Number(old.qty) !== qty)) {
          const { error } = await sb.from('material_uses').update({ material_id: r.material_id, qty }).eq('id', r.id);
          if (error) throw error;
        }
      } else {
        const { error } = await sb.from('material_uses').insert({ [useKey]: parentId, material_id: r.material_id, qty });
        if (error) throw error;
      }
    }
  }

  /* ---------- Photos ---------- */
  const photoCache = new Map();
  async function signedUrls(paths) {
    const need = paths.filter((p) => !photoCache.has(p) || Date.now() - photoCache.get(p).at > 50 * 60000);
    if (!need.length) return;
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(need, 3600);
    (data || []).forEach((d) => { if (d && d.signedUrl) photoCache.set(d.path, { url: d.signedUrl, at: Date.now() }); });
  }

  // réduit les photos de téléphone (souvent plusieurs Mo) avant l'envoi
  async function shrinkImage(file, max = 1600) {
    if (!file.type || !file.type.startsWith('image/') || !window.createImageBitmap) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 800 * 1024) return file;
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
      return blob ? new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' }) : file;
    } catch (e) {
      return file;
    }
  }

  function openLightbox(url, name) {
    $('#layer-root').innerHTML = `<div class="lightbox" id="lightbox"><img src="${esc(url)}" alt="${esc(name)}"><div class="lb-name">${esc(name)}</div>
      <button type="button" class="btn icon-btn lb-close" aria-label="Fermer">✕</button></div>`;
    $('#lightbox').addEventListener('click', () => { $('#layer-root').innerHTML = ''; });
  }

  /* ---------- Étiquettes QR ---------- */
  const LABEL_SIZES = [['62x29', '62 × 29 mm (rouleau Brother, Dymo)'], ['50x30', '50 × 30 mm'], ['70x40', '70 × 40 mm'], ['a4', 'Feuille A4 (plusieurs étiquettes)']];
  const codeOf = (kind, id) => `D3D:${kind}:${String(id).replace(/-/g, '').slice(0, 8)}`;
  // Le QR contient l'adresse de l'appli web + le code : l'appareil photo d'un téléphone ouvre alors directement la fiche.
  // Version web : sa propre adresse ; application Windows : l'adresse indiquée dans config.js (WEB_URL).
  const scanBase = () => {
    const local = /^(localhost|127\.|0\.0\.0\.0)/.test(location.hostname);
    if (/^https?:$/.test(location.protocol) && !local) return location.origin + location.pathname.replace(/index\.html$/, '');
    return (window.CONFIG && window.CONFIG.WEB_URL) || '';
  };
  const scanPayload = (kind, id) => { const base = scanBase(); return base ? `${base}#${codeOf(kind, id)}` : codeOf(kind, id); };
  function qrSvg(payload) {
    const q = window.qrcode(0, 'M');
    q.addData(payload);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }
  function labelData(kind, id) {
    if (kind === 'C') {
      const o = state.orders.find((x) => x.id === id);
      return o ? { code: codeOf('C', id), payload: scanPayload('C', id), tag: 'Commande', line1: o.client || o.title, line2: o.client ? o.title : '', line3: o.due_date ? `Échéance ${fmtShort(parseYmd(o.due_date))}` : '' } : null;
    }
    if (kind === 'S') {
      const s = spoolById(id);
      return s ? { code: codeOf('S', id), payload: scanPayload('S', id), tag: 'Bobine', line1: (materialById(s.material_id) || {}).name || 'Bobine', line2: s.label || '', line3: `${fmtNum(s.initial_g)} g neuve` } : null;
    }
    const m = materialById(id);
    return m ? { code: codeOf('M', id), payload: scanPayload('M', id), tag: 'Matière', line1: m.name, line2: (MAT_CATS.find((c) => c[0] === m.category) || [])[1] || '', line3: '' } : null;
  }
  function labelHtml(d, size) {
    return `<div class="label" data-size="${size}"><div class="lq">${qrSvg(d.payload || d.code)}</div>
      <div class="lt"><div class="lbrand"><img src="img/logo.png" alt=""><span>DAYAN 3D</span></div>
        <div class="l1">${esc(d.line1)}</div>${d.line2 ? `<div class="l2">${esc(d.line2)}</div>` : ''}${d.line3 ? `<div class="l3">${esc(d.line3)}</div>` : ''}
        <div class="lc">${esc(d.tag)} ${esc(d.code.slice(-8).toUpperCase())}</div></div></div>`;
  }
  function printLabels(d, size, copies) {
    const root = $('#print-root');
    root.className = `size-${size}`;
    root.innerHTML = Array.from({ length: copies }, () => labelHtml(d, size)).join('');
    let st = $('#page-style');
    if (!st) { st = document.createElement('style'); st.id = 'page-style'; document.head.appendChild(st); }
    st.textContent = size === 'a4' ? '@page { size: A4; margin: 10mm; }' : `@page { size: ${size.split('x').map((n) => `${n}mm`).join(' ')}; margin: 0; }`;
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); root.innerHTML = ''; };
    window.addEventListener('afterprint', function once() { window.removeEventListener('afterprint', once); done(); });
    window.print();
    done();
  }
  function openLabelDialog(kind, id) {
    const d = labelData(kind, id);
    if (!d) return;
    const last = (() => { try { return localStorage.getItem('dayan_label_size') || '62x29'; } catch (e) { return '62x29'; } })();
    $('#layer-root').innerHTML = `
      <div class="overlay layer" id="label-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Étiquette QR">
          <div class="modal-head"><h3>Étiquette QR</h3><button type="button" class="btn btn-quiet icon-btn" data-lclose aria-label="Fermer">✕</button></div>
          <div class="modal-body">
            <div class="label-preview" id="label-preview"></div>
            <div class="two">
              <label class="field"><span>Format</span><select id="l_size">${LABEL_SIZES.map(([k, l]) => `<option value="${k}" ${k === last ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
              <label class="field"><span>Nombre d’exemplaires</span><input id="l_copies" type="number" min="1" max="60" value="1"></label>
            </div>
            <small class="hint-line">${/^https?:/.test(d.payload) ? `Scanne ce QR avec l’appareil photo d’un téléphone : la fiche s’ouvre dans l’appli web (connexion à ton compte d’équipe la première fois). Un lecteur de codes USB ou Ctrl + K fonctionnent aussi.<br><code class="qr-url">${esc(d.payload)}</code>` : `Le code contient « ${esc(d.code)} ». Scanne-le avec un lecteur de codes (il tape le code) ou avec Ctrl + K : l’élément s’ouvre. Pour qu’un téléphone l’ouvre directement, indique l’adresse de l’appli web dans config.js (WEB_URL).`}</small>
          </div>
          <div class="modal-foot"><span class="grow"></span><button type="button" class="btn" data-lclose>Fermer</button><button type="button" class="btn btn-primary" id="l_print">Imprimer</button></div>
        </div>
      </div>`;
    const paint = () => { $('#label-preview').innerHTML = labelHtml(d, $('#l_size').value); };
    paint();
    $('#l_size').addEventListener('change', () => { paint(); try { localStorage.setItem('dayan_label_size', $('#l_size').value); } catch (e) { /* ignoré */ } });
    const close = () => { $('#layer-root').innerHTML = ''; };
    $('#label-overlay').querySelectorAll('[data-lclose]').forEach((b) => b.addEventListener('click', close));
    $('#label-overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'label-overlay') close(); });
    $('#l_print').addEventListener('click', () => {
      const copies = Math.min(60, Math.max(1, Math.round(Number($('#l_copies').value) || 1)));
      printLabels(d, $('#l_size').value, copies);
    });
  }

  /* ---------- Pièces jointes ---------- */
  const BUCKET = 'pieces-jointes';

  async function uploadFile(parentType, parentId, file, kind = 'file') {
    const safe = file.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '_');
    const path = `${parentType}/${parentId}/${Date.now()}-${safe}`;
    const up = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream' });
    if (up.error) throw up.error;
    const row = { parent_type: parentType, parent_id: parentId, name: file.name, path, size: file.size };
    if (kind !== 'file') row.kind = kind;
    const ins = await sb.from('attachments').insert(row);
    if (ins.error) throw ins.error;
  }

  async function openAttachment(id) {
    const a = state.attachments.find((x) => x.id === id);
    if (!a) return;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(a.path, 600, { download: a.name });
    if (error) { toast(`Ouverture impossible : ${error.message}`, true); return; }
    window.open(data.signedUrl, '_blank');
  }

  async function removeAttachment(id, silent) {
    const a = state.attachments.find((x) => x.id === id);
    if (!a) return;
    await sb.storage.from(BUCKET).remove([a.path]);
    const { error } = await sb.from('attachments').delete().eq('id', id);
    if (error && !silent) toast(`Suppression impossible : ${error.message}`, true);
    if (!silent) await loadTable('attachments');
  }

  /* ---------- Ajuster le stock ---------- */
  const ADJUST_KINDS = [
    ['purchase', 'Achat ou réapprovisionnement (+)'],
    ['adjust', 'Perte ou correction (−)'],
    ['inventory', 'Inventaire : définir la quantité exacte']
  ];

  function openAdjust(id) {
    const m = materialById(id);
    if (!m) return;
    $('#modal-root').innerHTML = `
      <div class="overlay" id="overlay">
        <form class="modal" id="aform" role="dialog" aria-modal="true" aria-label="Ajuster le stock">
          <div class="modal-head"><h3>Ajuster le stock</h3><button type="button" class="btn btn-quiet icon-btn" data-close aria-label="Fermer">✕</button></div>
          <div class="modal-body">
            <p class="adjust-title"><b>${esc(m.name)}</b><br><span class="hint-line">En stock : ${esc(fmtNum(m.quantity))} ${esc(unitFor(m, m.quantity))}</span></p>
            <label class="field"><span>Type de mouvement</span>
              <select id="a_kind">${ADJUST_KINDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
            <label class="field"><span id="a_qty_label">Quantité (${esc(m.unit)})</span><input id="a_qty" type="number" step="any" min="0" required></label>
            <label class="field"><span>Note (facultatif)</span><input id="a_note" type="text" placeholder="Fournisseur, raison de la perte…"></label>
            <p class="form-error" id="form-error" role="alert"></p>
          </div>
          <div class="modal-foot"><span class="grow"></span>
            <button type="button" class="btn" data-close>Annuler</button>
            <button type="submit" class="btn btn-primary" id="btn-save">Enregistrer</button></div>
        </form>
      </div>`;
    const ov = $('#overlay');
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeModal(); });
    ov.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
    $('#a_kind').addEventListener('change', (e) => {
      $('#a_qty_label').textContent = e.target.value === 'inventory' ? `Quantité réellement en stock (${m.unit})` : `Quantité (${m.unit})`;
    });
    $('#a_qty').focus();
    $('#aform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const kind = $('#a_kind').value;
      const qty = Number($('#a_qty').value);
      const err = $('#form-error');
      if (!Number.isFinite(qty) || qty < 0 || (kind !== 'inventory' && qty <= 0)) { err.textContent = 'Indique une quantité valide.'; return; }
      const delta = kind === 'purchase' ? qty : kind === 'adjust' ? -qty : qty - Number(m.quantity);
      if (delta === 0) { closeModal(); return; }
      const btn = $('#btn-save');
      btn.disabled = true;
      const { error } = await sb.from('stock_moves').insert({ material_id: m.id, delta, reason: kind, note: $('#a_note').value.trim() || null });
      if (error) { err.textContent = `Enregistrement impossible : ${error.message}`; btn.disabled = false; return; }
      await Promise.all([loadTable('materials'), loadTable('stock_moves')]);
      closeModal();
      render();
      { const q = state.materials.find((x) => x.id === m.id)?.quantity ?? 0; toast(`Stock de ${m.name} : ${fmtNum(q)} ${unitFor(m, q)}`); }
    });
  }

  /* ---------- Planification automatique ---------- */
  const PLAN_KEY = 'dayan_plan';
  function planPrefs() {
    const d = { startH: 8, endH: 20, weekends: true };
    try { return { ...d, ...JSON.parse(localStorage.getItem(PLAN_KEY) || '{}') }; } catch (e) { return d; }
  }

  // Place chaque pièce sur la machine qui la termine le plus tôt, sans toucher aux impressions
  // ni aux blocages existants. Une impression ne peut démarrer que dans la plage d'heures choisie.
  function planJobs(jobs, opts = {}) {
    const { from = new Date(), startH = 8, endH = 20, weekends = true, dueDate = null } = opts;
    const quarter = 15 * 60000;
    const earliest = Math.ceil(+from / quarter) * quarter;
    const busy = new Map(state.machines.map((m) => [m.id, []]));
    state.prints.filter(isActivePrint).forEach((p) => { if (busy.has(p.machine_id)) busy.get(p.machine_id).push([+new Date(p.start_at), +new Date(p.end_at)]); });
    state.machine_blocks.forEach((b) => { if (busy.has(b.machine_id)) busy.get(b.machine_id).push([+new Date(b.start_at), +new Date(b.end_at)]); });
    const align = (t) => {
      let d = new Date(t);
      for (let i = 0; i < 800; i++) {
        const wd = d.getDay();
        if (!weekends && (wd === 0 || wd === 6)) { d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, startH, 0, 0); continue; }
        const h = d.getHours() + d.getMinutes() / 60;
        if (h < startH) { d = new Date(d.getFullYear(), d.getMonth(), d.getDate(), startH, 0, 0); continue; }
        if (h >= endH) { d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, startH, 0, 0); continue; }
        return +d;
      }
      return +d;
    };
    const order = jobs.map((j, i) => ({ ...j, i })).sort((x, y) => y.hours - x.hours || x.i - y.i);
    const result = new Array(jobs.length);
    order.forEach((job) => {
      const dur = job.hours * 36e5;
      const cands = job.machineId ? state.machines.filter((m) => m.id === job.machineId) : state.machines;
      let best = null;
      cands.forEach((m) => {
        let t = align(earliest);
        for (let guard = 0; guard < 800; guard++) {
          const clash = busy.get(m.id).filter(([s, e]) => t < e && s < t + dur).sort((x, y) => y[1] - x[1])[0];
          if (!clash) break;
          t = align(clash[1]);
        }
        if (!best || t + dur < best.end) best = { m, start: t, end: t + dur };
      });
      if (!best) { result[job.i] = { ...job, error: 'Aucune machine disponible' }; return; }
      busy.get(best.m.id).push([best.start, best.end]);
      result[job.i] = { ...job, machine_id: best.m.id, start_at: new Date(best.start).toISOString(), end_at: new Date(best.end).toISOString() };
    });
    const lastEnd = Math.max(0, ...result.filter((r) => r.end_at).map((r) => +new Date(r.end_at)));
    let lateDays = null;
    if (dueDate && lastEnd) {
      const dueEnd = +parseYmd(dueDate) + 864e5;
      lateDays = lastEnd > dueEnd ? Math.ceil((lastEnd - dueEnd) / 864e5) : 0;
    }
    return { jobs: result, lastEnd, lateDays };
  }

  function openPlanner(orderId) {
    const pref = planPrefs();
    const rows = [{ title: '', hours: 1, copies: 1, machineId: '', templateId: '' }];
    const startOrder = orderId ? state.orders.find((o) => o.id === orderId) : null;
    if (startOrder) rows[0].title = startOrder.title;
    let proposal = null;
    const openOrders = state.orders.filter((o) => o.status !== 'done').sort((x, y) => orderLabel(x).localeCompare(orderLabel(y), 'fr'));
    $('#layer-root').innerHTML = `
      <div class="overlay layer" id="plan-overlay">
        <div class="modal plan" role="dialog" aria-modal="true" aria-label="Planifier les impressions">
          <div class="modal-head"><h3>Planifier les impressions</h3><button type="button" class="btn btn-quiet icon-btn" data-pclose aria-label="Fermer">✕</button></div>
          <div class="modal-body">
            <label class="field"><span>Commande</span><select id="plan-order"><option value="">Sans commande</option>${openOrders.map((o) => `<option value="${o.id}" ${o.id === orderId ? 'selected' : ''}>${esc(orderLabel(o))}${o.due_date ? ` (échéance ${esc(fmtShort(parseYmd(o.due_date)))})` : ''}</option>`).join('')}</select></label>
            ${state.print_templates.length ? `<label class="field"><span>Ajouter une pièce depuis un modèle</span><select id="plan-tpl"><option value="">Choisir un modèle…</option>${state.print_templates.slice().sort((x, y) => x.name.localeCompare(y.name, 'fr')).map((t) => `<option value="${t.id}">${esc(t.name)} (${esc(fmtNum(t.duration_h))} h)</option>`).join('')}</select></label>` : ''}
            <div class="files"><h4>Pièces à imprimer</h4><div id="plan-jobs"></div><div><button type="button" class="btn btn-small" id="plan-add">+ Pièce</button></div></div>
            <div class="two">
              <label class="field"><span>Démarrer à partir de (heure)</span><input id="plan-from" type="number" min="0" max="23" value="${pref.startH}"></label>
              <label class="field"><span>et jusqu’à (heure)</span><input id="plan-to" type="number" min="1" max="24" value="${pref.endH}"></label>
            </div>
            <label class="checkline"><input type="checkbox" id="plan-we" ${pref.weekends ? 'checked' : ''}><span>Inclure les week-ends<small class="hint-line">La plage d’heures ne limite que le démarrage : une impression peut tourner la nuit.</small></span></label>
            <div id="plan-result"></div>
          </div>
          <div class="modal-foot"><span class="grow"></span><button type="button" class="btn" data-pclose>Fermer</button>
            <button type="button" class="btn" id="plan-go">Proposer un planning</button><button type="button" class="btn btn-primary" id="plan-create" disabled>Créer les impressions</button></div>
        </div>
      </div>`;
    const close = () => { $('#layer-root').innerHTML = ''; };
    const ov = $('#plan-overlay');
    ov.querySelectorAll('[data-pclose]').forEach((b) => b.addEventListener('click', close));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

    const paintRows = () => {
      $('#plan-jobs').innerHTML = rows.map((r, i) => `
        <div class="plan-row" data-i="${i}">
          <input data-f="title" type="text" placeholder="Pièce" value="${esc(r.title)}" aria-label="Pièce">
          <input data-f="hours" type="number" min="0.25" step="0.25" value="${esc(r.hours)}" aria-label="Durée en heures" title="Durée (h)">
          <input data-f="copies" type="number" min="1" max="30" value="${esc(r.copies)}" aria-label="Nombre d’exemplaires" title="Exemplaires">
          <select data-f="machineId" aria-label="Machine"><option value="">Toutes les machines</option>${state.machines.map((m) => `<option value="${m.id}" ${m.id === r.machineId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
          <button type="button" class="x" data-f="x" aria-label="Retirer cette pièce">✕</button></div>`).join('') || '<div class="hint-line">Ajoute une pièce.</div>';
    };
    paintRows();
    const stale = () => { proposal = null; $('#plan-create').disabled = true; };
    $('#plan-jobs').addEventListener('input', (e) => {
      const row = e.target.closest('.plan-row');
      if (!row) return;
      rows[Number(row.dataset.i)][e.target.dataset.f] = e.target.value;
      stale();
    });
    $('#plan-jobs').addEventListener('change', (e) => {
      const row = e.target.closest('.plan-row');
      if (row && e.target.dataset.f === 'machineId') { rows[Number(row.dataset.i)].machineId = e.target.value; stale(); }
    });
    $('#plan-jobs').addEventListener('click', (e) => {
      const x = e.target.closest('[data-f="x"]');
      if (x) { rows.splice(Number(x.closest('.plan-row').dataset.i), 1); paintRows(); stale(); }
    });
    $('#plan-add').addEventListener('click', () => { rows.push({ title: '', hours: 1, copies: 1, machineId: '', templateId: '' }); paintRows(); stale(); });
    const tsel = $('#plan-tpl');
    if (tsel) {
      tsel.addEventListener('change', () => {
        const t = state.print_templates.find((x) => x.id === tsel.value);
        if (!t) return;
        const blank = rows.length === 1 && !rows[0].title;
        const row = { title: t.name, hours: Number(t.duration_h), copies: 1, machineId: t.machine_id || '', templateId: t.id };
        if (blank) rows[0] = row; else rows.push(row);
        tsel.value = '';
        paintRows();
        stale();
      });
    }
    ['#plan-order', '#plan-from', '#plan-to', '#plan-we'].forEach((sel) => $(sel).addEventListener('change', stale));

    const orderSel = () => state.orders.find((o) => o.id === $('#plan-order').value) || null;
    $('#plan-go').addEventListener('click', () => {
      const startH = Math.min(23, Math.max(0, Number($('#plan-from').value) || 8));
      const endH = Math.min(24, Math.max(startH + 1, Number($('#plan-to').value) || 20));
      const weekends = $('#plan-we').checked;
      try { localStorage.setItem(PLAN_KEY, JSON.stringify({ startH, endH, weekends })); } catch (e) { /* ignoré */ }
      const jobs = [];
      rows.forEach((r) => {
        const hours = Number(r.hours);
        const copies = Math.min(30, Math.max(1, Math.round(Number(r.copies) || 1)));
        if (!String(r.title).trim() || !(hours > 0)) return;
        for (let k = 1; k <= copies; k++) jobs.push({ title: copies > 1 ? `${String(r.title).trim()} (${k}/${copies})` : String(r.title).trim(), hours, machineId: r.machineId, templateId: r.templateId });
      });
      const res = $('#plan-result');
      if (!jobs.length) { res.innerHTML = '<div class="form-error">Indique au moins une pièce avec sa durée.</div>'; stale(); return; }
      if (jobs.length > 40) { res.innerHTML = '<div class="form-error">40 pièces au maximum à la fois.</div>'; stale(); return; }
      const order = orderSel();
      proposal = planJobs(jobs, { startH, endH, weekends, dueDate: order && order.due_date });
      const lines = proposal.jobs.slice().sort((x, y) => new Date(x.start_at || 0) - new Date(y.start_at || 0)).map((j) => (j.error
        ? `<div class="plan-line err"><b>${esc(j.title)}</b><span>${esc(j.error)}</span></div>`
        : `<div class="plan-line"><b>${esc(j.title)}</b><span>${esc(machineName(j.machine_id))}, ${esc(fmtDateTime(j.start_at))} jusqu’à ${esc(fmtDateTime(j.end_at))}</span></div>`)).join('');
      const verdict = proposal.lateDays == null ? '' : proposal.lateDays === 0
        ? `<div class="plan-ok">À temps pour l’échéance (${esc(fmtShort(parseYmd(order.due_date)))})</div>`
        : `<div class="plan-late">Dépasse l’échéance de ${proposal.lateDays} jour${proposal.lateDays > 1 ? 's' : ''}. Élargis la plage d’heures, inclus les week-ends, retire un blocage ou décale l’échéance.</div>`;
      res.innerHTML = `<div class="plan-box">${lines}<div class="plan-end">Fin de la dernière impression : ${esc(fmtDateTime(new Date(proposal.lastEnd).toISOString()))}</div>${verdict}</div>`;
      $('#plan-create').disabled = !proposal.jobs.some((j) => j.start_at);
    });
    $('#plan-create').addEventListener('click', async () => {
      if (!proposal) return;
      const btn = $('#plan-create');
      btn.disabled = true;
      const order = orderSel();
      let n = 0;
      for (const j of proposal.jobs) {
        if (!j.start_at) continue;
        const { data, error } = await sb.from('prints').insert({ title: j.title, machine_id: j.machine_id, order_id: order ? order.id : null, start_at: j.start_at, end_at: j.end_at, status: 'planned' }).select().single();
        if (error) { toast(`Impression non créée : ${error.message}`, true); break; }
        n += 1;
        if (j.templateId) {
          for (const u of state.material_uses.filter((x) => x.template_id === j.templateId)) {
            await sb.from('material_uses').insert({ print_id: data.id, material_id: u.material_id, qty: u.qty });
          }
        }
      }
      await Promise.all([loadTable('prints'), loadTable('material_uses')]);
      render();
      close();
      toast(`${n} impression${n > 1 ? 's' : ''} planifiée${n > 1 ? 's' : ''}`);
    });
  }

  /* ---------- Ouverture d'une fiche par un scan (adresse du QR) ---------- */
  function openScanned(kind, id8) {
    const startsWith = (x) => x.id.replace(/-/g, '').startsWith(id8.toLowerCase());
    const k = kind.toUpperCase();
    const found = k === 'C' ? state.orders.find(startsWith) : k === 'S' ? state.spools.find(startsWith) : state.materials.find(startsWith);
    if (!found) { toast('Code introuvable : cette étiquette ne correspond à rien dans l’appli (élément supprimé ?)', true); return false; }
    $('#modal-root').innerHTML = '';
    $('#layer-root').innerHTML = '';
    if (k === 'C') openForm('order', found.id);
    else if (k === 'S') openSpoolDetail(found.id);
    else openForm('material', found.id);
    return true;
  }
  // l'adresse du QR se termine par #D3D:C:xxxxxxxx : on ouvre la fiche, puis on efface le code de l'adresse
  function handleScanLink() {
    let raw = '';
    try { raw = decodeURIComponent(location.hash || ''); } catch (e) { raw = location.hash || ''; }
    const m = /D3D:([CMS]):([0-9a-f]{8})/i.exec(raw);
    if (!m || !state.started) return false;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignoré */ }
    return openScanned(m[1], m[2]);
  }
  window.addEventListener('hashchange', () => { if (state.started) handleScanLink(); });

  /* ---------- Recherche globale ---------- */
  function searchAll(q) {
    const scan = /D3D:([CMS]):([0-9a-f]{8})/i.exec(q);
    if (scan) {
      const kind = scan[1].toUpperCase();
      const id8 = scan[2].toLowerCase();
      const startsWith = (x) => x.id.replace(/-/g, '').startsWith(id8);
      const found = kind === 'C' ? state.orders.find(startsWith) : kind === 'S' ? state.spools.find(startsWith) : state.materials.find(startsWith);
      if (!found) return [];
      if (kind === 'S') return [{ label: 'Code scanné', items: [{ kind: 'spool', act: 'spool-detail', id: found.id, main: spoolName(found), sub: `${fmtNum(Math.round(spoolLeft(found)))} g restants${found.machine_id ? `, dans ${machineName(found.machine_id)}` : ''}` }] }];
      return [{ label: 'Code scanné', items: [kind === 'C' ? { kind: 'order', id: found.id, main: orderLabel(found), sub: 'Commande' } : { kind: 'material', id: found.id, main: found.name, sub: `${fmtNum(found.quantity)} ${unitFor(found, found.quantity)} en stock` }] }];
    }
    const terms = norm(q).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const hit = (...parts) => { const hay = norm(parts.filter(Boolean).join(' ')); return terms.every((t) => hay.includes(t)); };
    const groups = [];
    const add = (label, items) => { if (items.length) groups.push({ label, items: items.slice(0, 8) }); };
    const statusFr = (s) => (ORDER_STATUS.find((x) => x[0] === s) || [])[1] || '';
    add('Commandes', state.orders.filter((o) => hit(o.client, o.title, o.notes, (o.tags || []).join(' '))).map((o) => ({ kind: 'order', id: o.id, main: orderLabel(o), sub: `${statusFr(o.status)}${o.priority === 'urgent' ? ', urgente' : ''}` })));
    add('Clients', state.clients.filter((c) => hit(c.name, c.phone, c.email, c.address, c.notes)).map((c) => ({ kind: 'client', id: c.id, main: c.name, sub: [c.phone, c.email].filter(Boolean).join(', ') })));
    add('Impressions', state.prints.filter((p) => hit(p.title, p.notes, machineName(p.machine_id))).map((p) => ({ kind: 'print', id: p.id, main: p.title, sub: `${machineName(p.machine_id)}, ${fmtDateTime(p.start_at)}` })));
    add('Tâches', state.tasks.filter((t) => hit(t.title, t.notes)).map((t) => ({ kind: 'task', id: t.id, main: t.title, sub: t.start_at ? fmtDateTime(t.start_at) : 'Sans date' })));
    add('Matières', state.materials.filter((m) => hit(m.name, m.notes)).map((m) => ({ kind: 'material', id: m.id, main: m.name, sub: `${fmtNum(m.quantity)} ${unitFor(m, m.quantity)} en stock` })));
    add('Bobines', state.spools.filter((s) => { const m = materialById(s.material_id); return hit(filTitle(m), m && m.name, s.label, s.location, s.supplier, s.notes); }).map((s) => ({ kind: 'spool', act: 'spool-detail', id: s.id, main: `${filTitle(materialById(s.material_id))}${s.label ? ` #${s.label}` : ''}`, sub: `${fmtNum(Math.round(spoolLeft(s)))} g${s.machine_id ? `, dans ${machineName(s.machine_id)}` : s.location ? `, ${s.location}` : ''}` })));
    add('Modèles', state.print_templates.filter((t) => hit(t.name, t.notes)).map((t) => ({ kind: 'template', id: t.id, main: t.name, sub: `${fmtNum(t.duration_h)} h` })));
    add('Commentaires', state.comments.filter((c) => hit(c.body)).map((c) => { const o = state.orders.find((x) => x.id === c.order_id); return o ? { kind: 'order', id: o.id, main: c.body.length > 80 ? `${c.body.slice(0, 80)}…` : c.body, sub: `${profileName(c.created_by)} sur ${orderLabel(o)}` } : null; }).filter(Boolean));
    add('Fichiers', state.attachments.filter((f) => hit(f.name)).map((f) => {
      const parent = f.parent_type === 'order' ? state.orders.find((x) => x.id === f.parent_id) : state.prints.find((x) => x.id === f.parent_id);
      return parent ? { kind: f.parent_type, id: parent.id, main: f.name, sub: f.parent_type === 'order' ? orderLabel(parent) : parent.title } : null;
    }).filter(Boolean));
    return groups;
  }

  function openSearch() {
    $('#modal-root').innerHTML = `
      <div class="overlay top" id="overlay">
        <div class="modal search" role="dialog" aria-modal="true" aria-label="Recherche">
          <div class="search-head"><input id="search-input" type="search" placeholder="Rechercher une commande, un client, une pièce, un fichier…" autocomplete="off"></div>
          <div id="search-results" class="search-results"><div class="hint-line pad">Tape un nom, une pièce, un numéro de téléphone… (Échap pour fermer)</div></div>
        </div>
      </div>`;
    state.modalRefresh = null;
    state.openOrderId = null;
    const ov = $('#overlay');
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeModal(); });
    const input = $('#search-input');
    input.focus();
    const paint = () => {
      const q = input.value.trim();
      const groups = searchAll(q);
      $('#search-results').innerHTML = !q ? '<div class="hint-line pad">Tape un nom, une pièce, un numéro de téléphone… (Échap pour fermer)</div>'
        : groups.length ? groups.map((g) => `<div class="sr-group"><h4>${esc(g.label)}</h4>${g.items.map((i) => `
            <button type="button" class="sr-item" data-act="${i.act || 'edit'}" data-kind="${i.kind}" data-id="${i.id}"><span class="ti-main">${esc(i.main)}</span>${i.sub ? `<span class="sub">${esc(i.sub)}</span>` : ''}</button>`).join('')}</div>`).join('')
        : `<div class="hint-line pad">Aucun résultat pour « ${esc(q)} ».</div>`;
    };
    input.addEventListener('input', paint);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const first = $('.sr-item'); if (first) first.click(); }
    });
  }

  /* ---------- Menu « Nouveau » ---------- */
  function openMenu(anchor) {
    closeMenu();
    const r = anchor.getBoundingClientRect();
    const items = [['task', 'Tâche'], ['rdv', 'Rendez-vous'], ['print', 'Impression'], ['order', 'Commande'], ['block', 'Blocage de machine'], ['avail', 'Disponibilité / absence']];
    const el = document.createElement('div');
    el.className = 'pop';
    el.style.top = `${r.bottom + 6}px`;
    el.style.right = `${window.innerWidth - r.right}px`;
    el.innerHTML = items.map(([k, l]) => `<button type="button" data-act="newitem" data-kind="${k}">${l}</button>`).join('');
    $('#menu-root').appendChild(el);
  }
  const closeMenu = () => { $('#menu-root').innerHTML = ''; };

  function newItem(kind, ds) {
    closeMenu();
    if (kind === 'rdv') return openForm('task', null, { kind: 'rdv', ...(ds.date ? dayPreset(ds.date) : {}) });
    const preset = {};
    if (kind === 'task' && ds.date) Object.assign(preset, dayPreset(ds.date));
    if (kind === 'spool' && ds.material) preset.material_id = ds.material;
    if (kind === 'print') {
      if (ds.machine) preset.machine_id = ds.machine;
      if (ds.date) Object.assign(preset, dayPreset(ds.date, 8, 18));
    }
    if (kind === 'avail') {
      if (ds.user) preset.user_id = ds.user;
      if (ds.date) { preset.date_from = ds.date; preset.date_to = ds.date; }
    }
    openForm(kind, null, preset);
  }
  function dayPreset(dateStr, h1 = 9, h2 = null) {
    const d = parseYmd(dateStr);
    const out = { start_at: new Date(+d + h1 * 36e5).toISOString() };
    if (h2) out.end_at = new Date(+d + h2 * 36e5).toISOString();
    return out;
  }

  /* ------------------------------------------------------------------ */
  /*  Actions (clics)                                                    */
  /* ------------------------------------------------------------------ */
  function shift(dir) {
    if (state.view === 'calendar') {
      const c = state.cursor;
      state.cursor = state.calMode === 'month' ? new Date(c.getFullYear(), c.getMonth() + dir, 1) : addDays(c, 7 * dir);
    } else if (state.view === 'machines') {
      state.tlStart = addDays(state.tlStart, 7 * dir);
    } else if (state.view === 'team') {
      state.teamStart = addDays(state.teamStart, 7 * dir);
    }
  }

  async function markMaintenanceDone(id) {
    const r = state.maintenance_rules.find((x) => x.id === id);
    if (!r) return;
    const { error } = await sb.from('maintenance_rules').update({ last_done_at: new Date().toISOString() }).eq('id', id);
    if (error) { toast(`Enregistrement impossible : ${error.message}`, true); return; }
    await loadTable('maintenance_rules');
    render();
    toast(`Entretien noté : ${r.name}`);
  }

  async function toggleTask(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    render();
    const wasRecurring = t.done && t.recurrence && t.recurrence !== 'none';
    const { error } = await sb.from('tasks').update({ done: t.done }).eq('id', id);
    if (error) { toast(`Modification impossible : ${error.message}`, true); }
    await loadTable('tasks');
    render();
    if (wasRecurring && !error) toast('Terminée : la prochaine occurrence est planifiée');
  }

  document.addEventListener('click', (e) => {
    const pop = e.target.closest('.pop');
    if (!pop && !e.target.closest('[data-act="new-menu"]')) closeMenu();
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const { act } = el.dataset;
    switch (act) {
      case 'nav': state.view = el.dataset.view; document.body.classList.remove('nav-open'); render(); $('#view').scrollTop = 0; break;
      case 'menu': document.body.classList.toggle('nav-open'); break;
      case 'menu-close': document.body.classList.remove('nav-open'); break;
      case 'prev': shift(-1); render(); break;
      case 'next': shift(1); render(); break;
      case 'today':
        state.cursor = startOfDay(new Date());
        state.tlStart = mondayOf(new Date());
        state.teamStart = mondayOf(new Date());
        render();
        break;
      case 'mode': state.calMode = el.dataset.mode; render(); break;
      case 'day': state.cursor = parseYmd(el.dataset.date); state.calMode = 'week'; render(); break;
      case 'filter': state.taskFilter = el.dataset.f; render(); break;
      case 'new-menu': openMenu(el); break;
      case 'newitem': newItem(el.dataset.kind, el.dataset); break;
      case 'edit': openForm(el.dataset.kind, el.dataset.id); break;
      case 'toggle-task': toggleTask(el.dataset.id); break;
      case 'adjust': openAdjust(el.dataset.id); break;
      case 'spool-load-menu': openSpoolMenu(el, el.dataset.id); break;
      case 'spool-load': setSpoolMachine(el.dataset.id, el.dataset.machine); break;
      case 'spool-unload': setSpoolMachine(el.dataset.id, null); break;
      case 'plan': openPlanner(el.dataset.order || ''); break;
      case 'trash-restore': restoreTrash(el.dataset.id); break;
      case 'trash-delete': deleteTrash(el.dataset.id); break;
      case 'maint-done': markMaintenanceDone(el.dataset.id); break;
      case 'srange': state.statsRange = Number(el.dataset.r); render(); break;
      case 'fil-tab': state.filTab = el.dataset.tab; render(); break;
      case 'fil-filter': state.filFilter = el.dataset.f; render(); break;
      case 'spool-detail': openSpoolDetail(el.dataset.id); break;
      case 'spool-weigh': openWeigh(el.dataset.id); break;
      case 'spool-dry': $('#layer-root').innerHTML = ''; markDried(el.dataset.id); break;
      case 'spool-label': openLabelDialog('spool', el.dataset.id); break;
      case 'spool-edit': $('#layer-root').innerHTML = ''; openForm('spool', el.dataset.id); break;
      case 'help-view': openHelp(HELP_BY_VIEW[state.view] || 'start'); break;
      case 'help-all': $('#layer-root').innerHTML = ''; state.helpOpen = el.dataset.id || ''; state.view = 'help'; render(); break;
      case 'tour': startTour(); break;
      case 'tour-next': tourGo(1); break;
      case 'tour-prev': tourGo(-1); break;
      case 'tour-quit': endTour(false); break;
      case 'tour-offer-start': dismissOffer(false); startTour(); break;
      case 'tour-offer-later': dismissOffer(false); break;
      case 'tour-offer-never': dismissOffer(true); break;
      case 'vrange': state.volRange = el.dataset.r; render(); break;
      case 'kiosk-on': enterKiosk(); break;
      case 'kiosk-off': exitKiosk(); break;
      case 'ofilter': state.orderFilter.urgent = el.dataset.f === 'urgent'; render(); break;
      case 'clients-import': importClientsFromOrders(); break;
      case 'clients-export': openBillingExport(); break;
      case 'use-template': openForm('print', null, { templateId: el.dataset.id }); break;
      case 'search': document.body.classList.remove('nav-open'); openSearch(); break;
      case 'copy-reorder': {
        const lines = reorderLines();
        const txt = `Liste à racheter\n${lines.map((l) => `- ${l.m.name} : ${fmtNum(l.q)} ${unitFor(l.m, l.q)}${l.cost != null ? ` (environ ${fmtMoney(l.cost)})` : ''}`).join('\n')}`;
        copyText(txt).then((ok) => toast(ok ? 'Liste copiée, tu peux la coller dans un message' : 'Copie impossible', !ok));
        break;
      }
      default: break;
    }
  });

  document.addEventListener('dblclick', (e) => {
    if (e.target.closest('.chip, .bar, .dnum, button')) return;
    const cell = e.target.closest('.cal-cell, .week-col');
    if (cell && cell.dataset.date) { newItem('task', { date: cell.dataset.date }); return; }
    const track = e.target.closest('.tl-track');
    if (track) {
      const r = track.getBoundingClientRect();
      const idx = Math.min(13, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * 14)));
      newItem('print', { machine: track.dataset.machine || '', date: ymd(addDays(state.tlStart, idx)) });
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F1') { e.preventDefault(); if (state.started) openHelp(HELP_BY_VIEW[state.view] || 'start'); return; }
    if (tour && (e.key === 'ArrowRight' || e.key === 'Enter')) { e.preventDefault(); tourGo(1); return; }
    if (tour && e.key === 'ArrowLeft') { e.preventDefault(); tourGo(-1); return; }
    if (e.key === 'Escape') {
      if (tour) { endTour(false); return; }
      if ($('#tour-root').innerHTML) { $('#tour-root').innerHTML = ''; return; }
      if (document.body.classList.contains('kiosk') && !$('#modal-root').innerHTML) { exitKiosk(); return; }
      if ($('#layer-root').innerHTML) { $('#layer-root').innerHTML = ''; return; }
      closeMenu(); closeModal();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (state.started) openSearch();
    }
  });
  // un lecteur de codes « tape » le code très vite : dès qu'on voit « D3D: » on ouvre la recherche
  let scanBuf = '';
  let scanTimer;
  document.addEventListener('keydown', (e) => {
    if (!state.started || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    scanBuf += e.key;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { scanBuf = ''; }, 150);
    // le lecteur tape soit « D3D:C:… », soit l'adresse complète « https://…/#D3D:C:… »
    if (/D3D:$/i.test(scanBuf) && (scanBuf.length === 4 || /^https?:\/\//i.test(scanBuf))) {
      const typed = scanBuf;
      scanBuf = '';
      openSearch();
      const input = $('#search-input');
      input.value = typed;
    }
  }, true);
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'help-search') {
      state.helpQuery = e.target.value;
      const box = $('#help-results');
      if (box) box.innerHTML = helpResultsHtml(state.helpQuery);
    }
    if (e.target && e.target.id === 'fil-search') {
      state.filQuery = e.target.value;
      const box = $('#fil-results');
      if (box) box.innerHTML = filResultsHtml();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'fil-type') { state.filType = e.target.value; render(); return; }
    if (e.target && e.target.id === 'tag-filter') { state.orderFilter.tag = e.target.value; render(); }
  });

  /* ---------- Glisser-déposer des commandes ---------- */
  let dragId = null;
  document.addEventListener('dragstart', (e) => {
    const card = e.target.closest && e.target.closest('.card[draggable]');
    if (!card) return;
    dragId = card.dataset.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  document.addEventListener('dragend', () => {
    dragId = null;
    document.querySelectorAll('.dragging, .col.over').forEach((n) => n.classList.remove('dragging', 'over'));
  });
  document.addEventListener('dragover', (e) => {
    const col = e.target.closest && e.target.closest('.col');
    if (!col || !dragId) return;
    e.preventDefault();
    document.querySelectorAll('.col.over').forEach((n) => n !== col && n.classList.remove('over'));
    col.classList.add('over');
  });
  document.addEventListener('drop', async (e) => {
    const col = e.target.closest && e.target.closest('.col');
    if (!col || !dragId) return;
    e.preventDefault();
    const id = dragId;
    const status = col.dataset.status;
    const o = state.orders.find((x) => x.id === id);
    if (o && o.status !== status) {
      o.status = status;
      render();
      const { error } = await sb.from('orders').update({ status }).eq('id', id);
      if (error) toast(`Modification impossible : ${error.message}`, true);
      await Promise.all([loadTable('orders'), loadTable('materials'), loadTable('material_uses'), loadTable('stock_moves')]);
      render();
    }
  });

  /* ------------------------------------------------------------------ */
  /*  Relais des imprimantes (cet ordinateur lit le réseau local)        */
  /* ------------------------------------------------------------------ */
  let printerCfg = { relay: false, auto: true, printers: [] };
  const relayLast = new Map();

  async function autoUpdatePrints(machineId, prevState, st) {
    if (!printerCfg.auto) return;
    const mine = state.prints.filter((p) => p.machine_id === machineId);
    const now = Date.now();
    let changed = false;
    if (st.state === 'printing' && prevState !== 'printing' && prevState !== 'paused') {
      if (mine.some((p) => p.status === 'printing')) return;
      const cand = mine.filter((p) => p.status === 'planned').sort((x, y) => Math.abs(+new Date(x.start_at) - now) - Math.abs(+new Date(y.start_at) - now))[0];
      if (cand && Math.abs(+new Date(cand.start_at) - now) < 24 * 36e5) {
        const dur = +new Date(cand.end_at) - +new Date(cand.start_at);
        const end = st.remaining_min > 0 ? now + st.remaining_min * 60000 : now + dur;
        const { error } = await sb.from('prints').update({ status: 'printing', start_at: new Date(now).toISOString(), end_at: new Date(end).toISOString() }).eq('id', cand.id);
        if (!error) { changed = true; toast(`Impression démarrée : ${cand.title} (${machineName(machineId)})`); }
      }
    } else if (st.state === 'finished' && prevState === 'printing') {
      const cur = mine.find((p) => p.status === 'printing');
      if (cur) {
        const { error } = await sb.from('prints').update({ status: 'done', end_at: new Date(now).toISOString() }).eq('id', cur.id);
        if (!error) { changed = true; toast(`Impression terminée : ${cur.title} (${machineName(machineId)})`); }
      }
    }
    if (changed) { await Promise.all([loadTable('prints'), loadTable('materials'), loadTable('material_uses'), loadTable('stock_moves'), loadTable('spools')]); render(); }
  }

  async function handlePrinterStatus(msg) {
    if (!state.started || !msg || !msg.machine_id || !msg.status) return;
    const { machine_id: mid, status: st } = msg;
    const dbRow = state.printer_status.find((x) => x.machine_id === mid);
    const prevState = dbRow ? dbRow.state : undefined;
    const last = relayLast.get(mid);
    const now = Date.now();
    const changed = !dbRow || dbRow.state !== st.state;
    const moved = last && Math.abs((Number(st.progress) || 0) - (Number(last.progress) || 0)) >= 1;
    const stale = !last || now - last.at > 30000;
    if (!(changed || moved || stale)) return;
    relayLast.set(mid, { at: now, progress: st.progress });
    const row = {
      machine_id: mid, state: st.state, progress: st.progress ?? null, remaining_min: st.remaining_min ?? null, file_name: st.file_name ?? null,
      nozzle_c: st.nozzle_c ?? null, bed_c: st.bed_c ?? null, layer: st.layer ?? null, total_layers: st.total_layers ?? null
    };
    if (changed) row.state_since = new Date().toISOString();
    const { error } = await sb.from('printer_status').upsert(row, { onConflict: 'machine_id' });
    if (error) return;
    const idx = state.printer_status.findIndex((x) => x.machine_id === mid);
    const merged = { ...(idx >= 0 ? state.printer_status[idx] : {}), ...row, updated_at: new Date().toISOString(), state_since: row.state_since || (dbRow && dbRow.state_since) || new Date().toISOString() };
    if (idx >= 0) state.printer_status[idx] = merged; else state.printer_status.push(merged);
    if (changed) await autoUpdatePrints(mid, prevState, st);
  }

  function setupPrinters() {
    if (window.dayanApp && window.dayanApp.onPrinters) window.dayanApp.onPrinters(handlePrinterStatus);
  }

  /* ------------------------------------------------------------------ */
  /*  Rappels                                                            */
  /* ------------------------------------------------------------------ */
  const PREFS_KEY = 'dayan_prefs';
  const NOTIFIED_KEY = 'dayan_notified';
  const prefs = { remind: true, lead: 15, prints: true, dues: true, stock: true, comments: true, shop: true, maint: true, printers: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch (e) { /* réglages par défaut */ }
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignoré */ } };

  function readNotified() {
    try {
      const m = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '{}');
      const limit = Date.now() - 3 * 864e5;
      Object.keys(m).forEach((k) => { if (m[k] < limit) delete m[k]; });
      return m;
    } catch (e) { return {}; }
  }

  function pushNotification(title, body) {
    if (window.dayanApp && window.dayanApp.notify) { window.dayanApp.notify(title, body); return; }
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const direct = () => { try { new Notification(title, { body }); } catch (e) { /* non pris en charge */ } };
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, { body, icon: 'img/icon-192.png', badge: 'img/favicon-32.png' })).catch(direct);
    } else {
      direct();
    }
  }

  function computeReminders(now = Date.now()) {
    const out = [];
    if (!state.me) return out;
    const lead = prefs.lead * 60000;

    state.tasks.forEach((t) => {
      if (t.done || !t.start_at) return;
      if (t.kind !== 'rdv' && t.assignee && t.assignee !== state.me.id) return;
      const s = +new Date(t.start_at);
      if (now >= s - lead && now < s + 6 * 36e5) {
        const mins = Math.round((s - now) / 60000);
        const when = mins > 0 ? `dans ${mins} min (${fmtTime(t.start_at)})` : `à ${fmtTime(t.start_at)}`;
        out.push({ key: `task:${t.id}:${t.start_at}`, title: t.kind === 'rdv' ? 'Rendez-vous' : 'Tâche', body: `${t.title}, ${when}` });
      }
    });

    if (prefs.prints) {
      state.prints.forEach((p) => {
        if (!isActivePrint(p)) return;
        const e = +new Date(p.end_at);
        if (now >= e && now < e + 12 * 36e5) {
          out.push({ key: `print:${p.id}:${p.end_at}`, title: 'Impression à vérifier', body: `${p.title} sur ${machineName(p.machine_id)} devait finir à ${fmtTime(p.end_at)}.` });
        }
      });
    }

    if (prefs.stock && new Date(now).getHours() >= 8) {
      lowSpools().forEach((s) => {
        out.push({ key: `spool:${s.id}:${ymd(new Date(now))}`, title: 'Bobine bientôt vide', body: `${spoolName(s)} dans ${machineName(s.machine_id)} : ${fmtNum(Math.round(spoolLeft(s)))} g restants` });
      });
    }

    if (prefs.printers) {
      state.printer_status.forEach((r) => {
        if (r.state !== 'finished' && r.state !== 'error') return;
        const age = now - +new Date(r.state_since);
        if (age > 15 * 60000 || age < -10 * 60000) return;
        out.push({ key: `printer:${r.machine_id}:${r.state}:${r.state_since}`, title: r.state === 'finished' ? 'Impression terminée' : 'Erreur d’impression', body: `${machineName(r.machine_id)}${r.file_name ? ` : ${r.file_name}` : ''}${r.state === 'finished' ? ', à vider' : ', à vérifier'}` });
      });
    }

    if (prefs.maint && new Date(now).getHours() >= 8) {
      dueRules().forEach((r) => {
        const { h } = ruleProgress(r);
        out.push({ key: `maint:${r.id}:${ymd(new Date(now))}`, title: 'Entretien à faire', body: `${r.name} sur ${machineName(r.machine_id)} (${fmtNum(Math.round(h))} h depuis le dernier)` });
      });
    }

    if (prefs.shop) {
      state.orders.forEach((o) => {
        if (o.source !== 'boutique') return;
        const age = now - +new Date(o.created_at);
        if (age > 15 * 60000 || age < -10 * 60000) return;
        out.push({ key: `shop:${o.id}`, title: 'Nouvelle commande de la boutique', body: `${orderLabel(o)}${o.price_chf != null ? `, ${fmtMoney(o.price_chf)}` : ''}` });
      });
    }

    if (prefs.comments) {
      state.comments.forEach((c) => {
        if (c.created_by === state.me.id || state.openOrderId === c.order_id) return;
        const age = now - +new Date(c.created_at);
        if (age > 15 * 60000 || age < -10 * 60000) return;
        const o = state.orders.find((x) => x.id === c.order_id);
        const text = c.body.length > 90 ? `${c.body.slice(0, 90)}…` : c.body;
        out.push({ key: `comment:${c.id}`, title: 'Nouveau commentaire', body: `${profileName(c.created_by)} sur ${o ? orderLabel(o) : 'une commande'} : ${text}` });
      });
    }

    if (prefs.stock && new Date(now).getHours() >= 8) {
      const low = lowStock();
      if (low.length) {
        const names = low.slice(0, 3).map((m) => `${m.name} (${fmtNum(m.quantity)} ${unitFor(m, m.quantity)})`).join(', ');
        out.push({ key: `stock:${ymd(new Date(now))}`, title: low.length > 1 ? `${low.length} stocks bas` : 'Stock bas', body: `${names}${low.length > 3 ? '…' : ''}` });
      }
    }

    if (prefs.dues && new Date(now).getHours() >= 8) {
      const todayKey = ymd(new Date(now));
      const due = state.orders.filter((o) => o.status !== 'done' && o.due_date && o.due_date <= todayKey);
      if (due.length) {
        const names = due.slice(0, 3).map((o) => o.client || o.title).join(', ');
        out.push({ key: `dues:${todayKey}`, title: due.length > 1 ? `${due.length} commandes à rendre` : 'Commande à rendre', body: `${names}${due.length > 3 ? '…' : ''} (aujourd’hui ou en retard)` });
      }
    }
    return out;
  }

  function checkReminders() {
    if (!state.started || !prefs.remind) return;
    const seen = readNotified();
    let changed = false;
    computeReminders().forEach((r) => {
      if (seen[r.key]) return;
      seen[r.key] = Date.now();
      changed = true;
      pushNotification(r.title, r.body);
    });
    if (changed || Object.keys(seen).length) {
      try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify(seen)); } catch (e) { /* ignoré */ }
    }
  }
  setInterval(checkReminders, 30000);

  /* ---------- Fenêtre des réglages ---------- */
  async function openSettings() {
    const api = window.dayanApp;
    const local = api && api.getSettings ? await api.getSettings() : null;
    const pcfg = api && api.getPrinters ? await api.getPrinters() : null;
    const row = (id, label, checked, hint) => `<label class="checkline"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span>${label}${hint ? `<small class="hint-line">${hint}</small>` : ''}</span></label>`;
    $('#modal-root').innerHTML = `
      <div class="overlay" id="overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Réglages">
          <div class="modal-head"><h3>Réglages</h3><button type="button" class="btn btn-quiet icon-btn" data-close aria-label="Fermer">✕</button></div>
          <div class="modal-body">
            <p class="section-title">Rappels Windows</p>
            ${row('s_remind', 'Activer les rappels', prefs.remind)}
            <label class="field"><span>Prévenir avant une tâche ou un rendez-vous</span>
              <select id="s_lead">${[5, 10, 15, 30, 60].map((m) => `<option value="${m}" ${prefs.lead === m ? 'selected' : ''}>${m} minutes avant</option>`).join('')}</select></label>
            ${row('s_prints', 'Prévenir quand une impression doit être terminée', prefs.prints)}
            ${row('s_dues', 'Résumé du matin des commandes à rendre ou en retard', prefs.dues)}
            ${row('s_stock', 'Prévenir quand un stock est bas', prefs.stock)}
            ${row('s_comments', 'Prévenir des nouveaux commentaires sur les commandes', prefs.comments)}
            ${row('s_shop', 'Prévenir des nouvelles commandes de la boutique du site', prefs.shop)}
            ${row('s_maint', 'Prévenir quand un entretien de machine est à faire', prefs.maint)}
            ${row('s_printers', 'Prévenir quand une imprimante a fini ou signale une erreur', prefs.printers)}
            ${local ? `
              <p class="section-title">Cet ordinateur</p>
              ${row('s_keep', 'Garder l’application active en fermant la fenêtre', local.keepRunning, 'Elle reste près de l’horloge pour envoyer les rappels. Pour quitter : clic droit sur son icône.')}
              ${local.packaged ? row('s_auto', 'Lancer l’application au démarrage de Windows', local.autostart) : ''}` : ''}
            ${pcfg ? `
              <p class="section-title">Imprimantes (état en direct)</p>
              <small class="hint-line">Cet ordinateur lit les imprimantes du réseau local et partage leur état avec l’équipe (pages Aujourd’hui et Affichage atelier). Laisse l’application ouverte sur ce poste. Aucune commande n’est envoyée aux imprimantes.</small>
              <div class="pr-scan"><button type="button" class="btn btn-small" id="pr-scan">Chercher les imprimantes sur le Wi-Fi</button><span id="pr-scan-state" class="pr-result" role="status"></span></div>
              <div id="pr-found"></div>
              ${row('s_prel', 'Cet ordinateur relaie l’état des imprimantes', pcfg.relay)}
              ${row('s_pauto', 'Mettre à jour les impressions automatiquement', pcfg.auto, 'Une impression planifiée passe à « En impression » au démarrage, puis à « Terminée » à la fin.')}
              <div id="pr-list">${state.machines.map((m) => {
                const c = (pcfg.printers || []).find((x) => x.machine_id === m.id) || {};
                return `<div class="pr-row" data-m="${m.id}" data-type="${esc(c.type || '')}"><b>${esc(m.name)}</b>
                  <select class="pr-type" aria-label="Type d’imprimante"><option value="">Pas connectée</option><option value="bambu" ${c.type === 'bambu' ? 'selected' : ''}>Bambu Lab (réseau local)</option><option value="moonraker" ${c.type === 'moonraker' ? 'selected' : ''}>Klipper / Moonraker (Creality K1, Elegoo Neptune 4…)</option></select>
                  <input class="pr-host" type="text" placeholder="Adresse IP (ex. 192.168.1.50)" value="${esc(c.host || '')}" aria-label="Adresse IP">
                  <input class="pr-port only-moon" type="number" placeholder="Port (7125)" value="${esc(c.port || '')}" aria-label="Port">
                  <input class="pr-serial only-bambu" type="text" placeholder="Numéro de série" value="${esc(c.serial || '')}" aria-label="Numéro de série">
                  <input class="pr-code only-bambu" type="text" placeholder="Code d’accès" value="${esc(c.code || '')}" aria-label="Code d’accès">
                  <span class="pr-actions"><button type="button" class="btn btn-small pr-test">Tester</button><span class="pr-result" role="status"></span></span></div>`;
              }).join('')}</div>
              <small class="hint-line">Bambu Lab : active le mode « réseau local » sur l’imprimante ; le code d’accès et le numéro de série sont dans ses réglages. Creality K1 et Elegoo Neptune 4 : l’adresse IP suffit (port 7125). Le code d’accès reste sur cet ordinateur.</small>
              <div><button type="button" class="btn btn-small" id="pr-save">Enregistrer les imprimantes</button></div>` : ''}
            ${!api ? `
              <p class="section-title">Ce navigateur</p>
              <div class="checkline"><span>Notifications : <b id="n-state"></b><small class="hint-line">Elles s’affichent quand l’application est ouverte ou en arrière-plan. Pour les recevoir, autorise-les.</small></span></div>
              <div><button type="button" class="btn btn-small" id="n-allow">Autoriser les notifications</button></div>
              <p class="section-title">Installer sur l’écran d’accueil</p>
              <small class="hint-line">Android (Chrome) : menu ⋮, puis « Installer l’application ». iPhone et iPad (Safari) : bouton Partager, puis « Sur l’écran d’accueil ». Les notifications ne sont proposées sur iPhone qu’une fois l’appli installée.</small>` : ''}
            <div><button type="button" class="btn btn-small" id="s_test">Tester un rappel</button> <button type="button" class="btn btn-small" data-act="tour" id="s_tour">Revoir la visite guidée</button></div>
          </div>
          <div class="modal-foot"><span class="grow"></span><button type="button" class="btn btn-primary" data-close>Terminé</button></div>
        </div>
      </div>`;
    const ov = $('#overlay');
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeModal(); });
    ov.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
    const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener('change', fn); };
    bind('#s_remind', (e) => { prefs.remind = e.target.checked; savePrefs(); });
    bind('#s_lead', (e) => { prefs.lead = Number(e.target.value); savePrefs(); });
    bind('#s_prints', (e) => { prefs.prints = e.target.checked; savePrefs(); });
    bind('#s_dues', (e) => { prefs.dues = e.target.checked; savePrefs(); });
    bind('#s_stock', (e) => { prefs.stock = e.target.checked; savePrefs(); });
    bind('#s_comments', (e) => { prefs.comments = e.target.checked; savePrefs(); });
    bind('#s_shop', (e) => { prefs.shop = e.target.checked; savePrefs(); });
    bind('#s_maint', (e) => { prefs.maint = e.target.checked; savePrefs(); });
    bind('#s_printers', (e) => { prefs.printers = e.target.checked; savePrefs(); });
    bind('#s_keep', (e) => api.setSettings({ keepRunning: e.target.checked }));
    bind('#s_auto', (e) => api.setSettings({ autostart: e.target.checked }));
    if (pcfg) {
      const rowCfg = (row) => ({
        machine_id: row.dataset.m,
        type: row.querySelector('.pr-type').value,
        host: row.querySelector('.pr-host').value.trim(),
        port: row.querySelector('.pr-port').value ? Number(row.querySelector('.pr-port').value) : undefined,
        serial: row.querySelector('.pr-serial').value.trim(),
        code: row.querySelector('.pr-code').value.trim()
      });
      $('#pr-list').addEventListener('change', (e) => { if (e.target.classList.contains('pr-type')) e.target.closest('.pr-row').dataset.type = e.target.value; });
      $('#pr-list').addEventListener('click', async (e) => {
        const btn = e.target.closest('.pr-test');
        if (!btn) return;
        const row = btn.closest('.pr-row');
        const out = row.querySelector('.pr-result');
        out.className = 'pr-result';
        out.textContent = 'Test en cours…';
        btn.disabled = true;
        const r = await api.testPrinter(rowCfg(row));
        btn.disabled = false;
        if (r && r.ok) { out.className = 'pr-result ok'; out.textContent = `Connectée : ${LIVE_FR[r.status.state] || r.status.state}${r.status.state === 'printing' && r.status.progress != null ? ` (${Math.round(r.status.progress)} %)` : ''}`; }
        else { out.className = 'pr-result bad'; out.textContent = (r && r.error) || 'Échec du test'; }
      });
      $('#pr-scan').addEventListener('click', async () => {
        const btn = $('#pr-scan');
        const stEl = $('#pr-scan-state');
        const box = $('#pr-found');
        btn.disabled = true;
        stEl.className = 'pr-result';
        stEl.textContent = 'Recherche en cours, environ 10 secondes…';
        box.innerHTML = '';
        const r = await api.discoverPrinters();
        btn.disabled = false;
        if (!r || r.error) { stEl.className = 'pr-result bad'; stEl.textContent = (r && r.error) || 'Recherche impossible.'; return; }
        const items = [...(r.bambu || []), ...(r.moonraker || [])];
        stEl.textContent = items.length
          ? `${items.length} imprimante${items.length > 1 ? 's' : ''} trouvée${items.length > 1 ? 's' : ''} (${r.scanned || 0} adresses testées)`
          : `Aucune imprimante trouvée (${r.scanned || 0} adresses testées sur ${(r.networks || []).join(', ')}). Vérifie qu’elles sont allumées et sur le même Wi-Fi que cet ordinateur.`;
        const rows = () => [...document.querySelectorAll('#pr-list .pr-row')];
        const taken = new Set();
        const guess = (x) => {
          const free = rows().filter((rw) => !taken.has(rw.dataset.m));
          const nameOf = (rw) => rw.querySelector('b').textContent;
          const re = x.type === 'bambu' ? /bambu/i : /creality|elegoo|k1|neptune|klipper/i;
          const pick = free.find((rw) => re.test(nameOf(rw))) || free.find((rw) => !rw.querySelector('.pr-type').value) || free[0] || rows()[0];
          if (pick) taken.add(pick.dataset.m);
          return pick ? pick.dataset.m : '';
        };
        box.innerHTML = items.map((x, i) => {
          const label = x.type === 'bambu' ? `Bambu Lab ${x.model || ''}${x.name ? ` « ${x.name} »` : ''}` : `Imprimante Klipper${x.name ? ` « ${x.name} »` : ''}`;
          const detail = x.type === 'bambu' ? `${x.host}, série ${x.serial}` : `${x.host}, port ${x.port}${x.detail ? `, Moonraker ${x.detail}` : ''}`;
          const chosen = guess(x);
          return `<div class="pr-found" data-i="${i}"><span class="pf-label"><b>${esc(label.trim())}</b><small>${esc(detail)}</small></span>
            <select class="pf-machine" aria-label="Machine">${state.machines.map((m) => `<option value="${m.id}" ${m.id === chosen ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
            <button type="button" class="btn btn-small pf-use">Utiliser</button></div>`;
        }).join('');
        box.onclick = (e) => {
          const btnUse = e.target.closest('.pf-use');
          if (!btnUse) return;
          const item = items[Number(btnUse.closest('.pr-found').dataset.i)];
          const rw = rows().find((x) => x.dataset.m === btnUse.closest('.pr-found').querySelector('.pf-machine').value);
          if (!item || !rw) return;
          const type = rw.querySelector('.pr-type');
          type.value = item.type;
          type.dispatchEvent(new Event('change', { bubbles: true }));
          rw.querySelector('.pr-host').value = item.host;
          if (item.type === 'moonraker') rw.querySelector('.pr-port').value = item.port && item.port !== 7125 ? item.port : '';
          if (item.type === 'bambu') rw.querySelector('.pr-serial').value = item.serial;
          const out = rw.querySelector('.pr-result');
          out.className = 'pr-result';
          out.textContent = item.type === 'bambu' ? 'Adresse et numéro de série renseignés : saisis le code d’accès, puis « Tester ».' : 'Adresse renseignée : clique sur « Tester », puis « Enregistrer ».';
          if (item.type === 'bambu') rw.querySelector('.pr-code').focus();
        };
      });
      $('#pr-save').addEventListener('click', async () => {
        const list = [...document.querySelectorAll('#pr-list .pr-row')].map(rowCfg).filter((c) => c.type && c.host);
        printerCfg = await api.setPrinters({ relay: $('#s_prel').checked, auto: $('#s_pauto').checked, printers: list });
        toast(printerCfg.relay ? 'Imprimantes enregistrées : ce poste relaie leur état' : 'Imprimantes enregistrées (relais désactivé)');
      });
    }
    const paintNotif = () => {
      const el = $('#n-state');
      if (!el) return;
      el.textContent = !('Notification' in window) ? 'non disponibles ici (installe d’abord l’appli sur l’écran d’accueil)'
        : { granted: 'autorisées', denied: 'refusées (à changer dans les réglages du navigateur)', default: 'pas encore autorisées' }[Notification.permission];
    };
    paintNotif();
    const allow = $('#n-allow');
    if (allow) allow.addEventListener('click', async () => { if ('Notification' in window) { await Notification.requestPermission(); paintNotif(); } });
    $('#s_test').addEventListener('click', () => {
      if ('Notification' in window && !(window.dayanApp && window.dayanApp.notify) && Notification.permission === 'default') Notification.requestPermission();
      pushNotification('Rappel de test', 'Si tu vois ce message, les rappels fonctionnent.');
      toast('Rappel de test envoyé');
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Mises à jour de l'application (Electron)                           */
  /* ------------------------------------------------------------------ */
  function showUpdate(s) {
    const box = $('#upd');
    const text = $('#upd-text');
    const btn = $('#upd-install');
    btn.classList.add('hidden');
    box.classList.remove('ready');
    box.removeAttribute('title');
    const msg = {
      checking: 'Recherche de mises à jour…',
      none: 'L’application est à jour.',
      disabled: 'Mises à jour non configurées (voir updates.json).',
      downloading: `Téléchargement de la version ${s.version || ''} : ${s.percent || 0} %`,
      ready: `La version ${s.version || ''} est prête.`,
      error: 'Impossible de vérifier les mises à jour pour le moment.'
    }[s.state];
    if (!msg) { box.classList.add('hidden'); return; }
    text.textContent = msg;
    if (s.state === 'error' && s.message) box.title = s.message;
    if (s.state === 'ready') { box.classList.add('ready'); btn.classList.remove('hidden'); }
    box.classList.remove('hidden');
    if (s.state === 'none') setTimeout(() => { if (text.textContent === msg) box.classList.add('hidden'); }, 4000);
  }

  function setupUpdater() {
    const api = window.dayanApp;
    if (!api) {
      $('#ver').textContent = `Version web ${window.CONFIG.APP_VERSION || ''}`;
      $('#upd-check').classList.add('hidden');
      return;
    }
    api.version().then((v) => { $('#ver').textContent = `Version ${v}`; });
    api.onUpdate(showUpdate);
    $('#upd-check').addEventListener('click', () => api.checkUpdates());
    $('#upd-install').addEventListener('click', () => api.installUpdate());
  }
  setupUpdater();
  setupPrinters();
  $('#open-settings').addEventListener('click', openSettings);

  /* ------------------------------------------------------------------ */
  /*  Démarrage                                                          */
  /* ------------------------------------------------------------------ */
  (async function init() {
    try {
      const { data } = await sb.auth.getSession();
      if (data.session) await start(data.session);
      else showLogin();
    } catch (ex) {
      showLogin();
    }
  })();

  window.__dayan = { labelData, openLabelDialog, scanPayload, qrSvg, handleScanLink, openScanned, needsDrying, filTitle, openWeigh, openSpoolDetail, billingExport, splitAddress, startTour, maybeOfferTour, openHelp, tourSteps: TOUR_STEPS, state, render, loadAll, computeReminders, checkReminders, prefs, purgeOldTrash, planJobs, handlePrinterStatus, liveOf, getPrinterCfg: () => printerCfg };
})();
