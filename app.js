// Fabric Vault — reads and writes fabric through a Google Apps Script web app attached to your Google Sheet.
// With no web app address in config.js, it runs in demo mode with sample fabrics.
(() => {
  'use strict';

  const CONFIG = window.FV_CONFIG || {};
  const API = String(CONFIG.API_URL || '').trim();
  const DEMO = !API;
  const LOW = 0.5;            // yards at or below this count as running low
  const UNSORTED = 'Unsorted';
  const FAMILIES = [
    { name: 'Reds', dot: '#c8102e' },
    { name: 'Oranges', dot: '#ff7a1a' },
    { name: 'Yellows', dot: '#ffcc00' },
    { name: 'Greens', dot: '#5e8c4a' },
    { name: 'Blues', dot: '#2f6fb5' },
    { name: 'Purples', dot: '#7a4fa0' },
    { name: 'Pinks', dot: '#f29bb7' },
    { name: 'Browns', dot: '#8a5a3b' },
    { name: 'Neutrals', dot: '#e6dccb' },
    { name: 'Black & White', dot: 'linear-gradient(135deg, #1d1d1d 50%, #ffffff 50%)' }
  ];
  const FAMILY_NAMES = FAMILIES.map(f => f.name);
  const UNSORTED_DOT = 'conic-gradient(#c8102e, #ffcc00, #5e8c4a, #2f6fb5, #7a4fa0, #c8102e)';

  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round2 = n => Math.round(n * 100) / 100;
  const toYards = v => { if (v === '' || v == null) return ''; const n = Number(v); return isFinite(n) ? Math.max(0, round2(n)) : ''; };
  const fmt = v => (v === '' ? '–' : String(v));
  const dotFor = name => (FAMILIES.find(f => f.name === name) || { dot: UNSORTED_DOT }).dot;

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } }
  };

  const state = {
    fabrics: [],
    edit: false,
    pass: '',
    family: 'all',     // colour chip filter
    show: 'all',       // all | low | out | tocount
    q: '',
    openId: null,
    suggestions: store.get('fv-suggest') || {}
  };

  function status(f) {
    if (f.yards === '') return 'tocount';
    if (f.yards <= 0) return 'out';
    if (f.yards <= LOW) return 'low';
    return 'ok';
  }

  function photoUrl(f, size) {
    if (f.photoData) return f.photoData;
    if (f.photoId) return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(f.photoId) + '&sz=w' + (size || 800);
    return '';
  }

  // Photo tag with a backup address: Drive sometimes turns away a request, so a failed photo retries once another way.
  function imgTag(f, size, alt, extra) {
    const url = photoUrl(f, size);
    if (!url) return '<span class="noph">No photo</span>';
    return '<img src="' + esc(url) + '" alt="' + esc(alt || '') + '" data-pid="' + esc(f.photoData ? '' : f.photoId) + '" data-size="' + size + '" referrerpolicy="no-referrer"' + (extra || '') + '>';
  }

  document.addEventListener('error', e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.pid) return;
    if (!img.dataset.tried) {
      img.dataset.tried = '1';
      img.src = 'https://lh3.googleusercontent.com/d/' + encodeURIComponent(img.dataset.pid) + '=w' + (img.dataset.size || 800);
    } else if (img.id === 'photoPreview') {
      img.hidden = true;
    } else {
      const s = document.createElement('span');
      s.className = 'noph';
      s.textContent = 'Photo didn’t load';
      img.replaceWith(s);
    }
  }, true);

  function normalize(f) {
    return {
      id: String(f.id || ''),
      name: String(f.name || ''),
      family: FAMILY_NAMES.includes(f.family) ? f.family : UNSORTED,
      source: String(f.source || ''),
      fibre: String(f.fibre || ''),
      width: String(f.width || ''),
      yards: toYards(f.yards),
      paid: f.paid === '' || f.paid == null || !isFinite(Number(f.paid)) ? '' : Number(f.paid),
      bin: String(f.bin || ''),
      notes: String(f.notes || ''),
      photoId: String(f.photoId || ''),
      photoData: f.photoData || ''
    };
  }

  const byId = id => state.fabrics.find(f => f.id === id);

  // ---------- Backends ----------

  const real = {
    async list() {
      const r = await fetch(API + '?action=list', { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Could not load the Vault.');
      return j.fabrics;
    },
    async call(body) {
      const r = await fetch(API, { method: 'POST', body: JSON.stringify(Object.assign({ passcode: state.pass }, body)) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'That didn’t save. Try again.');
      return j;
    },
    check(pass) { return this.call({ action: 'check', passcode: pass }); },
    update(id, fabric, photo) { return this.call({ action: 'update', id, fabric, photo: photo || '' }); },
    add(fabric, photo) { return this.call({ action: 'add', fabric, photo: photo || '' }); },
    remove(id) { return this.call({ action: 'remove', id }); },
    importPhotos() { return this.call({ action: 'import' }); },
    async thumb(f) {
      if (!f.photoId) return '';
      const r = await fetch(API + '?action=thumb&id=' + encodeURIComponent(f.photoId));
      const j = await r.json();
      return j.ok ? j.data : '';
    }
  };

  function swatch(hex, print) {
    const pattern = print
      ? '<circle cx="12" cy="12" r="7" fill="#fff" opacity=".8"/><circle cx="36" cy="34" r="6" fill="#14283f" opacity=".45"/>'
      : '<path d="M0 6h48M0 18h48M0 30h48M0 42h48" stroke="#000" stroke-opacity=".07" stroke-width="3"/>';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><defs><pattern id="p" width="48" height="48" patternUnits="userSpaceOnUse">' +
      pattern + '</pattern></defs><rect width="100%" height="100%" fill="' + hex + '"/><rect width="100%" height="100%" fill="url(#p)"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  const demo = {
    data: null,
    imported: false,
    seed() {
      const rows = [
        ['FV-002', 'Mid-wash denim', 'Blues', 'Fabric shop', 'Denim', '60 in', 8, 12, 'D1', '', '#3a5f8f'],
        ['FV-003', 'Cherry linen', 'Reds', 'Market stall', 'Linen', '54 in', 4.5, 9.5, 'A1', '', '#b3122b'],
        ['FV-005', 'Mustard corduroy', 'Yellows', 'Fabric shop', 'Corduroy', '57 in', 6, 14, 'B3', '', '#d9a400'],
        ['FV-008', 'Marigold voile', 'Oranges', 'Fabric shop', 'Voile', '58 in', 3.25, 8, 'B1', '', '#f28a1e'],
        ['FV-011', 'Sage double gauze', 'Greens', 'Online', 'Double gauze', '52 in', 2.5, 16, 'C1', '', '#9bb08a'],
        ['FV-014', '', 'Blues', 'Charity shop', 'Chambray', '44 in', 1, 3, 'D1', '', '#7f9fc4'],
        ['FV-017', '', 'Reds', 'Charity shop', 'Cotton', '44 in', 0.4, 3, 'A1', 'Slightly faded selvedge', '#d63a3a'],
        ['FV-019', '', 'Yellows', 'Gift', 'Cotton', '44 in', 0.25, '', 'B3', '', '#ffd84d'],
        ['FV-022', '', 'Oranges', 'Market stall', 'Cotton print', '44 in', 1.75, 6, 'B1', 'Orange florals on cream', '#e9762b', true],
        ['FV-027', '', 'Greens', 'Market stall', 'Cotton print', '44 in', 5, 7, 'C1', 'Print on green ground', '#3f7a4f', true],
        ['FV-030', 'Rust gingham', 'Oranges', 'Online', 'Cotton', '44 in', 0, 5, 'B2', '', '#c4561f'],
        ['FV-033', 'Olive twill', 'Greens', 'Fabric shop', 'Twill', '58 in', 0.5, 11, 'C2', '', '#6b6b2e'],
        ['FV-036', 'Navy ditsy', 'Blues', 'Online', 'Cotton print', '44 in', 3, 9, 'D2', '', '#1f3558', true],
        ['FV-041', 'Brick canvas', 'Reds', 'Online', 'Canvas', '60 in', 2, 10, 'A2', '', '#9c3b2c'],
        ['FV-044', 'Oat linen', 'Neutrals', 'Fabric shop', 'Linen', '55 in', 3.5, 13, 'E1', '', '#d9cdb6'],
        ['FV-048', 'Sky poplin', 'Blues', 'Fabric shop', 'Poplin', '58 in', 4.25, 7.5, 'D2', '', '#8fc3f0'],
        ['FV-050', 'Plum velvet', 'Purples', 'Online', 'Velvet', '54 in', 1.5, 18, 'E2', '', '#5a2a5e'],
        ['FV-052', '', 'Reds', 'Swap meet', 'Cotton print', '44 in', 1.25, '', 'A2', 'Red ground, small white dots', '#c8263a', true]
      ];
      this.data = rows.map(r => ({ id: r[0], name: r[1], family: r[2], source: r[3], fibre: r[4], width: r[5], yards: r[6], paid: r[7], bin: r[8], notes: r[9], photoData: swatch(r[10], r[11]) }));
    },
    async list() { if (!this.data) this.seed(); return this.data.map(f => ({ ...f })); },
    async check(pass) { if (pass !== 'demo') throw new Error('Wrong passcode. In demo mode it’s “demo”.'); return { ok: true }; },
    async update(id, fabric, photo) {
      const f = this.data.find(x => x.id === id);
      if (!f) throw new Error('That fabric isn’t in the Vault any more.');
      Object.assign(f, fabric);
      if (photo) f.photoData = photo;
      return { ok: true, fabric: { ...f } };
    },
    async add(fabric, photo) {
      const n = Math.max(0, ...this.data.map(x => parseInt(x.id.slice(3), 10) || 0)) + 1;
      const f = Object.assign({}, fabric, { id: 'FV-' + String(n).padStart(3, '0'), photoData: photo || '' });
      this.data.push(f);
      return { ok: true, fabric: { ...f } };
    },
    async remove(id) { this.data = this.data.filter(x => x.id !== id); return { ok: true }; },
    async importPhotos() {
      if (this.imported) return { ok: true, added: 0, remaining: 0 };
      this.imported = true;
      const n = Math.max(0, ...this.data.map(x => parseInt(x.id.slice(3), 10) || 0));
      [['#2b8a8a'], ['#e79ab5', true], ['#7b4a2e'], ['#f4f1ea']].forEach(([hex, print], i) => {
        this.data.push({ id: 'FV-' + String(n + i + 1).padStart(3, '0'), name: '', family: UNSORTED, yards: '', photoData: swatch(hex, print) });
      });
      return { ok: true, added: 4, remaining: 0 };
    },
    async thumb(f) { return f.photoData; }
  };

  const backend = DEMO ? demo : real;

  // ---------- Rendering ----------

  const el = {
    stats: $('#stats'), chips: $('#chips'), library: $('#library'), search: $('#search'),
    lockBtn: $('#lockBtn'), addBtn: $('#addBtn'), importBtn: $('#importBtn'), fab: $('#fab'),
    detail: $('#detail'), formDlg: $('#formDlg'), form: $('#fabricForm'), lockDlg: $('#lockDlg'),
    toast: $('#toast'), demoNote: $('#demoNote')
  };

  const LOCK_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const OPEN_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>';
  const CLOSE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  function render() {
    renderHeader();
    renderStats();
    renderChips();
    renderLibrary();
  }

  function renderHeader() {
    el.lockBtn.innerHTML = state.edit ? OPEN_ICON + 'Editing · lock' : LOCK_ICON + 'Edit mode';
    el.lockBtn.classList.toggle('on', state.edit);
    el.lockBtn.setAttribute('aria-pressed', String(state.edit));
    el.addBtn.hidden = el.fab.hidden = el.importBtn.hidden = !state.edit;
    el.demoNote.hidden = !DEMO;
  }

  function tile(label, n, cls, show) {
    const inner = '<span class="t">' + esc(label) + '</span><span class="n">' + esc(n) + '</span>';
    if (!show) return '<div class="tile ' + cls + '">' + inner + '</div>';
    return '<button type="button" class="tile ' + cls + '" data-show="' + show + '" aria-pressed="' + (state.show === show) + '">' + inner + '</button>';
  }

  function renderStats() {
    const fs = state.fabrics;
    const total = round2(fs.reduce((s, f) => s + (f.yards === '' ? 0 : f.yards), 0));
    const count = st => fs.filter(f => status(f) === st).length;
    const toCount = count('tocount');
    el.stats.innerHTML =
      tile('Fabrics', fs.length, '', 'all') +
      tile('Yards on hand', total, '') +
      tile('Running low · 0.5 yd or less', count('low'), 'low', 'low') +
      tile('Used up', count('out'), 'out', 'out') +
      (toCount ? tile('Yards to measure', toCount, 'tocount', 'tocount') : '');
  }

  function renderChips() {
    const counts = {};
    state.fabrics.forEach(f => { counts[f.family] = (counts[f.family] || 0) + 1; });
    const fams = (counts[UNSORTED] ? [{ name: UNSORTED, dot: UNSORTED_DOT }] : []).concat(FAMILIES);
    if (state.family === UNSORTED && !counts[UNSORTED]) state.family = 'all';
    el.chips.innerHTML =
      '<button type="button" class="chip all" data-family="all" aria-pressed="' + (state.family === 'all') + '">All colours</button>' +
      fams.map(f => '<button type="button" class="chip" data-family="' + esc(f.name) + '" aria-pressed="' + (state.family === f.name) + '">' +
        '<span class="swatch-dot" style="background:' + f.dot + '"></span>' + esc(f.name) + ' <span class="c">' + (counts[f.name] || 0) + '</span></button>').join('');
  }

  function matches(f) {
    if (state.family !== 'all' && f.family !== state.family) return false;
    if (state.show !== 'all' && status(f) !== state.show) return false;
    if (state.q) {
      const hay = [f.id, f.name, f.source, f.fibre, f.bin, f.notes, f.width, f.family].join(' ').toLowerCase();
      if (!state.q.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  }

  function sortKey(f) { return (status(f) === 'out' ? 1 : 0) + ':' + f.id; }

  function renderLibrary() {
    const list = state.fabrics.filter(matches);
    if (!state.fabrics.length) {
      el.library.innerHTML = '<div class="empty">The Vault is empty. Unlock <b>Edit mode</b>, then tap <b>Import photos</b> to bring in your Google Drive photos, or <b>+ Add fabric</b> to add one.</div>';
      return;
    }
    if (!list.length) {
      el.library.innerHTML = '<div class="empty">No fabric matches. Try another colour or clear the search.</div>';
      return;
    }
    const order = [UNSORTED].concat(FAMILY_NAMES);
    el.library.innerHTML = order.map(name => {
      const items = list.filter(f => f.family === name).sort((a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { numeric: true }));
      if (!items.length) return '';
      const yd = round2(items.reduce((s, f) => s + (f.yards === '' ? 0 : f.yards), 0));
      const note = name === UNSORTED
        ? '<p class="section-note">' + (state.edit ? 'Tap the colour dot that matches each fabric’s main colour. The ringed dot is a suggestion from the photo.' : 'New photos waiting to be filed by colour.') + '</p>'
        : '';
      return '<section class="section" aria-labelledby="h-' + esc(name.replace(/\W+/g, '')) + '">' +
        '<div class="section-head"><span class="swatch-dot" style="background:' + dotFor(name) + '"></span>' +
        '<h2 id="h-' + esc(name.replace(/\W+/g, '')) + '">' + esc(name) + '</h2>' +
        '<span class="sum">' + items.length + ' fabric' + (items.length === 1 ? '' : 's') + ' · ' + yd + ' yd</span></div>' +
        note + '<div class="cards">' + items.map(cardHTML).join('') + '</div></section>';
    }).join('');
    if (state.edit) queueSuggestions(list.filter(f => f.family === UNSORTED));
  }

  function cardHTML(f) {
    const st = status(f);
    const badge = st === 'low' ? '<span class="badge low">Low</span>'
      : st === 'out' ? '<span class="badge out">Used up</span>'
      : st === 'tocount' ? '<span class="badge tocount">Measure</span>' : '';
    const meta = [f.source, f.fibre].filter(Boolean).join(' · ');
    return '<article class="card ' + st + '">' +
      '<button type="button" class="card-main" data-open="' + esc(f.id) + '">' +
        '<span class="ph">' + imgTag(f, 800, '', ' loading="lazy"') + badge + '</span>' +
        '<span class="card-body">' +
          '<span class="cid">' + esc(f.id) + (f.bin ? ' · ' + esc(f.bin) : '') + '</span>' +
          '<span class="cname' + (f.name ? '' : ' unnamed') + '">' + esc(f.name || 'Unnamed fabric') + '</span>' +
          (meta ? '<span class="cmeta">' + esc(meta) + '</span>' : '') +
          '<span class="cyd"><b>' + fmt(f.yards) + '</b> yd left</span>' +
        '</span>' +
      '</button>' +
      (state.edit && f.family === UNSORTED ? sorterHTML(f) : '') +
    '</article>';
  }

  function sorterHTML(f) {
    const sug = state.suggestions[f.id];
    return '<div class="sorter" data-sorter="' + esc(f.id) + '">' +
      '<span class="sorter-label">' + (sug ? 'Suggested: ' + esc(sug) : 'Pick its main colour') + '</span>' +
      '<div class="dots">' + FAMILIES.map(fam =>
        '<button type="button" class="dot' + (sug === fam.name ? ' suggested' : '') + '" style="background:' + fam.dot + '" data-setfam="' + esc(fam.name) + '" data-id="' + esc(f.id) + '" aria-label="File ' + esc(f.id) + ' under ' + esc(fam.name) + '" title="' + esc(fam.name) + '"></button>'
      ).join('') + '</div></div>';
  }

  // ---------- Colour suggestions from the photo ----------

  const tried = new Set();
  const queue = [];
  let running = 0;

  function queueSuggestions(list) {
    list.forEach(f => {
      if (state.suggestions[f.id] || tried.has(f.id)) return;
      tried.add(f.id);
      queue.push(f);
    });
    pump();
  }

  function pump() {
    while (running < 3 && queue.length) {
      const f = queue.shift();
      running++;
      suggest(f).catch(() => {}).finally(() => { running--; pump(); });
    }
  }

  async function suggest(f) {
    const src = await backend.thumb(f);
    if (!src) return;
    const fam = await dominantFamily(src);
    if (!fam) return;
    state.suggestions[f.id] = fam;
    store.set('fv-suggest', state.suggestions);
    const box = document.querySelector('[data-sorter="' + CSS.escape(f.id) + '"]');
    if (box) {
      box.querySelector('.sorter-label').textContent = 'Suggested: ' + fam;
      box.querySelectorAll('.dot').forEach(d => d.classList.toggle('suggested', d.dataset.setfam === fam));
    }
  }

  function dominantFamily(src) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 48;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          const w = img.naturalWidth || 480, h = img.naturalHeight || 360;
          // Look at the middle 70% so a table or floor at the edges doesn't win.
          ctx.drawImage(img, w * 0.15, h * 0.15, w * 0.7, h * 0.7, 0, 0, 48, 48);
          const d = ctx.getImageData(0, 0, 48, 48).data;
          const tally = {};
          for (let i = 0; i < d.length; i += 4) {
            const fam = classify(d[i], d[i + 1], d[i + 2]);
            tally[fam] = (tally[fam] || 0) + 1;
          }
          resolve(Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0] || null);
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function classify(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    if (l < 0.13 || l > 0.94) return 'Black & White';
    if (s < 0.15) return l > 0.82 ? 'Black & White' : 'Neutrals';
    if (h >= 18 && h < 50 && l < 0.42) return 'Browns';
    if (h >= 20 && h < 60 && s < 0.45 && l > 0.62) return 'Neutrals';
    if (h >= 345 || h < 12) return l > 0.72 ? 'Pinks' : 'Reds';
    if (h < 42) return 'Oranges';
    if (h < 68) return 'Yellows';
    if (h < 165) return 'Greens';
    if (h < 255) return 'Blues';
    if (h < 290) return 'Purples';
    return l > 0.55 || h > 320 ? 'Pinks' : 'Purples';
  }

  // ---------- Fabric details ----------

  function fact(label, value, wide) {
    if (value === '' || value == null) return '';
    return '<div' + (wide ? ' class="wide"' : '') + '><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
  }

  function warnText(y) {
    if (y === '') return 'Not measured yet.';
    if (y <= 0) return 'Used up. It stays in the Vault, greyed out, so you know to restock.';
    if (y <= LOW) return 'Running low: 0.5 yd or less left. Don’t promise this one at a pop-up.';
    return '';
  }

  function yardsHTML(f) {
    const st = status(f);
    if (!state.edit) {
      return '<div class="yards ' + st + '"><span class="t">Yards remaining</span><span class="big-n">' + fmt(f.yards) + '</span>' +
        '<p class="warn">' + esc(warnText(f.yards)) + '</p></div>';
    }
    return '<form class="yards ' + st + '" id="yardsForm">' +
      '<label for="ydInput">Yards remaining</label>' +
      '<div class="stepper">' +
        '<button type="button" class="step" data-step="-0.25" aria-label="Take off a quarter yard">−</button>' +
        '<input id="ydInput" type="number" inputmode="decimal" min="0" step="0.01" value="' + esc(f.yards) + '" placeholder="–">' +
        '<button type="button" class="step" data-step="0.25" aria-label="Add a quarter yard">+</button>' +
      '</div>' +
      '<p class="warn" id="ydWarn">' + esc(warnText(f.yards)) + '</p>' +
      (state.saving === f.id
        ? '<button class="btn primary big" type="submit" disabled>Saving…</button>'
        : '<button class="btn primary big" type="submit">Save yards</button>') +
    '</form>';
  }

  function openDetail(id) {
    state.openId = id;
    renderDetail();
    if (!el.detail.open) el.detail.showModal();
  }

  function renderDetail() {
    const f = byId(state.openId);
    if (!f) { if (el.detail.open) el.detail.close(); return; }
    el.detail.innerHTML =
      '<div class="sheet-photo">' +
        imgTag(f, 1600, 'Photo of ' + (f.name || f.id)) +
        '<button type="button" class="close" data-close aria-label="Close">' + CLOSE_ICON + '</button>' +
      '</div>' +
      '<div class="sheet-body">' +
        '<div><div class="cid">' + esc(f.id) + ' · ' + esc(f.family) + '</div>' +
        '<h2 class="sheet-title' + (f.name ? '' : ' unnamed') + '">' + esc(f.name || 'Unnamed fabric') + '</h2></div>' +
        yardsHTML(f) +
        '<dl class="facts">' +
          fact('Source', f.source) + fact('Fibre', f.fibre) + fact('Width', f.width) + fact('Stored', f.bin) +
          fact('Paid', f.paid === '' ? '' : 'S$' + f.paid.toFixed(2)) + fact('Notes', f.notes, true) +
        '</dl>' +
        (state.edit ? '<div><button type="button" class="btn" data-edit="' + esc(f.id) + '">Edit details</button></div>' : '') +
      '</div>';
  }

  el.detail.addEventListener('input', e => {
    if (e.target.id !== 'ydInput') return;
    const y = toYards(e.target.value);
    $('#ydWarn').textContent = warnText(y);
    $('#yardsForm').className = 'yards ' + status({ yards: y });
  });

  el.detail.addEventListener('submit', async e => {
    if (e.target.id !== 'yardsForm') return;
    e.preventDefault();
    const btn = e.target.querySelector('[type="submit"]');
    if (btn.disabled) return;
    const id = state.openId;
    state.saving = id;
    const ok = await saveFabric(id, { yards: toYards($('#ydInput').value) });
    state.saving = null;
    if (el.detail.open) renderDetail();
    if (ok) toast('Saved: ' + id + ' has ' + fmt(byId(id).yards) + ' yd left');
  });

  // ---------- Saving ----------

  function cache() { if (!DEMO) store.set('fv-cache', state.fabrics); }

  function afterChange() {
    cache();
    render();
    if (el.detail.open) renderDetail();
  }

  function handleError(e) {
    const msg = (e && e.message) || 'Something went wrong. Check your connection and try again.';
    if (/passcode/i.test(msg)) lock();
    toast(/Failed to fetch|NetworkError|Load failed/i.test(msg) ? 'No connection. Nothing was saved. Try again when you’re online.' : msg, true);
  }

  async function saveFabric(id, patch, photo) {
    const f = byId(id);
    if (!f) return false;
    const before = { ...f };
    Object.assign(f, patch);
    afterChange();
    try {
      const r = await backend.update(id, patch, photo);
      Object.assign(f, normalize(r.fabric));
      afterChange();
      return true;
    } catch (e) {
      Object.assign(f, before);
      afterChange();
      handleError(e);
      return false;
    }
  }

  // ---------- Add / edit form ----------

  let formMode = 'add', formId = null, pendingPhoto = '';
  const field = id => $('#f-' + id);

  $('#famPick').innerHTML = FAMILIES.map(f =>
    '<label><input type="radio" name="family" value="' + esc(f.name) + '"><span class="swatch-dot" style="background:' + f.dot + '"></span>' + esc(f.name) + '</label>'
  ).join('');

  function fillDatalists() {
    const uniq = key => [...new Set(state.fabrics.map(f => f[key]).filter(Boolean))].sort();
    $('#sources').innerHTML = uniq('source').map(v => '<option value="' + esc(v) + '">').join('');
    $('#fibres').innerHTML = uniq('fibre').map(v => '<option value="' + esc(v) + '">').join('');
  }

  function openForm(mode, id) {
    formMode = mode; formId = id || null; pendingPhoto = '';
    const f = id ? byId(id) : normalize({});
    $('#formTitle').textContent = mode === 'add' ? 'Add fabric' : 'Edit ' + f.id;
    ['name', 'source', 'fibre', 'width', 'bin', 'notes'].forEach(k => { field(k).value = f[k]; });
    field('yards').value = f.yards;
    field('paid').value = f.paid;
    field('photo').value = '';
    el.form.querySelectorAll('input[name="family"]').forEach(r => { r.checked = r.value === f.family; });
    const prev = $('#photoPreview'), url = id ? photoUrl(f, 800) : '';
    prev.hidden = !url;
    prev.dataset.pid = id && !f.photoData ? f.photoId : '';
    prev.dataset.size = '800';
    delete prev.dataset.tried;
    if (url) prev.src = url; else prev.removeAttribute('src');
    $('#removeBtn').hidden = mode === 'add';
    $('#formMsg').textContent = '';
    fillDatalists();
    el.formDlg.showModal();
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // Shrinks phone photos so they upload quickly and don't fill up your Drive.
  async function resizeImage(file, max) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.82);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  field('photo').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      pendingPhoto = await resizeImage(file, 1400);
      const prev = $('#photoPreview');
      prev.dataset.pid = '';
      prev.src = pendingPhoto;
      prev.hidden = false;
    } catch (err) {
      $('#formMsg').textContent = 'That photo couldn’t be read. Try another one.';
    }
  });

  el.form.addEventListener('submit', async e => {
    e.preventDefault();
    const checked = el.form.querySelector('input[name="family"]:checked');
    const current = formId ? byId(formId) : null;
    const data = {
      name: field('name').value.trim(),
      family: checked ? checked.value : (current ? current.family : ''),
      source: field('source').value.trim(),
      fibre: field('fibre').value.trim(),
      width: field('width').value.trim(),
      yards: toYards(field('yards').value),
      paid: field('paid').value === '' ? '' : Math.max(0, round2(Number(field('paid').value))),
      bin: field('bin').value.trim(),
      notes: field('notes').value.trim()
    };
    if (!data.family) { $('#formMsg').textContent = 'Pick a colour family.'; return; }
    if (formMode === 'add' && !pendingPhoto) { $('#formMsg').textContent = 'Add a photo of the fabric.'; return; }
    const btn = $('#saveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      if (formMode === 'add') {
        const r = await backend.add(data, pendingPhoto);
        const f = normalize(r.fabric);
        state.fabrics.push(f);
        afterChange();
        el.formDlg.close();
        toast('Added ' + f.id + ' to ' + f.family);
        openDetail(f.id);
      } else if (await saveFabric(formId, data, pendingPhoto)) {
        el.formDlg.close();
        toast('Saved ' + formId);
      }
    } catch (err) {
      handleError(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  });

  $('#removeBtn').addEventListener('click', async () => {
    const f = byId(formId);
    if (!f || !(await ask('Remove ' + f.id + ' from the Vault? Its photo stays in your Google Drive.', 'Remove', true))) return;
    try {
      await backend.remove(f.id);
      state.fabrics = state.fabrics.filter(x => x.id !== f.id);
      el.formDlg.close();
      if (el.detail.open) el.detail.close();
      afterChange();
      toast('Removed ' + f.id);
    } catch (err) { handleError(err); }
  });

  // ---------- Edit mode ----------

  function lock() {
    state.edit = false;
    state.pass = '';
    store.del('fv-pass');
    render();
    if (el.detail.open) renderDetail();
  }

  el.lockBtn.addEventListener('click', () => {
    if (state.edit) { lock(); toast('Locked. Visitors can look but not change anything.'); return; }
    $('#passInput').value = '';
    $('#lockMsg').textContent = '';
    el.lockDlg.showModal();
  });

  $('#lockForm').addEventListener('submit', async e => {
    e.preventDefault();
    const pass = $('#passInput').value;
    if (!pass) return;
    const btn = e.target.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      await backend.check(pass);
      state.edit = true;
      state.pass = pass;
      store.set('fv-pass', pass);
      el.lockDlg.close();
      render();
      if (el.detail.open) renderDetail();
      toast('Edit mode on');
    } catch (err) {
      $('#lockMsg').textContent = /Failed to fetch|NetworkError|Load failed/i.test(err.message) ? 'No connection. Try again when you’re online.' : err.message;
    } finally {
      btn.disabled = false;
    }
  });

  el.importBtn.addEventListener('click', async () => {
    if (!(await ask('Make a fabric card for every new photo in your Fabric Vault Drive folder? Photos already in the Vault are skipped.', 'Import'))) return;
    el.importBtn.disabled = true;
    let added = 0;
    try {
      for (;;) {
        const r = await backend.importPhotos();
        added += r.added || 0;
        if (!r.remaining) break;
        toast('Importing… ' + added + ' added, ' + r.remaining + ' to go');
      }
      await refresh();
      if (added) { state.family = UNSORTED; render(); }
      toast(added ? added + ' new fabrics are in Unsorted. Tap a colour dot to file each one.' : 'No new photos found in the folder.');
    } catch (err) {
      handleError(err);
      refresh();
    } finally {
      el.importBtn.disabled = false;
    }
  });

  // ---------- Clicks, filters, toast ----------

  document.addEventListener('click', e => {
    const t = e.target.closest('[data-open],[data-setfam],[data-family],[data-show],[data-close],[data-edit],[data-step]');
    if (!t) return;
    if (t.dataset.open) openDetail(t.dataset.open);
    else if (t.dataset.setfam) {
      const id = t.dataset.id, fam = t.dataset.setfam;
      saveFabric(id, { family: fam }).then(ok => { if (ok) toast(id + ' filed under ' + fam); });
    } else if (t.dataset.family) { state.family = t.dataset.family; render(); }
    else if (t.dataset.show) { state.show = state.show === t.dataset.show ? 'all' : t.dataset.show; if (t.dataset.show === 'all') state.family = 'all'; render(); }
    else if (t.hasAttribute('data-close')) t.closest('dialog').close();
    else if (t.dataset.edit) openForm('edit', t.dataset.edit);
    else if (t.dataset.step) {
      const input = $('#ydInput');
      const cur = toYards(input.value);
      input.value = Math.max(0, round2((cur === '' ? 0 : cur) + Number(t.dataset.step)));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  // Tapping the dark area around a dialog closes it.
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

  el.addBtn.addEventListener('click', () => openForm('add'));
  el.fab.addEventListener('click', () => openForm('add'));
  el.search.addEventListener('input', () => { state.q = el.search.value.trim().toLowerCase(); renderLibrary(); });

  // The Vault's own "Are you sure?" box (some browsers block the built-in one).
  function ask(message, okLabel, danger) {
    const d = $('#confirmDlg'), ok = $('#confirmOk');
    $('#confirmText').textContent = message;
    ok.textContent = okLabel;
    ok.className = 'btn big ' + (danger ? 'danger' : 'primary');
    d.returnValue = '';
    d.showModal();
    return new Promise(resolve => d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true }));
  }

  let toastTimer;
  function toast(msg, bad) {
    el.toast.textContent = msg;
    el.toast.classList.toggle('bad', !!bad);
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), bad ? 6000 : 3200);
  }

  // ---------- Start ----------

  async function refresh() {
    try {
      const list = await backend.list();
      state.fabrics = list.map(normalize).filter(f => f.id);
      afterChange();
    } catch (e) {
      if (!state.fabrics.length) el.library.innerHTML = '<div class="empty">The Vault couldn’t load. Check your connection and reload the page.</div>';
      else toast('Couldn’t reach the Vault. Showing the last copy saved on this device.', true);
    }
  }

  const savedPass = store.get('fv-pass');
  if (savedPass) { state.edit = true; state.pass = savedPass; }
  state.fabrics = DEMO ? [] : (store.get('fv-cache') || []).map(normalize);
  if (!state.fabrics.length) el.library.innerHTML = '<div class="empty">Opening the Vault… The first visit of the day can take up to 15 seconds.</div>';
  else render();
  renderHeader();
  refresh();
})();
