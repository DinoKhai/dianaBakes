/**
 * Diana Di Dolci — Core Data Layer
 * Local-first architecture: localStorage + optional IndexedDB
 * Layers: Storage → Repository → QueryEngine → ExportService
 */

'use strict';

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
const Utils = {
  uuid() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
  },
  orderNumber() {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const r = Math.floor(Math.random()*900)+100;
    return `BB-${ymd}-${r}`;
  },
  now() { return new Date().toISOString(); },
  deepClone(o) { return JSON.parse(JSON.stringify(o)); },
  formatPrice(n, cur='₹') {
    return `${cur}${Number(n).toLocaleString('en-IN')}`;
  },
  formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-IN', {
      day:'2-digit', month:'short', year:'numeric',
      hour:'2-digit', minute:'2-digit', hour12:true
    });
  },
  formatDateShort(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
  }
};

// ─────────────────────────────────────────────
// SCHEMA VERSION & MIGRATIONS
// ─────────────────────────────────────────────
const SCHEMA_VERSION = 1;

const Migrations = {
  // handlers keyed by target version
  1: data => data, // v0 → v1: initial release, no transform needed
  migrate(data, from = 0) {
    let v = from;
    while (v < SCHEMA_VERSION) {
      v++;
      if (typeof this[v] === 'function') data = this[v](data);
    }
    return data;
  }
};

// ─────────────────────────────────────────────
// STORAGE ADAPTER  (localStorage, versioned keys)
// ─────────────────────────────────────────────
class StorageAdapter {
  constructor(ns = 'butterbliss') {
    this.ns = ns;
    this.k = {
      products:  `${ns}_products_v1`,
      orders:    `${ns}_orders_v1`,
      settings:  `${ns}_settings_v2`,
      lookups:   `${ns}_lookups_v1`,
      meta:      `${ns}_meta_v1`,
      cart:      `${ns}_cart_v1`,
      snapshots: `${ns}_snapshots_v1`,
    };
  }

  // ── safe read/write ──────────────────────────
  _r(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch(e) { console.warn('[BB:Storage] Corrupt data for', key); return null; }
  }
  _w(key, data) {
    try { localStorage.setItem(key, JSON.stringify(data)); return true; }
    catch(e) {
      if (e.name === 'QuotaExceededError') { this._pruneSnapshots(); }
      try { localStorage.setItem(key, JSON.stringify(data)); return true; }
      catch { return false; }
    }
  }
  _pruneSnapshots() {
    const snaps = this._r(this.k.snapshots) || [];
    this._w(this.k.snapshots, snaps.slice(-3));
  }

  // ── entity CRUD ──────────────────────────────
  getAll(entity) { return Array.isArray(this._r(this.k[entity])) ? this._r(this.k[entity]) : []; }
  getById(entity, id) { return this.getAll(entity).find(r => r.id === id) || null; }

  save(entity, record) {
    const list = this.getAll(entity);
    const i = list.findIndex(r => r.id === record.id);
    const ts = Utils.now();
    if (i >= 0) list[i] = { ...list[i], ...record, updatedAt: ts };
    else list.push({ ...record, createdAt: record.createdAt || ts, updatedAt: ts });
    this._w(this.k[entity], list);
    this._touchMeta();
    return i >= 0 ? list[i] : list[list.length - 1];
  }

  delete(entity, id) {
    this._w(this.k[entity], this.getAll(entity).filter(r => r.id !== id));
    this._touchMeta();
  }

  saveAll(entity, records) { this._w(this.k[entity], records); this._touchMeta(); }

  // ── settings ────────────────────────────────
  getSettings() { return { ...DEFAULT_SETTINGS, ...(this._r(this.k.settings) || {}) }; }
  saveSettings(s) { this._w(this.k.settings, { ...this.getSettings(), ...s }); }

  // ── meta ────────────────────────────────────
  getMeta() { return this._r(this.k.meta) || { schemaVersion: SCHEMA_VERSION, createdAt: Utils.now() }; }
  _touchMeta() {
    const m = this.getMeta();
    this._w(this.k.meta, { ...m, schemaVersion: SCHEMA_VERSION, lastModifiedAt: Utils.now() });
  }

  // ── cart ────────────────────────────────────
  getCart() { return this._r(this.k.cart) || []; }
  saveCart(c) { this._w(this.k.cart, c); }
  clearCart() { this._w(this.k.cart, []); }

  // ── lookups ─────────────────────────────────
  getLookups() { return this._r(this.k.lookups) || DEFAULT_LOOKUPS; }

  // ── snapshots (version history) ─────────────
  saveSnapshot(label = 'auto') {
    const snaps = this._r(this.k.snapshots) || [];
    snaps.push({ id: Utils.uuid(), label, createdAt: Utils.now(), data: this.exportAll() });
    this._w(this.k.snapshots, snaps.slice(-10));
  }
  getSnapshots() { return (this._r(this.k.snapshots) || []).slice().reverse(); }
  restoreSnapshot(id) {
    const s = (this._r(this.k.snapshots) || []).find(s => s.id === id);
    if (!s) return false;
    this.importAll(s.data); return true;
  }

  // ── full export / import ────────────────────
  exportAll() {
    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: Utils.now(),
      bakery: this.getSettings().bakeryName,
      data: {
        products: this.getAll('products'),
        orders:   this.getAll('orders'),
        settings: this.getSettings(),
        lookups:  this.getLookups(),
        meta:     this.getMeta()
      }
    };
  }
  importAll(payload) {
    if (!payload?.data) throw new Error('Invalid export payload — missing "data" key');
    const d = Migrations.migrate(Utils.deepClone(payload.data), payload.schemaVersion || 0);
    if (d.products) this._w(this.k.products, d.products);
    if (d.orders)   this._w(this.k.orders,   d.orders);
    if (d.settings) this._w(this.k.settings, d.settings);
    if (d.lookups)  this._w(this.k.lookups,  d.lookups);
    this._touchMeta();
  }
  clearAll() { Object.values(this.k).forEach(k => localStorage.removeItem(k)); }
}

// ─────────────────────────────────────────────
// QUERY ENGINE  (domain-agnostic primitives)
// ─────────────────────────────────────────────
const QueryEngine = {
  filter(records, filters = {}) {
    return records.filter(r => Object.entries(filters).every(([k, v]) => {
      if (v === null || v === undefined || v === '') return true;
      if (k === '$dateFrom') return new Date(r.createdAt) >= new Date(v);
      if (k === '$dateTo')   { const t = new Date(v); t.setDate(t.getDate()+1); return new Date(r.createdAt) <= t; }
      if (k === '$tags' && Array.isArray(v) && v.length) return v.some(t => (r.tags||[]).includes(t));
      if (Array.isArray(v) && v.length)  return v.includes(r[k]);
      if (typeof v === 'boolean') return r[k] === v;
      return r[k] === v;
    }));
  },

  search(records, text, fields = []) {
    if (!text?.trim()) return records;
    const q = text.toLowerCase().trim();
    return records.filter(r => fields.some(f => r[f] && String(r[f]).toLowerCase().includes(q)));
  },

  sort(records, field = 'createdAt', dir = 'desc') {
    return [...records].sort((a, b) => {
      let va = a[field], vb = b[field];
      if (typeof va === 'string') { va = va.toLowerCase(); vb = String(vb).toLowerCase(); }
      return va < vb ? (dir === 'asc' ? -1 : 1) : va > vb ? (dir === 'asc' ? 1 : -1) : 0;
    });
  },

  paginate(records, page = 1, size = 20) {
    const total = records.length;
    const totalPages = Math.ceil(total / size) || 1;
    const pg = Math.min(Math.max(1, page), totalPages);
    return {
      records: records.slice((pg-1)*size, pg*size),
      total, page: pg, pageSize: size, totalPages,
      hasNext: pg < totalPages, hasPrev: pg > 1
    };
  },

  aggregate(records, groupBy, valueField = null) {
    const groups = {};
    records.forEach(r => {
      const key = r[groupBy] ?? 'Unknown';
      groups[key] = groups[key] || [];
      groups[key].push(r);
    });
    return Object.entries(groups).map(([group, items]) => ({
      group,
      count: items.length,
      sum:   valueField ? items.reduce((s, r) => s + (Number(r[valueField])||0), 0) : null,
      avg:   valueField ? items.reduce((s, r) => s + (Number(r[valueField])||0), 0) / items.length : null,
    })).sort((a,b) => b.count - a.count);
  },

  query(records, { filters, search, searchFields, sort: s, page, pageSize } = {}) {
    let res = records;
    if (filters)              res = this.filter(res, filters);
    if (search && searchFields) res = this.search(res, search, searchFields);
    if (s)                    res = this.sort(res, s.field, s.dir);
    if (page)                 return this.paginate(res, page, pageSize);
    return res;
  }
};

// ─────────────────────────────────────────────
// REPOSITORY BASE CLASS
// ─────────────────────────────────────────────
class Repository {
  constructor(storage, entity) { this.storage = storage; this.entity = entity; }
  getAll()    { return this.storage.getAll(this.entity); }
  getById(id) { return this.storage.getById(this.entity, id); }
  create(data) {
    const rec = { id: Utils.uuid(), ...data, createdAt: Utils.now(), updatedAt: Utils.now() };
    return this.storage.save(this.entity, rec);
  }
  update(id, data) {
    const ex = this.getById(id);
    if (!ex) throw new Error(`[Repo] ${this.entity}:${id} not found`);
    return this.storage.save(this.entity, { ...ex, ...data, id, updatedAt: Utils.now() });
  }
  delete(id) { this.storage.delete(this.entity, id); }
  query(opts) { return QueryEngine.query(this.getAll(), opts); }
  count()     { return this.getAll().length; }
}

// ─────────────────────────────────────────────
// EXPORT SERVICE  (SheetJS-powered XLSX + JSON)
// ─────────────────────────────────────────────
const ExportService = {
  _download(blob, filename) {
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: filename }).click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  // ── Full JSON backup (for restore) ──────────
  toJSON(data, filename = 'export.json') {
    this._download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), filename);
  },

  // ── Multi-sheet XLSX  ────────────────────────
  // sheetsData: Array of { name: string, rows: object[], colWidths?: number[] }
  toXLSX(sheetsData, filename = 'export.xlsx') {
    if (!window.XLSX) { Toast.error('Excel library is still loading — please try again in a moment.'); return; }
    const wb = XLSX.utils.book_new();
    sheetsData.forEach(({ name, rows, colWidths }) => {
      if (!rows.length) { rows = [{}]; } // keep sheet even if empty
      const ws = XLSX.utils.json_to_sheet(rows);
      // Auto column widths
      if (!colWidths) {
        const headers = Object.keys(rows[0] || {});
        colWidths = headers.map(h => {
          const max = Math.max(h.length, ...rows.map(r => String(r[h] ?? '').length));
          return Math.min(Math.max(max + 2, 10), 60);
        });
      }
      ws['!cols'] = colWidths.map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31)); // Excel sheet name limit
    });
    XLSX.writeFile(wb, filename);
  },

  // ── Read .xlsx or .json ──────────────────────
  // Returns: { type: 'json-backup'|'xlsx', sheets?: { [name]: rows[] }, data?: object }
  async fromFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'json') {
      const text = await file.text();
      return { type: 'json-backup', data: JSON.parse(text) };
    }

    if (ext === 'xlsx' || ext === 'xls') {
      if (!window.XLSX) throw new Error('Excel library not loaded — please refresh and try again.');
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
      const sheets = {};
      wb.SheetNames.forEach(name => {
        sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
      });
      return { type: 'xlsx', sheets, sheetNames: wb.SheetNames };
    }

    throw new Error('Unsupported file type — please use .xlsx or .json');
  }
};

// ─────────────────────────────────────────────
// DEFAULT DATA SEEDS
// ─────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  bakeryName: 'Diana Di Dolci',
  tagline: 'Crafted with love, baked for you',
  currency: '₹',
  deliveryFee: 50,
  freeDeliveryAbove: 500,
  minOrderAmount: 200,
  phone: '+91 70193 71199',
  email: 'hello@dianadidolci.com',
  instagram: '@dianadidolci',
  whatsapp: '+917019371199',
  address: 'Lamka',
  theme: 'light',
  compactMode: false,
  acceptingOrders: true,
  estimatedDeliveryMins: 45,
};

const DEFAULT_LOOKUPS = {
  categories: [
    { id:'cheesecake', label:'Cheesecakes', icon:'🍰', tagline:'Rich, creamy & dreamy',    gradient:'linear-gradient(135deg,#ffe0e9,#ffb3c6)' },
    { id:'brownie',    label:'Brownies',    icon:'🍫', tagline:'Fudgy, gooey & divine',    gradient:'linear-gradient(135deg,#6b3c1a,#3d1a06)' },
    { id:'cake',       label:'Cakes',       icon:'🎂', tagline:'For every celebration',    gradient:'linear-gradient(135deg,#ffd6e0,#ffadc5)' },
    { id:'pasta',      label:'Pasta',       icon:'🍝', tagline:'Comfort in every bite',    gradient:'linear-gradient(135deg,#fff3cd,#ffd580)' },
    { id:'cookie',     label:'Cookies',     icon:'🍪', tagline:'Crispy, chewy & yummy',    gradient:'linear-gradient(135deg,#f5deb3,#deb887)' },
    { id:'cupcake',    label:'Cupcakes',    icon:'🧁', tagline:'Little bites of joy',      gradient:'linear-gradient(135deg,#f9c6d3,#f48fb1)' },
  ],
  orderStatuses: [
    { id:'pending',           label:'Pending',          color:'#f59e0b', bg:'#fef3c7' },
    { id:'confirmed',         label:'Confirmed',        color:'#3b82f6', bg:'#dbeafe' },
    { id:'preparing',         label:'Preparing',        color:'#8b5cf6', bg:'#ede9fe' },
    { id:'out_for_delivery',  label:'Out for Delivery', color:'#f97316', bg:'#ffedd5' },
    { id:'delivered',         label:'Delivered',        color:'#22c55e', bg:'#dcfce7' },
    { id:'cancelled',         label:'Cancelled',        color:'#ef4444', bg:'#fee2e2' },
  ],
  paymentMethods: [
    { id:'cod',  label:'Cash on Delivery' },
    { id:'upi',  label:'UPI / QR Code' },
    { id:'card', label:'Debit / Credit Card' },
  ]
};

const DEFAULT_PRODUCTS = [
  { id:'p1',  name:'Blueberry Cheesecake',    category:'cheesecake', price:650,  description:'Rich, creamy & dreamy blueberry cheesecake with buttery graham cracker crust.',  tags:['bestseller','featured'], available:true,  image:null },
  { id:'p2',  name:'Chocolate Fudge Brownie', category:'brownie',    price:450,  description:'Fudgy, gooey & divine chocolate brownies baked to perfection.',                   tags:['bestseller','featured'], available:true,  image:null },
  { id:'p3',  name:'Chocolate Truffle Cake',  category:'cake',       price:850,  description:'Decadent chocolate truffle cake — perfect for every celebration.',                tags:['bestseller','featured'], available:true,  image:null },
  { id:'p4',  name:'Creamy Alfredo Pasta',    category:'pasta',      price:550,  description:'Comfort in every bite — creamy homemade Alfredo pasta with herbs.',              tags:['bestseller','featured'], available:true,  image:null },
  { id:'p5',  name:'Classic Cheesecake',      category:'cheesecake', price:599,  description:'Classic New York–style cheesecake with vanilla bean.',                           tags:['popular'],               available:true,  image:null },
  { id:'p6',  name:'Red Velvet Cake',         category:'cake',       price:799,  description:'Velvety red cake with silky cream cheese frosting.',                             tags:['popular'],               available:true,  image:null },
  { id:'p7',  name:'Strawberry Shortcake',    category:'cake',       price:749,  description:'Light sponge layered with fresh strawberries and whipped cream.',                tags:[],                        available:true,  image:null },
  { id:'p8',  name:'Choco Chip Cookies (6)',  category:'cookie',     price:299,  description:'Crispy outside, chewy inside — classic chocolate chip cookies.',                 tags:['popular'],               available:true,  image:null },
  { id:'p9',  name:'Vanilla Cupcakes (4)',    category:'cupcake',    price:349,  description:'Little bites of joy — vanilla cupcakes with buttercream frosting.',              tags:['popular'],               available:true,  image:null },
  { id:'p10', name:'Pesto Pasta',             category:'pasta',      price:499,  description:'Freshly made pesto pasta with basil, garlic and pine nuts.',                    tags:[],                        available:true,  image:null },
  { id:'p11', name:'Brownie Box (12 pcs)',    category:'brownie',    price:799,  description:'Assorted brownie box — perfect for gifting.',                                    tags:['popular'],               available:true,  image:null },
  { id:'p12', name:'Custom Celebration Cake', category:'cake',       price:1200, description:'Handcrafted custom cake for birthdays, anniversaries & special events.',         tags:['custom'],                available:true,  image:null },
  { id:'p13', name:'Mango Cheesecake',        category:'cheesecake', price:699,  description:'Tropical mango cheesecake — seasonal favourite.',                               tags:[],                        available:true,  image:null },
  { id:'p14', name:'Oreo Cheesecake',         category:'cheesecake', price:649,  description:'Cookies-and-cream cheesecake with an Oreo crumb base.',                         tags:['popular'],               available:true,  image:null },
  { id:'p15', name:'Macarons (Box of 6)',     category:'cupcake',    price:449,  description:'Delicate French macarons in assorted flavours.',                                tags:[],                        available:true,  image:null },
];

// ─────────────────────────────────────────────
// SEED INITIALIZER  (runs once per fresh session)
// ─────────────────────────────────────────────
function seedIfEmpty(storage) {
  const meta = storage.getMeta();
  if (meta.initialized) return;
  if (!storage.getAll('products').length) {
    storage.saveAll('products', DEFAULT_PRODUCTS.map(p => ({
      ...p, createdAt: Utils.now(), updatedAt: Utils.now()
    })));
  }
  if (!storage._r(storage.k.lookups)) storage._w(storage.k.lookups, DEFAULT_LOOKUPS);
  if (!storage._r(storage.k.settings)) storage._w(storage.k.settings, DEFAULT_SETTINGS);
  storage._w(storage.k.meta, { ...meta, schemaVersion: SCHEMA_VERSION, initialized: true, createdAt: Utils.now() });
}

// ─────────────────────────────────────────────
// PRODUCT & CATEGORY IMAGES  (Unsplash CDN)
// Used at render time — works for both seeded & user-added products
// ─────────────────────────────────────────────
const PRODUCT_IMAGES = {
  p1:  'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=480&h=320&fit=crop&auto=format', // blueberry cheesecake
  p2:  'https://images.unsplash.com/photo-1515037893149-de7f840978e2?w=480&h=320&fit=crop&auto=format', // fudge brownies
  p3:  'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=480&h=320&fit=crop&auto=format', // chocolate truffle cake
  p4:  'https://images.unsplash.com/photo-1621996346565-e3dbc646d9a9?w=480&h=320&fit=crop&auto=format', // creamy pasta
  p5:  'https://images.unsplash.com/photo-1488477181946-6428a0291777?w=480&h=320&fit=crop&auto=format', // classic cheesecake
  p6:  'https://images.unsplash.com/photo-1616541823729-00fe0aacd32c?w=480&h=320&fit=crop&auto=format', // red velvet cake
  p7:  'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=480&h=320&fit=crop&auto=format', // strawberry cake
  p8:  'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=480&h=320&fit=crop&auto=format', // chocolate chip cookies
  p9:  'https://images.unsplash.com/photo-1614707267537-b85aaf00c4b7?w=480&h=320&fit=crop&auto=format', // vanilla cupcakes
  p10: 'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?w=480&h=320&fit=crop&auto=format', // pesto pasta
  p11: 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=480&h=320&fit=crop&auto=format', // brownie box
  p12: 'https://images.unsplash.com/photo-1464349153735-7db50ed83c84?w=480&h=320&fit=crop&auto=format', // celebration cake
  p13: 'https://images.unsplash.com/photo-1560180474-e8563fd75bab?w=480&h=320&fit=crop&auto=format', // mango cheesecake
  p14: 'https://images.unsplash.com/photo-1586985289688-ca3cf47d3e6e?w=480&h=320&fit=crop&auto=format', // oreo cheesecake
  p15: 'https://images.unsplash.com/photo-1558326567-98ae2405596b?w=480&h=320&fit=crop&auto=format', // macarons
};

// Fallback images per category — used when a product has no specific photo
const CATEGORY_IMAGES = {
  cheesecake: 'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=480&h=320&fit=crop&auto=format',
  brownie:    'https://images.unsplash.com/photo-1515037893149-de7f840978e2?w=480&h=320&fit=crop&auto=format',
  cake:       'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=480&h=320&fit=crop&auto=format',
  pasta:      'https://images.unsplash.com/photo-1621996346565-e3dbc646d9a9?w=480&h=320&fit=crop&auto=format',
  cookie:     'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=480&h=320&fit=crop&auto=format',
  cupcake:    'https://images.unsplash.com/photo-1614707267537-b85aaf00c4b7?w=480&h=320&fit=crop&auto=format',
};

// Category circle images (smaller crop for category cards)
const CATEGORY_CIRCLE_IMAGES = {
  cheesecake: 'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=200&h=200&fit=crop&auto=format',
  brownie:    'https://images.unsplash.com/photo-1515037893149-de7f840978e2?w=200&h=200&fit=crop&auto=format',
  cake:       'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=200&h=200&fit=crop&auto=format',
  pasta:      'https://images.unsplash.com/photo-1621996346565-e3dbc646d9a9?w=200&h=200&fit=crop&auto=format',
  cookie:     'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=200&h=200&fit=crop&auto=format',
  cupcake:    'https://images.unsplash.com/photo-1614707267537-b85aaf00c4b7?w=200&h=200&fit=crop&auto=format',
};

function getProductImage(product) {
  return PRODUCT_IMAGES[product.id]
    || (product.image && product.image)
    || CATEGORY_IMAGES[product.category]
    || null;
}

// ─────────────────────────────────────────────
// THEME MANAGER
// ─────────────────────────────────────────────
const ThemeManager = {
  KEY: 'butterbliss_theme',
  init() {
    const saved = localStorage.getItem(this.KEY) || 'light';
    this.apply(saved);
    document.getElementById('themeToggle')?.addEventListener('click', () => this.toggle());
  },
  apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(this.KEY, theme);
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  },
  toggle() { this.apply(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }
};

// ─────────────────────────────────────────────
// TOAST NOTIFICATIONS
// ─────────────────────────────────────────────
const Toast = {
  show(msg, type = 'success', duration = 3000) {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = Object.assign(document.createElement('div'), { id:'toastContainer' });
      container.style.cssText = 'position:fixed;top:1rem;right:1rem;z-index:9999;display:flex;flex-direction:column;gap:.5rem';
      document.body.appendChild(container);
    }
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.innerHTML = `<span>${msg}</span><button onclick="this.parentElement.remove()">✕</button>`;
    container.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, duration);
  },
  success(m, d) { this.show(m,'success',d); },
  error(m, d)   { this.show(m,'error',d); },
  info(m, d)    { this.show(m,'info',d); }
};

// ─────────────────────────────────────────────
// CART SERVICE
// ─────────────────────────────────────────────
class CartService {
  constructor(storage) { this.storage = storage; }
  getItems() { return this.storage.getCart(); }
  add(product, qty = 1, notes = '') {
    const items = this.getItems();
    const i = items.findIndex(x => x.productId === product.id);
    if (i >= 0) items[i].qty += qty;
    else items.push({ productId: product.id, name: product.name, price: product.price, category: product.category, qty, notes });
    this.storage.saveCart(items);
    this._updateBadge();
    return items;
  }
  remove(productId) {
    this.storage.saveCart(this.getItems().filter(x => x.productId !== productId));
    this._updateBadge();
  }
  updateQty(productId, qty) {
    if (qty <= 0) { this.remove(productId); return; }
    const items = this.getItems().map(x => x.productId === productId ? { ...x, qty } : x);
    this.storage.saveCart(items);
    this._updateBadge();
  }
  updateNotes(productId, notes) {
    const items = this.getItems().map(x => x.productId === productId ? { ...x, notes } : x);
    this.storage.saveCart(items);
  }
  getSubtotal() { return this.getItems().reduce((s,x) => s + x.price*x.qty, 0); }
  getCount()    { return this.getItems().reduce((s,x) => s + x.qty, 0); }
  clear()       { this.storage.clearCart(); this._updateBadge(); }
  _updateBadge() {
    const n = this.getCount();
    document.querySelectorAll('.cart-badge').forEach(b => {
      b.textContent = n;
      b.style.display = n > 0 ? 'flex' : 'none';
    });
  }
}

// ─────────────────────────────────────────────
// ORDER SERVICE
// ─────────────────────────────────────────────
class OrderService {
  constructor(orderRepo, settings) {
    this.repo     = orderRepo;
    this.settings = settings;
  }
  place(cartItems, customer, payment = 'cod', notes = '') {
    if (!cartItems.length) throw new Error('Cart is empty');
    const s = this.settings;
    const subtotal    = cartItems.reduce((sum, i) => sum + i.price * i.qty, 0);
    const deliveryFee = subtotal >= s.freeDeliveryAbove ? 0 : s.deliveryFee;
    const total       = subtotal + deliveryFee;
    return this.repo.create({
      orderNumber: Utils.orderNumber(),
      customer,
      items: cartItems,
      subtotal, deliveryFee, total,
      status:  'pending',
      payment,
      notes,
    });
  }
  updateStatus(id, status) { return this.repo.update(id, { status }); }
  getDashboardStats() {
    const orders = this.repo.getAll();
    const revenue = orders.filter(o => o.status !== 'cancelled').reduce((s,o) => s + o.total, 0);
    const today   = new Date().toISOString().slice(0,10);
    const todayOrders = orders.filter(o => o.createdAt?.slice(0,10) === today);
    const byStatus = QueryEngine.aggregate(orders, 'status');
    const byCategory = QueryEngine.aggregate(
      orders.flatMap(o => o.items.map(i => ({ category: i.category, revenue: i.price * i.qty }))),
      'category', 'revenue'
    );
    return { total: orders.length, revenue, todayCount: todayOrders.length, todayRevenue: todayOrders.reduce((s,o)=>s+o.total,0), byStatus, byCategory };
  }
}

// ─────────────────────────────────────────────
// GLOBAL APP SINGLETON
// ─────────────────────────────────────────────
window.BB = (() => {
  const storage = new StorageAdapter('butterbliss');
  seedIfEmpty(storage);
  const settings = storage.getSettings();

  const repos = {
    products: new Repository(storage, 'products'),
    orders:   new Repository(storage, 'orders'),
  };

  const services = {
    cart:   new CartService(storage),
    orders: new OrderService(repos.orders, settings),
  };

  function init() {
    ThemeManager.init();
    services.cart._updateBadge();
    console.log('[BB] Bakery app ready ✓');
  }

  return { storage, repos, services, utils: Utils, query: QueryEngine, export: ExportService, toast: Toast, theme: ThemeManager, init, lookups: storage.getLookups(), images: { product: PRODUCT_IMAGES, category: CATEGORY_IMAGES, categoryCircle: CATEGORY_CIRCLE_IMAGES, getProductImage } };
})();
