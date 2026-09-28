(() => {
  'use strict';

  // 每帧缓存的全局量（性能优化：热路径不再反复全量遍历建筑）
  let _pinfo = { cap: 14, use: 0, ok: true };
  let _income = { rate: 0 };
  let _rngMul = 1;        // 雷达射程加成，每帧刷新一次
  let _crit = 0;          // 暴击率，每帧刷新一次
  let _mx = 0;            // 床位上限，每帧刷新一次
  let _ampDirty = true;   // 增幅光环脏标记
  let _roomCanvas = null; // 静态房间离屏缓存
  let DOCK_CAT = 'all';   // 建造栏当前分类
  let coached = false;    // 本局是否已看过新手引导

  // ================= 语言 =================
  let LANG = 'zh';
  try {
    LANG = localStorage.getItem('tp_lang') ||
      (/^zh/i.test(navigator.language || '') ? 'zh' : 'en');
  } catch (_) { /* 隐私模式下不用存档 */ }
  const T = () => (window.I18N && window.I18N[LANG]) ? window.I18N[LANG] : window.I18N.zh;
  const fill = (s, kv) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in kv ? kv[k] : m));

  function pick(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function applyLang() {
    document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
    document.querySelectorAll('[data-i18n]').forEach(n => {
      const v = pick(T(), n.dataset.i18n);
      if (v === undefined) return;
      if (n.hasAttribute('data-i18n-html')) n.innerHTML = v; else n.textContent = v;
    });
    document.querySelectorAll('.langbtn').forEach(b => { b.textContent = LANG === 'zh' ? 'EN 🌐' : '中文 🌐'; });
    buildDock(); buildTabs();
    setPlacing(S.placing);
    const bp = document.getElementById('btnPause');
    if (bp) bp.textContent = S.paused ? T().ui.resume : T().ui.pause;
    syncUI();
  }
  function setLang(l) {
    if (!window.I18N[l] || l === LANG) return;
    LANG = l;
    try { localStorage.setItem('tp_lang', l); } catch (_) { }
    applyLang();
  }

  // ================= 地图：一整个大房间 =================
  const TILE = 48, COLS = 18, ROWS = 11;
  const W = COLS * TILE, H = ROWS * TILE;
  const MAX_WAVE = 15;

  // ================= 王（每 KING_EVERY 关一个，不移动，会不停产小鬼）=================
  const KING_EVERY = 5;          // 每 5 关出现一个王
  const KING_HP_PER_WAVE = 100;  // 王血量 = 当前关卡数 × 100
  const KING_SPAWN_CD = 5;       // 每 5 秒产一波小鬼
  const KING_SPAWN_MUL = 2;      // 每次产 关卡数 × 2 只
  const MAX_GHOSTS = 240;        // 同屏上限（性能保护）

  const FLOOR = 0, FURN = 1, BEDT = 2, DOORT = 3;
  const BED = [{ c: 0, r: ROWS - 3 }, { c: 0, r: ROWS - 2 }];   // 左下角床位
  const DOORS = [{ c: COLS - 1, r: 1 }, { c: COLS - 1, r: 5 }, { c: COLS - 1, r: 9 }]; // 右侧三扇房门

  // 房间里的家具（不可通行、不可建造）
  const FURNITURE = [
    { c: 4, r: 2, k: 'sofa' }, { c: 5, r: 2, k: 'tv' },
    { c: 9, r: 3, k: 'plant' }, { c: 12, r: 1, k: 'bear' },
    { c: 7, r: 7, k: 'chair' }, { c: 8, r: 7, k: 'plate' },
    { c: 13, r: 8, k: 'shower' }, { c: 3, r: 9, k: 'books' },
    { c: 15, r: 4, k: 'fridge' }, { c: 10, r: 9, k: 'cart' }
  ];

  const grid = [];
  for (let r = 0; r < ROWS; r++) { grid[r] = new Array(COLS).fill(FLOOR); }
  FURNITURE.forEach(f => { grid[f.r][f.c] = FURN; });
  BED.forEach(p => { grid[p.r][p.c] = BEDT; });
  DOORS.forEach(p => { grid[p.r][p.c] = DOORT; });

  // 分类配色（明快、强区分，参考 Bloons TD / KR 的“一眼认得类”思路）
  const CAT_COLOR = { atk: '#e2553f', def: '#5b9bff', eco: '#37b97a', econ: '#37b97a', power: '#f2c14e', sup: '#a06bff' };
  // 炮台类枪管强调色
  const ACCENT = { turret: '#ffd9a0', sniper: '#ff9ad1', flame: '#ff9a3c', frost: '#9fe6ff', tesla: '#8ff' };

  // ================= 建筑配置（13 种） =================
  const D = n => n.toFixed(n < 10 ? 1 : 0);
  const CONF = {
    // —— 攻击类 ——
    turret: {
      ico: '💥', cat: 'atk', cost: [60, 80, 180], use: [3, 4, 6],
      dmg: [12, 26, 48], rate: [1.2, 1.5, 1.9], range: [3.8, 4.4, 5.2], be: 'bullet'
    },
    sniper: {
      ico: '🎯', cat: 'atk', cost: [120, 200, 380], use: [4, 6, 8],
      dmg: [55, 110, 210], rate: [0.5, 0.6, 0.75], range: [7.5, 9, 11], be: 'laser'
    },
    flame: {
      ico: '🔥', cat: 'atk', cost: [90, 160, 300], use: [5, 7, 9],
      dmg: [9, 18, 34], rate: [2.5, 3, 3.6], range: [2.4, 2.8, 3.2], be: 'cone'
    },
    frost: {
      ico: '🧊', cat: 'atk', cost: [80, 140, 260], use: [3, 5, 7],
      dmg: [7, 14, 26], rate: [1, 1.25, 1.5], range: [3.4, 3.9, 4.5], be: 'bullet', slow: [0.55, 0.45, 0.35]
    },
    tesla: {
      ico: '⚡', cat: 'atk', cost: [140, 240, 420], use: [6, 8, 11],
      dmg: [15, 30, 52], rate: [0.9, 1.1, 1.4], range: [3.2, 3.7, 4.3], be: 'chain', jumps: [2, 3, 4]
    },
    trap: {
      ico: '🪤', cat: 'atk', cost: [40, 70, 130], use: [1, 1, 2],
      dmg: [40, 80, 150], rate: [0.55, 0.7, 0.9], range: [1, 1.2, 1.5], be: 'trigger'
    },
    // —— 防御类 ——
    barrier: {
      ico: '🧱', cat: 'def', cost: [40, 60, 120], use: [0, 0, 0],
      hp: [400, 900, 1800], be: 'wall'
    },
    // —— 经济类 ——
    mine: {
      ico: '⛏️', cat: 'econ', cost: [50, 70, 150], use: [2, 3, 4],
      gain: [3, 6, 11], be: 'econ'
    },
    vault: {
      ico: '🏦', cat: 'econ', cost: [120, 220, 400], use: [2, 3, 4],
      boost: [0.15, 0.3, 0.5], be: 'econ'
    },
    gen: {
      ico: '🔋', cat: 'power', cost: [45, 90, 170], use: [0, 0, 0],
      supply: [10, 22, 36], be: 'econ'
    },
    // —— 辅助类 ——
    medic: {
      ico: '🩹', cat: 'sup', cost: [80, 140, 260], use: [3, 4, 6],
      heal: [8, 16, 30], every: 3, be: 'econ'
    },
    workshop: {
      ico: '🔧', cat: 'sup', cost: [90, 160, 300], use: [2, 3, 4],
      haste: [0.15, 0.25, 0.4], range: [3, 3.5, 4], be: 'econ'
    },
    shield: {
      ico: '🛡️', cat: 'sup', cost: [100, 180, 340], use: [4, 6, 8],
      add: [250, 500, 900], regen: [1, 2, 4], be: 'econ'
    },

    // —— 第二批：9 种 ——
    bomb: {                                   // 范围爆炸
      ico: '💣', cat: 'atk', cost: [110, 190, 340], use: [5, 7, 9],
      dmg: [45, 90, 170], rate: [0.35, 0.42, 0.5], range: [2.2, 2.6, 3.0], be: 'bomb'
    },
    poison: {                                 // 毒云持续伤害
      ico: '☠️', cat: 'atk', cost: [100, 170, 300], use: [4, 6, 8],
      dps: [12, 24, 44], dur: 3, range: [2.6, 3.0, 3.4], be: 'cloud'
    },
    beam: {                                   // 蓄能射线：灼烧越久伤害越高
      ico: '🔆', cat: 'atk', cost: [150, 260, 460], use: [6, 9, 12],
      dmg: [22, 44, 84], rate: [2, 2, 2], range: [4.2, 4.8, 5.6], be: 'beam', heat: 0.18
    },
    magnet: {                                 // 磁暴：击退 + 短暂眩晕
      ico: '🌀', cat: 'atk', cost: [95, 165, 290], use: [4, 6, 8],
      dmg: [6, 12, 22], rate: [0.5, 0.6, 0.7], range: [2.8, 3.2, 3.6], be: 'push', stun: 0.35
    },
    field: {                                  // 滞缓力场：范围内持续减速
      ico: '⏳', cat: 'atk', cost: [130, 220, 380], use: [5, 7, 10],
      slowMul: [0.55, 0.45, 0.35], range: [3.0, 3.4, 3.8], be: 'field'
    },
    drone: {                                  // 无人机：会飞的移动炮台
      ico: '🛸', cat: 'atk', cost: [160, 280, 500], use: [5, 7, 9],
      dmg: [14, 28, 52], rate: [1.4, 1.7, 2.0], range: [4.5, 5.2, 6.0], be: 'drone'
    },
    decoy: {                                  // 诱饵床：吸引猛鬼仇恨
      ico: '🎭', cat: 'def', cost: [70, 120, 220], use: [1, 1, 2],
      hp: [600, 1200, 2200], be: 'decoy'
    },
    bank: {                                   // 利息银行：按存款计息
      ico: '💹', cat: 'econ', cost: [140, 250, 450], use: [3, 4, 6],
      bank: [0.002, 0.0035, 0.005], be: 'econ'
    },
    transformer: {                            // 变压器：全局省电
      ico: '⚙️', cat: 'power', cost: [110, 200, 360], use: [0, 0, 0],
      save: [0.12, 0.2, 0.28], be: 'econ'
    },

    // —— 第三批：9 种 ——
    spikes: {                                 // 尖刺地板：踩着就一直掉血
      ico: '🔺', cat: 'atk', cost: [70, 130, 240], use: [3, 4, 6],
      dps: [18, 36, 66], range: [1.1, 1.3, 1.5], be: 'spike'
    },
    portal: {                                 // 传送门：把猛鬼送回门口
      ico: '🌀', cat: 'atk', cost: [180, 320, 560], use: [8, 11, 15],
      rate: [0.25, 0.3, 0.35], range: [2.5, 3.0, 3.5], count: [1, 1, 2], be: 'portal'
    },
    freezer: {                                // 急冻仓：定期冻结
      ico: '❄️', cat: 'atk', cost: [160, 280, 500], use: [6, 9, 12],
      freeze: [1.2, 1.6, 2.2], rate: [0.25, 0.3, 0.35], range: [2.8, 3.2, 3.6], be: 'freeze'
    },
    clock: {                                  // 时钟塔：全场慢放
      ico: '⏰', cat: 'atk', cost: [200, 350, 620], use: [7, 10, 14],
      slowmo: [0.5, 0.4, 0.3], dur: 4, every: 18, be: 'clock'
    },
    guard: {                                  // 保安：近战肉盾，会阵亡也会复活
      ico: '👮', cat: 'def', cost: [150, 270, 480], use: [4, 6, 8],
      hp: [500, 900, 1600], dmg: [18, 34, 60], rate: [1, 1.2, 1.5],
      range: [3.5, 4, 4.5], respawn: 8, be: 'guard'
    },
    amplifier: {                              // 增幅器：范围内伤害加成
      ico: '🔊', cat: 'sup', cost: [130, 230, 410], use: [4, 6, 8],
      amp: [0.25, 0.45, 0.7], range: [3, 3.5, 4], be: 'aura'
    },
    radar: {                                  // 雷达：全场射程加成
      ico: '📡', cat: 'sup', cost: [120, 210, 380], use: [3, 5, 7],
      rrange: [0.12, 0.2, 0.3], be: 'econ'
    },
    critcore: {                               // 暴击核心：全场暴击率
      ico: '🎲', cat: 'sup', cost: [150, 260, 470], use: [5, 7, 9],
      crit: [0.12, 0.2, 0.3], be: 'econ'
    },
    spotlight: {                              // 聚光灯：标记增伤
      ico: '🔦', cat: 'sup', cost: [110, 190, 340], use: [4, 6, 8],
      mark: [0.3, 0.5, 0.8], range: [3.4, 3.8, 4.2], be: 'mark'
    }
  };
  const MAXLV = 12;

  // 等级外推：lv1~3 用上表锚点，lv4~12 按各自成长曲线自动生成
  const GROWTH = {
    cost: 1.48, use: 1.15, dmg: 1.38, rate: 1.05, range: 1.045,
    slow: 0.88, jumps: 1.14, hp: 1.6, gain: 1.5, supply: 1.45,
    heal: 1.45, add: 1.45, regen: 1.4, boost: 1.2, haste: 1.15,
    dps: 1.38, bank: 1.18, save: 1.12, slowMul: 0.9,
    amp: 1.35, rrange: 1.25, crit: 1.25, slowmo: 0.9, freeze: 1.3, mark: 1.35, count: 1.2
  };
  const CLAMP = {
    boost: [0, 3], haste: [0, 1.5], jumps: [1, 8], slow: [0.12, 1],
    rate: [0, 10], range: [0, 16], use: [0, 80],
    bank: [0, 0.008], save: [0, 0.6], slowMul: [0.15, 1], dps: [0, 5000],
    amp: [0, 3], rrange: [0, 1], crit: [0, 0.6], slowmo: [0.2, 1], freeze: [0, 4], mark: [0, 3], count: [1, 5]
  };
  const INTKEYS = new Set(['cost', 'use', 'dmg', 'jumps', 'hp', 'gain', 'supply', 'heal', 'add', 'regen', 'dps', 'count']);
  function expand(arr, key) {
    const g = GROWTH[key] === undefined ? 1.5 : GROWTH[key];
    const out = arr.slice();
    while (out.length < MAXLV) {
      let v = out[out.length - 1] * g;
      const cl = CLAMP[key];
      if (cl) v = Math.min(cl[1], Math.max(cl[0], v));
      v = INTKEYS.has(key) ? Math.round(v) : Math.round(v * 100) / 100;
      out.push(v);
    }
    return out;
  }
  for (const k in CONF) {
    const cf = CONF[k];
    for (const key in cf) if (Array.isArray(cf[key])) cf[key] = expand(cf[key], key);
    // 名称随语言变化（getter），描述由文案模板生成
    Object.defineProperty(cf, 'name', { get: () => T().b[k] || k });
    cf.desc = b => descOf(k, b.level);
  }
  function valOf(type, key, level) {
    const arr = CONF[type][key];
    return arr ? arr[level - 1] : 0;
  }
  function descOf(type, level) {
    return fill(T().d[type] || '', new Proxy({}, {
      get: (_, key) => {
        if (typeof key !== 'string') return undefined;
        const pct = key.endsWith('Pct');
        const base = pct ? key.slice(0, -3) : key;
        const v = valOf(type, base, level);
        return pct ? Math.round(v * 1000) / 10 : (INTKEYS.has(base) ? Math.round(v) : D(v));
      },
      has: () => true
    }));
  }

  const ORDER = ['turret', 'mine', 'gen', 'frost', 'flame', 'tesla', 'sniper', 'trap', 'barrier', 'medic', 'workshop', 'vault', 'shield',
    'bomb', 'poison', 'beam', 'magnet', 'field', 'drone', 'decoy', 'bank', 'transformer',
    'spikes', 'portal', 'freezer', 'clock', 'guard', 'amplifier', 'radar', 'critcore', 'spotlight'];
  const BED_CONF = { maxLv: 5, cost: [0, 80, 200, 400, 800], gain: [3, 5, 8, 12, 18] };

  // ================= 状态 =================
  let S;
  function reset() {
    S = {
      gold: 300, wave: 0, waveTimer: 15, waveActive: false, spawnQueue: [], spawnTimer: 0,
      hpBase: 1500, hp: 1500, reinforce: 1, bedLevel: 1,
      buildings: [], ghosts: [], bullets: [], fx: [],
      time: 0, kills: 0, earned: 0,
      running: false, over: false, won: false, endless: false,
      speed: 1, paused: false, shake: 0,
      placing: null, selected: null, hover: null,
      slowMo: 0, slowMoVal: 1,
      occupied: new Map()
    };
    rebuildField();
    if (el && el.panel) { el.panel.classList.add('hidden'); el.hint.textContent = T().ui.idleHint; }
  }
  const ck = (c, r) => c + ',' + r;

  // ================= DOM =================
  const $ = id => document.getElementById(id);
  const canvas = $('game'), ctx = canvas.getContext('2d');
  // 渲染缩放 RS：跟随自适应，缓冲区随显示尺寸走 → 放大不发虚
  let RS = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * RS; canvas.height = H * RS;
  ctx.setTransform(RS, 0, 0, RS, 0, 0);
  // 自适应：画布铺满 stage（等比缩放），左右边缘与上方 HUD / 下方建造栏对齐
  const stageEl = $('stage');
  function fitCanvas() {
    const sw = stageEl.clientWidth || W, sh = stageEl.clientHeight || H;
    const k = Math.min(sw / W, sh / H);
    canvas.style.width = Math.floor(W * k) + 'px';    // 向下取整，杜绝 1px 溢出把底部挤出去
    canvas.style.height = Math.floor(H * k) + 'px';
    const rs = Math.min(Math.max((window.devicePixelRatio || 1) * k, 1), 3);
    if (Math.abs(rs - RS) > 0.02) {                   // 分辨率变化才重建缓冲区
      RS = rs;
      canvas.width = Math.round(W * RS); canvas.height = Math.round(H * RS);
      ctx.setTransform(RS, 0, 0, RS, 0, 0);
      _roomCanvas = null;                             // 静态房间按新尺寸重建
    }
  }
  fitCanvas();
  window.addEventListener('resize', fitCanvas);
  // stage 任意尺寸变化（建造栏换行 / 字体加载 / 缩放）都重新校准，避免底部被裁
  if (window.ResizeObserver) { try { new ResizeObserver(fitCanvas).observe(stageEl); } catch (e) { } }
  const el = {
    gold: $('gold'), income: $('income'), power: $('power'), powerTip: $('powerTip'),
    wave: $('wave'), waveTip: $('waveTip'), hp: $('hp'), hpMax: $('hpMax'), bar: $('bar'),
    kingStat: $('kingStat'), kingInfo: $('kingInfo'),
    panel: $('panel'), pIco: $('pIco'), pName: $('pName'), pLv: $('pLv'), pDesc: $('pDesc'),
    pUp: $('pUp'), pUpCost: $('pUpCost'), pSell: $('pSell'), pSellBack: $('pSellBack'),
    overlay: $('overlay'), result: $('result'), hint: $('hint'), dock: $('dock'),
    tabs: $('tabs'), tip: $('tip'),
    coach: $('coach'), coachBody: $('coachBody'), coachStep: $('coachStep'), coachNext: $('coachNext')
  };

  // 建造栏分类
  const CATEGORIES = [
    { key: 'all', zh: '全部', en: 'All' },
    { key: 'atk', zh: '攻击', en: 'Attack' },
    { key: 'def', zh: '防御', en: 'Defense' },
    { key: 'eco', zh: '经济', en: 'Economy' },
    { key: 'pwr', zh: '电力', en: 'Power' },
    { key: 'sup', zh: '辅助', en: 'Support' }
  ];
  const CAT_OF = {
    turret:'atk', sniper:'atk', flame:'atk', frost:'atk', tesla:'atk', trap:'atk', bomb:'atk',
    poison:'atk', beam:'atk', magnet:'atk', field:'atk', drone:'atk', spikes:'atk', portal:'atk',
    freezer:'atk', clock:'atk', guard:'def', barrier:'def', decoy:'def',
    mine:'eco', vault:'eco', bank:'eco',
    gen:'pwr', transformer:'pwr',
    medic:'sup', workshop:'sup', shield:'sup', amplifier:'sup', radar:'sup', critcore:'sup', spotlight:'sup'
  };
  // 生成建造栏（切换语言时会重建）
  const CARDS = ORDER.concat(['bed', 'fix']);
  function buildDock() {
    const builds = ORDER.filter(a => DOCK_CAT === 'all' || CAT_OF[a] === DOCK_CAT);
    const list = ['bed', 'fix'].concat(builds);
    el.dock.innerHTML = list.map((a, i) => {
      const t = a === 'bed' ? { name: T().ui.bedUp }
        : a === 'fix' ? { name: T().ui.fix } : CONF[a];
      return `<button class="card" data-act="${a}" title="${t.name}">` +
        `<span class="key">${i < 9 ? i + 1 : i === 9 ? 0 : '·'}</span>` +
        `<span class="ico"><canvas data-glyph="${a}" width="40" height="40"></canvas></span><span class="name">${t.name}</span>` +
        `<span class="cost">💰<b data-cost="${a}">0</b></span></button>`;
    }).join('');
    if (el.dock.querySelectorAll) el.dock.querySelectorAll('canvas[data-glyph]').forEach(cv => { try { paintIcon(cv, cv.dataset.glyph); } catch (e) {} });
  }
  function buildTabs() {
    el.tabs.innerHTML = CATEGORIES.map(c =>
      `<button class="tab${c.key === DOCK_CAT ? ' active' : ''}" data-cat="${c.key}">${LANG === 'zh' ? c.zh : c.en}</button>`
    ).join('');
  }
  buildDock(); buildTabs();

  // ================= 计算 =================
  const cx = c => c * TILE + TILE / 2, cy = r => r * TILE + TILE / 2;

  function maxHp() {
    let m = S.hpBase;
    S.buildings.forEach(b => { if (b.type === 'shield' && havePower()) m += CONF.shield.add[b.level - 1]; });
    return m;
  }
  function powerInfo() {
    let cap = 14, use = 0, save = 0;
    S.buildings.forEach(b => {
      const cf = CONF[b.type];
      if (cf.supply) cap += cf.supply[b.level - 1];
      if (cf.save) save += cf.save[b.level - 1];
      use += (cf.use ? cf.use[b.level - 1] : 0);
    });
    save = Math.min(0.6, save);                 // 省电上限 60%
    use = Math.round(use * (1 - save));
    return { cap, use, ok: use <= cap, save };
  }
  const havePower = () => _pinfo.ok;
  function incomeInfo() {
    let base = BED_CONF.gain[S.bedLevel - 1], mult = 1, interest = 0;
    S.buildings.forEach(b => {
      if (b.type === 'mine' && _pinfo.ok) base += CONF.mine.gain[b.level - 1];
      if (b.type === 'vault' && _pinfo.ok) mult += CONF.vault.boost[b.level - 1];
      if (b.type === 'bank' && _pinfo.ok) interest += S.gold * CONF.bank.bank[b.level - 1];
    });
    return { rate: base * mult + interest };
  }
  const isPowered = b => {        // 该建筑是否有电（停电时停机）
    const cf = CONF[b.type];
    return !(cf.use && cf.use[b.level - 1] > 0 && !_pinfo.ok);
  };
  const _ampMap = new Map();      // 建筑 -> 伤害倍率（增幅器光环，每帧刷新）
  function ampAt(b) {
    let m = 1;
    const x = cx(b.c), y = cy(b.r);
    for (const o of S.buildings) {
      if (o.type !== 'amplifier' || !isPowered(o)) continue;
      const R = CONF.amplifier.range[o.level - 1] * TILE;
      if ((x - cx(o.c)) ** 2 + (y - cy(o.r)) ** 2 <= R * R) m += CONF.amplifier.amp[o.level - 1];
    }
    return m;
  }
  function refreshAmp() {
    _ampMap.clear();
    for (const b of S.buildings) if (CONF[b.type].dmg || CONF[b.type].dps) _ampMap.set(b, ampAt(b));
  }
  const ampOf = b => _ampMap.get(b) || 1;
  function rangeMul() {           // 雷达：全场射程加成
    let m = 1;
    for (const b of S.buildings) if (b.type === 'radar' && isPowered(b)) m += CONF.radar.rrange[b.level - 1];
    return Math.min(2, m);
  }
  const rngOf = (b, cf) => cf.range[b.level - 1] * TILE * _rngMul;
  function critChance() {         // 暴击核心：全场暴击率
    let c = 0;
    for (const b of S.buildings) if (b.type === 'critcore' && isPowered(b)) c += CONF.critcore.crit[b.level - 1];
    return Math.min(0.75, c);
  }
  function recomputeGlobals() {    // 每帧刷新一次，热路径里只读缓存
    _pinfo = powerInfo();
    _income = incomeInfo();
    _rngMul = rangeMul();
    _crit = critChance();
    _mx = maxHp();
  }

  function hasteAt(b) {           // 维修间光环加成
    let h = 1;
    S.buildings.forEach(w => {
      if (w.type !== 'workshop' || !_pinfo.ok) return;
      const R = CONF.workshop.range[w.level - 1] * TILE;
      if ((cx(w.c) - cx(b.c)) ** 2 + (cy(w.r) - cy(b.r)) ** 2 <= R * R) h += CONF.workshop.haste[w.level - 1];
    });
    return h;
  }
  const bedCost = () => S.bedLevel < BED_CONF.maxLv ? BED_CONF.cost[S.bedLevel] : null;
  const fixCost = () => 30 + S.wave * 4;
  const reinforceCost = () => 150 * S.reinforce;

  // ================= 建造 =================
  function canBuild(c, r) { return !!(grid[r] && grid[r][c] === FLOOR && !S.occupied.has(ck(c, r))); }
  function totalSpent(b) { let s = 0; for (let i = 0; i < b.level; i++) s += CONF[b.type].cost[i]; return s; }
  function place(type, c, r) {
    if (!canBuild(c, r)) { toast(T().toast.noBuild, '#97a0cc'); return false; }
    const cost = CONF[type].cost[0];
    if (S.gold < cost) { toast(T().toast.noGold, '#ff5f6d'); return false; }
    S.gold -= cost;
    const b = { type, c, r, level: 1, cd: 0, angle: 0, target: null, spent: cost, pop: 1, tick: 0, flash: 0, hp: 0, heat: 0 };
    if (b.type === 'barrier' || b.type === 'decoy' || b.type === 'guard') { b.hp = CONF[b.type].hp[0]; b.maxHp = b.hp; }
    if (b.type === 'drone' || b.type === 'guard') { b.x = cx(c); b.y = cy(r); b.dead = false; b.respawnT = 0; }
    S.buildings.push(b); S.occupied.set(ck(c, r), b);
    rebuildField();
    for (let i = 0; i < 10; i++) puff(cx(c), cy(r), '#56e1ff');
    return true;
  }
  function upgradeBuilding(b) {
    const cf = CONF[b.type];
    if (b.level >= MAXLV) { toast(T().toast.maxed, '#ffcc4d'); return; }
    const cost = cf.cost[b.level];
    if (S.gold < cost) { toast(T().toast.noGold, '#ff5f6d'); return; }
    const prevAdd = b.type === 'shield' ? CONF.shield.add[b.level - 1] : 0;
    S.gold -= cost; b.level++; b.spent += cost; b.pop = 1;
    if (b.type === 'barrier' || b.type === 'decoy' || b.type === 'guard') {
      b.maxHp = CONF[b.type].hp[b.level - 1]; b.hp = b.maxHp;
    }
    if (b.type === 'shield') S.hp += CONF.shield.add[b.level - 1] - prevAdd;
    rebuildField();
    for (let i = 0; i < 14; i++) puff(cx(b.c), cy(b.r), '#ffcc4d');
    syncUI();
  }
  function sellBuilding(b) {
    const back = Math.floor(totalSpent(b) * 0.6);
    S.gold += back;
    S.buildings = S.buildings.filter(x => x !== b);
    S.occupied.delete(ck(b.c, b.r));
    if (S.selected === b) selectBuilding(null);
    rebuildField();
    for (let i = 0; i < 10; i++) puff(cx(b.c), cy(b.r), '#97a0cc');
    toast(fill(T().toast.recycle, { n: back }), '#4ade80');
  }
  function upgradeBed() {
    const cost = bedCost();
    if (cost === null) { toast(T().toast.bedMaxed, '#ffcc4d'); return; }
    if (S.gold < cost) { toast(T().toast.noGold, '#ff5f6d'); return; }
    S.gold -= cost; S.bedLevel++;
    for (let i = 0; i < 18; i++) puff(cx(1), cy(ROWS - 3), '#ffcc4d');
    toast(fill(T().toast.bedLv, { n: S.bedLevel }), '#ffcc4d');
  }
  function repairBed() {
    const mx = maxHp();
    if (S.hp >= mx) {
      const cost = reinforceCost();
      if (S.gold < cost) { toast(T().toast.noGold, '#ff5f6d'); return; }
      S.gold -= cost; S.reinforce++; S.hpBase += 300; S.hp += 300;
      toast(T().toast.fortified, '#56e1ff');
      return;
    }
    const cost = fixCost();
    if (S.gold < cost) { toast(T().toast.noGold, '#ff5f6d'); return; }
    S.gold -= cost;
    S.hp = Math.min(mx, S.hp + mx * 0.35);
    for (let i = 0; i < 14; i++) puff(cx(BED[0].c) + 20, cy(BED[0].r), '#4ade80');
    toast(T().toast.fixed, '#4ade80');
  }

  // ================= 寻路距离场 =================
  const dist = [];
  for (let r = 0; r < ROWS; r++) dist[r] = new Array(COLS).fill(Infinity);
  function rebuildField() {
    for (let r = 0; r < ROWS; r++) dist[r].fill(Infinity);
    const q = [[BED[0].c, BED[0].r]];
    dist[BED[0].r][BED[0].c] = 0;
    const passable = (c, r) => {
      const t = grid[r][c];
      return t === FLOOR || t === DOORT;
    };
    while (q.length) {
      const cur = q.shift(), c = cur[0], r = cur[1];
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
        if (!passable(nc, nr)) continue;
        const occ = S.occupied.get(ck(nc, nr));
        if (occ && occ.type === 'barrier') continue;  // 只有路障能封住路线
        if (dist[nr][nc] !== Infinity) continue;
        dist[nr][nc] = dist[r][c] + 1;
        q.push([nc, nr]);
      }
    }
    _ampDirty = true;   // 建筑拓扑变化，下一帧重算增幅光环
  }

  // ================= 波次 =================
  function makeGhostCfg(w, boss) {          // 一只小鬼的属性（boss 为旧版精英鬼，保留备用）
    return {
      hp: Math.round((22 + w * 8) * Math.pow(1.13, w - 1) * (boss ? 4 : 1)),
      maxHp: 0, speed: Math.min(2.2, 0.8 + w * 0.033) * (boss ? 0.7 : 1),
      dmg: Math.round((5 + w * 1.6) * (boss ? 1.8 : 1)),
      reward: Math.round((10 + w * 3.5) * (boss ? 6 : 1)),
      boss: !!boss, scale: boss ? 1.7 : 1, king: false
    };
  }
  function makeGhost(cfg, x, y) {
    return {
      x, y, cfg, hp: cfg.hp, maxHp: cfg.maxHp || cfg.hp, speed: cfg.speed,
      atkCd: 0, hitFlash: 0, slow: 0, slowM: 1, stun: 0, poisonT: 0, poisonDps: 0,
      king: !!cfg.king,                       // 王标记（不移动、不参与清波判定）
      wob: Math.random() * 6.28
    };
  }
  function startWave() {
    S.wave++;
    const w = S.wave, kingWave = w % KING_EVERY === 0;
    const count = 2 + Math.floor(w * 0.5);
    for (let i = 0; i < count; i++) {
      const cfg = makeGhostCfg(w, false);
      cfg.delay = i * 0.5 + Math.random() * 0.3;
      S.spawnQueue.push(cfg);
    }
    S.spawnQueue.forEach(g => g.maxHp = g.hp);
    S.spawnTimer = 0; S.waveActive = true;
    toast(fill(T().toast.waveIn, { n: w, boss: kingWave ? T().toast.bossTag : '' }), '#ff5f6d');
    if (kingWave) spawnKing(w);            // 每 5 关：王降临
  }
  // 王：不移动、血量 = 关卡数 × 100、每 5 秒产 关卡数 × 2 只小鬼、不打败就一直在
  function spawnKing(w) {
    const d = DOORS[(Math.random() * DOORS.length) | 0];
    const hp = w * KING_HP_PER_WAVE;
    const cfg = { hp, maxHp: hp, speed: 0, dmg: 0, reward: 150 + w * 40, scale: 2.2, king: true, boss: false };
    const k = makeGhost(cfg, cx(d.c) - TILE * 0.2, cy(d.r));
    k.kingCd = KING_SPAWN_CD; k.kingWave = w; k.wob = 0;
    S.ghosts.push(k);
    S.fx.push({ ring: [k.x, k.y, 3 * TILE], color: '#ffcc4d', life: .6, max: .6, x: 0, y: 0 });
    for (let i = 0; i < 26; i++) puff(k.x, k.y, '#ffcc4d');
    toast(fill(T().toast.kingIn, { n: w, hp, spawn: w * KING_SPAWN_MUL }), '#ffcc4d');
  }
  function spawnGhost(cfg) {
    const d = DOORS[(Math.random() * DOORS.length) | 0];
    S.ghosts.push(makeGhost(cfg, cx(d.c) + TILE * 0.35, cy(d.r) + (Math.random() - .5) * 20));
  }

  // ================= 特效 =================
  function puff(x, y, color) {
    S.fx.push({ x, y, vx: (Math.random() - .5) * 90, vy: (Math.random() - .5) * 90, life: .5, max: .5, color, r: 2 + Math.random() * 2 });
  }
  function toast(text, color) { S.fx.push({ text, color, life: 1.3, max: 1.3, x: W / 2, y: 70, vy: -22 }); }

  // ================= 更新 =================
  function update(dt) {
    S.time += dt;
    recomputeGlobals();
    const inc = _income;
    S.gold += inc.rate * dt;
    S.earned += inc.rate * dt;

    // 全场慢放（时钟塔）
    if (S.slowMo > 0) { S.slowMo -= dt; if (S.slowMo <= 0) S.slowMoVal = 1; }
    const mx = _mx;
    if (S.hp > mx) S.hp = mx;
    if (_pinfo.ok) S.buildings.forEach(b => {
      if (b.type === 'shield') S.hp = Math.min(mx, S.hp + CONF.shield.regen[b.level - 1] * dt);
    });

    // 波次调度
    if (!S.waveActive && !S.over) {
      S.waveTimer -= dt;
      if (S.waveTimer <= 0) startWave();
    }
    if (S.spawnQueue.length) {
      S.spawnTimer += dt;
      while (S.spawnQueue.length && S.spawnQueue[0].delay <= S.spawnTimer) spawnGhost(S.spawnQueue.shift());
    } else if (S.waveActive && !S.ghosts.some(g => !g.king)) {   // 王不算进本波清怪条件
      S.waveActive = false;
      const bonus = 40 + S.wave * 20;
      S.gold += bonus; S.earned += bonus;
      toast(fill(T().toast.cleared, { n: S.wave, b: bonus }), '#4ade80');
      if (!S.endless && S.wave >= MAX_WAVE) { finish(true); return; }
      S.waveTimer = 12;
    }

    // 建筑行为（增幅光环仅在建筑变化时重算）
    if (_ampDirty) { refreshAmp(); _ampDirty = false; }
    for (let i = S.buildings.length - 1; i >= 0; i--) {
      const b = S.buildings[i], cf = CONF[b.type];
      if (b.pop > 0) b.pop -= dt * 3;
      if (b.flash > 0) b.flash -= dt;
      const powered = _pinfo.ok;
      switch (cf.be) {
        case 'bullet': attackBD(b, cf, dt, powered, true); break;
        case 'laser': attackBD(b, cf, dt, powered, false); break;
        case 'cone': doCone(b, cf, dt, powered); break;
        case 'chain': doChain(b, cf, dt, powered); break;
        case 'trigger': doTrap(b, cf, dt, powered); break;
        case 'bomb': doBomb(b, cf, dt, powered); break;
        case 'cloud': doCloud(b, cf, dt, powered); break;
        case 'beam': doBeam(b, cf, dt, powered); break;
        case 'push': doPush(b, cf, dt, powered); break;
        case 'field': doField(b, cf, dt, powered); break;
        case 'drone': doDrone(b, cf, dt, powered); break;
        case 'spike': doSpike(b, cf, dt, powered); break;
        case 'portal': doPortal(b, cf, dt, powered); break;
        case 'freeze': doFreeze(b, cf, dt, powered); break;
        case 'clock': doClock(b, cf, dt, powered); break;
        case 'guard': doGuard(b, cf, dt, powered); break;
        case 'mark': doMark(b, cf, dt, powered); break;
        case 'econ': doEcon(b, cf, dt, powered); break;
        case 'wall': case 'decoy': case 'aura': break;
      }
    }

    updateBullets(dt);
    updateGhosts(dt);

    for (let i = S.fx.length - 1; i >= 0; i--) {
      const f = S.fx[i]; f.life -= dt;
      if (f.life <= 0) { S.fx.splice(i, 1); continue; }
      f.x += (f.vx || 0) * dt; f.y += (f.vy || 0) * dt;
      if (f.vy) f.vy *= 0.96;
    }
    S.shake = Math.max(0, S.shake - dt * 26);
  }

  function pickTarget(b, cf, preferFront) {
    const bx = cx(b.c), by = cy(b.r), range = rngOf(b, cf);
    let best = null, score = preferFront ? Infinity : Infinity;
    for (const g of S.ghosts) {
      const d2 = (g.x - bx) ** 2 + (g.y - by) ** 2;
      if (d2 > range * range) continue;
      const sc = preferFront ? tileDist(g) : d2;
      if (sc < score) { score = sc; best = g; }
    }
    return best;
  }
  function tileDist(g) {
    const c = Math.min(COLS - 1, Math.max(0, Math.floor(g.x / TILE)));
    const r = Math.min(ROWS - 1, Math.max(0, Math.floor(g.y / TILE)));
    const d = dist[r][c];
    return d === Infinity ? 9999 : d;
  }

  function attackBD(b, cf, dt, powered, isBullet) {
    if (!powered) { b.target = null; return; }
    b.cd -= dt;
    const range = rngOf(b, cf), bx = cx(b.c), by = cy(b.r);
    if (!b.target || !S.ghosts.includes(b.target) || b.target.hp <= 0 ||
      (b.target.x - bx) ** 2 + (b.target.y - by) ** 2 > range * range) {
      b.target = pickTarget(b, cf, cf.be === 'laser');
    }
    const t = b.target;
    if (!t) return;
    b.angle = Math.atan2(t.y - by, t.x - bx);
    if (b.cd > 0) return;
    b.cd = 1 / (cf.rate[b.level - 1] * hasteAt(b));
    if (isBullet) {
      S.bullets.push({
        x: bx + Math.cos(b.angle) * 16, y: by + Math.sin(b.angle) * 16,
        vx: Math.cos(b.angle) * (b.type === 'frost' ? 380 : 460), vy: Math.sin(b.angle) * (b.type === 'frost' ? 380 : 460),
        dmg: cf.dmg[b.level - 1] * ampOf(b), life: 1.6, life0: 1.6, kind: b.type === 'frost' ? 'ice' : 'shot'
      });
    } else {
      // 狙击：瞬发射线
      hurt(t, cf.dmg[b.level - 1] * ampOf(b));
      S.fx.push({ line: [bx, by, t.x, t.y], color: '#ff9de0', life: .18, max: .18, x: 0, y: 0 });
      for (let k = 0; k < 6; k++) puff(t.x, t.y, '#ffd0f0');
    }
  }

  function doCone(b, cf, dt, powered) {
    if (!powered) return;
    b.cd -= dt;
    const range = rngOf(b, cf), bx = cx(b.c), by = cy(b.r);
    const tgt = pickTarget(b, cf, true);
    if (tgt) b.angle = Math.atan2(tgt.y - by, tgt.x - bx);
    if (b.cd > 0 || !tgt) return;
    b.cd = 1 / cf.rate[b.level - 1];
    b.flash = 0.22;
    const dmg = cf.dmg[b.level - 1] * ampOf(b), arc = 0.6;
    for (const g of S.ghosts.slice()) {
      const dx = g.x - bx, dy = g.y - by, d = Math.hypot(dx, dy);
      if (d > range) continue;
      let da = Math.atan2(dy, dx) - b.angle;
      while (da > Math.PI) da -= Math.PI * 2; while (da < -Math.PI) da += Math.PI * 2;
      if (Math.abs(da) > arc) continue;
      hurt(g, dmg);
      for (let k = 0; k < 2; k++) puff(g.x, g.y, '#ff9a3c');
    }
  }

  function doChain(b, cf, dt, powered) {
    if (!powered) return;
    b.cd -= dt;
    const range = rngOf(b, cf), bx = cx(b.c), by = cy(b.r);
    if (!b.target || !S.ghosts.includes(b.target) || (b.target.x - bx) ** 2 + (b.target.y - by) ** 2 > range * range) {
      b.target = pickTarget(b, cf, true);
    }
    if (!b.target) return;
    b.angle = Math.atan2(b.target.y - by, b.target.x - bx);
    if (b.cd > 0) return;
    b.cd = 1 / (cf.rate[b.level - 1] * hasteAt(b));
    let src = b.target, hitSet = [src];
    let dmg = cf.dmg[b.level - 1] * ampOf(b);
    hurt(src, dmg);
    S.fx.push({ line: [bx, by, src.x, src.y], color: '#8ff', life: .2, max: .2, x: 0, y: 0 });
    const jumps = cf.jumps[b.level - 1];
    for (let j = 0; j < jumps; j++) {
      let nxt = null, nd = 2.4 * TILE;
      for (const g of S.ghosts) {
        if (hitSet.includes(g)) continue;
        const d = Math.hypot(g.x - src.x, g.y - src.y);
        if (d < nd) { nd = d; nxt = g; }
      }
      if (!nxt) break;
      dmg *= 0.6;
      hurt(nxt, dmg);
      S.fx.push({ line: [src.x, src.y, nxt.x, nxt.y], color: '#8ff', life: .2, max: .2, x: 0, y: 0 });
      hitSet.push(nxt); src = nxt;
    }
    b.flash = 0.18;
  }

  function doTrap(b, cf, dt, powered) {
    if (!powered) return;
    const range = rngOf(b, cf);
    b.cd -= dt;
    if (b.cd > 0) return;
    const bx = cx(b.c), by = cy(b.r);
    let any = false;
    for (const g of S.ghosts.slice()) {
      if ((g.x - bx) ** 2 + (g.y - by) ** 2 <= range * range) { hurt(g, cf.dmg[b.level - 1] * ampOf(b)); any = true; }
    }
    if (any) {
      b.cd = 1 / cf.rate[b.level - 1]; b.flash = 0.25;
      for (let k = 0; k < 10; k++) puff(bx, by, '#ffcc4d');
    }
  }

  function doEcon(b, cf, dt, powered) {
    if (!powered || b.type !== 'medic') return;
    b.tick = (b.tick || 0) + dt;
    if (b.tick >= CONF.medic.every) {
      b.tick = 0;
      const mx = maxHp();
      if (S.hp < mx) {
        S.hp = Math.min(mx, S.hp + CONF.medic.heal[b.level - 1]);
        S.fx.push({ text: '+' + CONF.medic.heal[b.level - 1], color: '#4ade80', life: .9, max: .9, x: cx(b.c), y: cy(b.r) - 16, vy: -26 });
      }
    }
  }

  // 炸弹桶：范围内有目标就引爆（圆形 AOE）
  function doBomb(b, cf, dt, powered) {
    if (!powered || !S.ghosts.length) return;
    b.cd -= dt;
    if (b.cd > 0) return;
    const R = rngOf(b, cf), bx = cx(b.c), by = cy(b.r);
    let n = 0;
    for (const g of S.ghosts) if ((g.x - bx) ** 2 + (g.y - by) ** 2 <= R * R) n++;
    if (!n) return;
    b.cd = 1 / cf.rate[b.level - 1]; b.flash = 0.3;
    for (const g of S.ghosts.slice()) {
      if ((g.x - bx) ** 2 + (g.y - by) ** 2 <= R * R) hurt(g, cf.dmg[b.level - 1] * ampOf(b));
    }
    S.fx.push({ ring: [bx, by, R], color: '#ff9a3c', life: .35, max: .35, x: 0, y: 0 });
    for (let k = 0; k < 18; k++) puff(bx, by, k % 2 ? '#ffd08a' : '#ff7a3c');
    S.shake = Math.min(12, S.shake + 3);
  }

  // 毒气塔：给范围内猛鬼持续挂中毒
  function doCloud(b, cf, dt, powered) {
    if (!powered) return;
    const R = rngOf(b, cf), bx = cx(b.c), by = cy(b.r);
    b.tick = (b.tick || 0) + dt;
    const pulse = b.tick >= 0.5;
    if (pulse) { b.tick = 0; b.flash = 0.3; }
    for (const g of S.ghosts) {
      if ((g.x - bx) ** 2 + (g.y - by) ** 2 > R * R) continue;
      g.poisonT = cf.dur;
      g.poisonDps = Math.max(g.poisonDps || 0, cf.dps[b.level - 1]);
      if (pulse) puff(g.x, g.y, '#9be564');
    }
  }

  // 聚能射线：锁定一个目标持续加热，伤害随灼烧时间递增
  function doBeam(b, cf, dt, powered) {
    if (!powered) { b.target = null; b.heat = 0; return; }
    const range = rngOf(b, cf), bx = cx(b.c), by = cy(b.r);
    if (!b.target || !S.ghosts.includes(b.target) ||
      (b.target.x - bx) ** 2 + (b.target.y - by) ** 2 > range * range) {
      b.target = pickTarget(b, cf, true); b.heat = 0;
    }
    const t = b.target;
    if (!t) return;
    b.angle = Math.atan2(t.y - by, t.x - bx);
    b.heat = Math.min(3, (b.heat || 0) + dt);
    b.cd -= dt;
    if (b.cd > 0) return;
    b.cd = 1 / cf.rate[b.level - 1];
    hurt(t, cf.dmg[b.level - 1] * ampOf(b) * (1 + b.heat * (cf.heat || 0.18)));
    puff(t.x, t.y, '#ffe9a8');
  }

  // 磁暴：脉冲击退 + 短暂眩晕
  function doPush(b, cf, dt, powered) {
    if (!powered) return;
    b.cd -= dt;
    if (b.cd > 0) return;
    const R = rngOf(b, cf), bx = cx(b.c), by = cy(b.r);
    let any = false;
    for (const g of S.ghosts.slice()) {
      if (g.king) continue;                        // 王推不动
      const dx = g.x - bx, dy = g.y - by, d = Math.hypot(dx, dy) || 1;
      if (d > R) continue;
      any = true;
      g.x += dx / d * TILE * 0.9; g.y += dy / d * TILE * 0.9;
      g.stun = cf.stun;
      hurt(g, cf.dmg[b.level - 1] * ampOf(b));
    }
    if (any) {
      b.cd = 1 / cf.rate[b.level - 1]; b.flash = 0.3;
      S.fx.push({ ring: [bx, by, R], color: '#8ff', life: .3, max: .3, x: 0, y: 0 });
      for (let k = 0; k < 10; k++) puff(bx, by, '#a8f0ff');
    }
  }

  // 滞缓力场：范围内持续减速
  function doField(b, cf, dt, powered) {
    if (!powered) return;
    const R = rngOf(b, cf), bx = cx(b.c), by = cy(b.r);
    const mul = cf.slowMul[b.level - 1];
    for (const g of S.ghosts) {
      if ((g.x - bx) ** 2 + (g.y - by) ** 2 > R * R) continue;
      g.slow = Math.max(g.slow, 0.3);
      g.slowM = Math.min(g.slowM === undefined ? 1 : g.slowM, mul);
    }
  }

  // 无人机：飞向目标并开火
  function doDrone(b, cf, dt, powered) {
    if (!powered) return;
    if (b.x === undefined) { b.x = cx(b.c); b.y = cy(b.r); }
    const homeX = cx(b.c), homeY = cy(b.r);
    const R = rngOf(b, cf);
    let t = null, bd = Infinity;
    for (const g of S.ghosts) {
      if ((g.x - homeX) ** 2 + (g.y - homeY) ** 2 > R * R) continue;
      const d = (g.x - b.x) ** 2 + (g.y - b.y) ** 2;
      if (d < bd) { bd = d; t = g; }
    }
    const spd = TILE * 3.2;
    if (t) {
      const dx = t.x - b.x, dy = t.y - b.y, d = Math.hypot(dx, dy) || 1;
      if (d > 26) { b.x += dx / d * spd * dt; b.y += dy / d * spd * dt; }
      b.angle = Math.atan2(dy, dx);
      b.cd -= dt;
      if (b.cd <= 0 && d <= 64) {
        b.cd = 1 / (cf.rate[b.level - 1] * hasteAt(b));
        hurt(t, cf.dmg[b.level - 1] * ampOf(b));
        S.fx.push({ line: [b.x, b.y, t.x, t.y], color: '#bff0ff', life: .12, max: .12, x: 0, y: 0 });
      }
    } else {
      const dx = homeX - b.x, dy = homeY - b.y, d = Math.hypot(dx, dy) || 1;
      if (d > 4) { b.x += dx / d * spd * dt; b.y += dy / d * spd * dt; }
      b.angle = Math.atan2(dy, dx);
    }
    b.wob = (b.wob || 0) + dt * 8;
  }

  // 尖刺地板：踩着就一直掉血
  function doSpike(b, cf, dt, powered) {
    if (!powered) return;
    const R = rngOf(b, cf), bx = cx(b.c), by = cy(b.r);
    for (const g of S.ghosts.slice()) {
      if ((g.x - bx) ** 2 + (g.y - by) ** 2 > R * R) continue;
      hurt(g, cf.dps[b.level - 1] * ampOf(b) * dt, true);
    }
  }

  // 传送门：把推进最深的猛鬼送回门口重走
  function doPortal(b, cf, dt, powered) {
    if (!powered) return;
    b.cd -= dt;
    const R = rngOf(b, cf), bx = cx(b.c), by = cy(b.r);
    const inside = S.ghosts.filter(g => !g.king && (g.x - bx) ** 2 + (g.y - by) ** 2 <= R * R);   // 王传送不动
    if (!inside.length) return;
    if (b.cd > 0) return;
    b.cd = 1 / cf.rate[b.level - 1]; b.flash = 0.4;
    inside.sort((p, q) => tileDist(p) - tileDist(q)).slice(0, cf.count[b.level - 1]).forEach(g => {
      let door = DOORS[0], bd = Infinity;
      for (const d of DOORS) {
        const dd = (g.x - cx(d.c)) ** 2 + (g.y - cy(d.r)) ** 2;
        if (dd < bd) { bd = dd; door = d; }
      }
      for (let k = 0; k < 8; k++) puff(g.x, g.y, '#a78bfa');
      g.x = cx(door.c) + TILE * 0.35; g.y = cy(door.r) + (Math.random() - .5) * 20;
      g.stun = 0.3;
      for (let k = 0; k < 10; k++) puff(g.x, g.y, '#a78bfa');
      S.fx.push({ ring: [g.x, g.y, 26], color: '#a78bfa', life: .4, max: .4, x: 0, y: 0 });
    });
  }

  // 急冻仓：定期冻结范围内猛鬼
  function doFreeze(b, cf, dt, powered) {
    if (!powered) return;
    b.cd -= dt;
    if (b.cd > 0) return;
    const R = rngOf(b, cf), bx = cx(b.c), by = cy(b.r);
    let any = false;
    for (const g of S.ghosts) {
      if ((g.x - bx) ** 2 + (g.y - by) ** 2 > R * R) continue;
      any = true; g.stun = cf.freeze[b.level - 1]; g.frozen = g.stun;
    }
    if (any) {
      b.cd = 1 / cf.rate[b.level - 1]; b.flash = 0.4;
      S.fx.push({ ring: [bx, by, R], color: '#9fe6ff', life: .4, max: .4, x: 0, y: 0 });
      for (let k = 0; k < 12; k++) puff(bx, by, '#9fe6ff');
    }
  }

  // 时钟塔：周期性全场慢放
  function doClock(b, cf, dt, powered) {
    if (!powered) return;
    b.tick = (b.tick || 0) + dt;
    if (b.tick < cf.every) return;
    b.tick = 0; b.flash = 0.6;
    S.slowMo = Math.max(S.slowMo, cf.dur);
    S.slowMoVal = Math.min(S.slowMoVal === undefined ? 1 : S.slowMoVal, cf.slowmo[b.level - 1]);
    S.fx.push({ ring: [cx(b.c), cy(b.r), 6 * TILE], color: '#c9b8ff', life: .6, max: .6, x: 0, y: 0 });
  }

  // 聚光灯：标记范围内猛鬼，使其受到的伤害提升
  function doMark(b, cf, dt, powered) {
    if (!powered) return;
    const R = rngOf(b, cf), bx = cx(b.c), by = cy(b.r);
    const mul = 1 + cf.mark[b.level - 1];
    for (const g of S.ghosts) {
      if ((g.x - bx) ** 2 + (g.y - by) ** 2 > R * R) continue;
      g.markMul = Math.max(g.markMul || 1, mul);
      g.markT = 0.3;
    }
  }

  // 保安：近战肉盾，会被打死，8 秒后复活
  function doGuard(b, cf, dt, powered) {
    if (b.x === undefined) { b.x = cx(b.c); b.y = cy(b.r); }
    if (b.dead) {
      if (!powered) return;
      b.respawnT -= dt;
      if (b.respawnT <= 0) {
        b.dead = false; b.hp = b.maxHp;
        for (let k = 0; k < 10; k++) puff(b.x, b.y, '#56e1ff');
      }
      return;
    }
    if (!powered) return;
    const homeX = cx(b.c), homeY = cy(b.r), R = rngOf(b, cf);
    let t = null, bd = Infinity;
    for (const g of S.ghosts) {
      if ((g.x - homeX) ** 2 + (g.y - homeY) ** 2 > R * R) continue;
      const d = (g.x - b.x) ** 2 + (g.y - b.y) ** 2;
      if (d < bd) { bd = d; t = g; }
    }
    const spd = TILE * 2.2;
    if (t) {
      const dx = t.x - b.x, dy = t.y - b.y, d = Math.hypot(dx, dy) || 1;
      if (d > 30) { b.x += dx / d * spd * dt; b.y += dy / d * spd * dt; }
      b.angle = Math.atan2(dy, dx);
      b.cd -= dt;
      if (b.cd <= 0 && d <= 46) {
        b.cd = 1 / (cf.rate[b.level - 1] * hasteAt(b));
        hurt(t, cf.dmg[b.level - 1] * ampOf(b));
        S.fx.push({ line: [b.x, b.y, t.x, t.y], color: '#ffd08a', life: .12, max: .12, x: 0, y: 0 });
      }
    } else {
      const dx = homeX - b.x, dy = homeY - b.y, d = Math.hypot(dx, dy) || 1;
      if (d > 4) { b.x += dx / d * spd * dt; b.y += dy / d * spd * dt; }
    }
    b.wob = (b.wob || 0) + dt * 6;
  }

  function nearestBait(g) {          // 诱饵床 / 保安：猛鬼优先攻击的目标
    let best = null, bd = 3.2 * TILE;
    for (const b of S.buildings) {
      if (b.type !== 'decoy' && !(b.type === 'guard' && !b.dead)) continue;
      const d = Math.hypot(cx(b.c) - g.x, cy(b.r) - g.y);
      if (d <= bd) { bd = d; best = b; }
    }
    return best;
  }

  function hurt(g, dmg, noCrit) {
    let d = dmg * (g.markMul > 1 ? g.markMul : 1);   // 聚光灯标记增伤
    if (!noCrit) {
      const cr = _crit;
      if (cr > 0 && Math.random() < cr) {            // 暴击核心
        d *= 3;
        S.fx.push({ text: T().fx.crit, color: '#ffcc4d', life: .7, max: .7, x: g.x, y: g.y - 22, vy: -30 });
      }
    }
    g.hp -= d; g.hitFlash = 0.12;
    if (g.hp <= 0) {
      S.gold += g.cfg.reward; S.earned += g.cfg.reward; S.kills++;
      for (let k = 0; k < 12; k++) puff(g.x, g.y, '#b98dff');
      S.fx.push({ text: '+' + g.cfg.reward, color: '#ffcc4d', life: .8, max: .8, x: g.x, y: g.y, vy: -38 });
      S.ghosts.splice(S.ghosts.indexOf(g), 1);
    }
  }

  function updateBullets(dt) {
    for (let i = S.bullets.length - 1; i >= 0; i--) {
      const b = S.bullets[i];
      b.life -= dt;
      let hit = null;
      for (const g of S.ghosts) {
        const rr = (13 * g.cfg.scale) ** 2;
        if ((g.x - b.x) ** 2 + (g.y - b.y) ** 2 < rr) { hit = g; break; }
      }
      if (hit) {
        hurt(hit, b.dmg);
        if (b.kind === 'ice') { hit.slow = 1.5; }
        for (let k = 0; k < 3; k++) puff(b.x, b.y, b.kind === 'ice' ? '#9fe6ff' : '#ffe08a');
        S.bullets.splice(i, 1); continue;
      }
      if (b.life <= 0) { S.bullets.splice(i, 1); continue; }
      b.x += b.vx * dt; b.y += b.vy * dt;
    }
  }

  function updateGhosts(dt) {
    for (let i = S.ghosts.length - 1; i >= 0; i--) {
      const g = S.ghosts[i];
      if (g.hitFlash > 0) g.hitFlash -= dt;
      if (g.slow > 0) { g.slow -= dt; if (g.slow <= 0) g.slowM = 1; }
      if (g.stun > 0) g.stun -= dt;
      if (g.frozen > 0) g.frozen -= dt;                // 冻结（视觉）
      if (g.markT > 0) { g.markT -= dt; if (g.markT <= 0) g.markMul = 1; }
      if (g.poisonT > 0) {                       // 中毒持续掉血
        g.poisonT -= dt;
        hurt(g, g.poisonDps * dt, true);
        if (!S.ghosts.includes(g)) continue;      // 被毒死
      }
      // 王：原地不动，每 5 秒产一波小鬼（被冻结时停产）
      if (g.king) {
        g.wob += dt * 2;
        if (g.stun <= 0) {
          g.kingCd -= dt * (S.slowMo > 0 ? S.slowMoVal : 1);   // 时钟塔也能拖慢它
          if (g.kingCd <= 0) {
            g.kingCd = KING_SPAWN_CD;
            const n = g.kingWave * KING_SPAWN_MUL, room = MAX_GHOSTS - S.ghosts.length;
            for (let k = 0; k < Math.min(n, room); k++) {
              S.ghosts.push(makeGhost(makeGhostCfg(g.kingWave, false),
                g.x - TILE * 0.3 + (Math.random() - .5) * 26, g.y + (Math.random() - .5) * 34));
            }
            S.fx.push({ ring: [g.x, g.y, 2.6 * TILE], color: '#ff5f6d', life: .5, max: .5, x: 0, y: 0 });
            for (let k = 0; k < 14; k++) puff(g.x, g.y, '#ff5f6d');
            toast(fill(T().toast.kingSpawn, { n }), '#ff5f6d');
          }
        }
        continue;
      }
      if (g.stun > 0) { g.wob += dt * 6; continue; }   // 眩晕/冻结：不动不攻击
      const spd = g.speed * (g.slow > 0 && g.slowM !== undefined ? g.slowM : 1) *
        (S.slowMo > 0 ? S.slowMoVal : 1);              // 时钟塔：全场慢放
      const gc = Math.floor(g.x / TILE), gr = Math.floor(g.y / TILE);
      const safe = r => Math.min(ROWS - 1, Math.max(0, r)), safec = c => Math.min(COLS - 1, Math.max(0, c));
      const d = dist[safe(gr)][safec(gc)];

      // 到达床位 -> 啃床
      if (d <= 1 || (gc <= BED[0].c + 1 && Math.abs(gr - BED[0].r) <= 1)) {
        g.atkCd -= dt;
        if (g.atkCd <= 0) {
          g.atkCd = 1;
          S.hp -= g.cfg.dmg;
          S.shake = Math.min(12, S.shake + 5);
          puff(cx(BED[0].c) + 16, cy(BED[0].r), '#ff5f6d');
          if (S.hp <= 0) { S.hp = 0; finish(false); return; }
        }
        continue;
      }
      // 诱饵床 / 保安：3.2 格内优先去啃
      const bait = nearestBait(g);
      if (bait) {
        const bx2 = bait.type === 'guard' && bait.x !== undefined ? bait.x : cx(bait.c);
        const by2 = bait.type === 'guard' && bait.y !== undefined ? bait.y : cy(bait.r);
        const dx = bx2 - g.x, dy = by2 - g.y, dd = Math.hypot(dx, dy) || 1;
        if (dd > 30) {
          g.x += dx / dd * spd * TILE * dt; g.y += dy / dd * spd * TILE * dt; g.wob += dt * 6;
        } else {
          g.atkCd -= dt;
          if (g.atkCd <= 0) {
            g.atkCd = 1;
            bait.hp -= g.cfg.dmg * 2;
            for (let k = 0; k < 3; k++) puff(bx2, by2, bait.type === 'guard' ? '#ffd08a' : '#ffb36b');
            if (bait.hp <= 0) {
              if (bait.type === 'guard') {          // 保安阵亡，等待复活
                bait.dead = true; bait.respawnT = CONF.guard.respawn;
                toast(T().toast.guardDown, '#ff5f6d');
              } else {
                toast(T().toast.decoyDown, '#ff5f6d');
                S.buildings = S.buildings.filter(x => x !== bait);
                S.occupied.delete(ck(bait.c, bait.r));
                if (S.selected === bait) selectBuilding(null);
                rebuildField();
              }
            }
          }
        }
        continue;
      }
      // 目标格（含撞路障）
      let best = null, bd = (d === undefined ? Infinity : d);
      if (d !== Infinity) {
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nc = safec(gc + dc), nr = safe(gr + dr);
          if (dist[nr][nc] < bd) { bd = dist[nr][nc]; best = [nc, nr]; }
        }
      }
      let tx, ty;
      if (best) { tx = cx(best[0]); ty = cy(best[1]); }
      else { tx = cx(BED[0].c); ty = cy(BED[0].r); }   // 被路障封住时直线突围
      let vx = tx - g.x, vy = ty - g.y;
      const len = Math.hypot(vx, vy) || 1;
      const nx = g.x + (vx / len) * spd * TILE * dt;
      const ny = g.y + (vy / len) * spd * TILE * dt;

      // 前方是否有路障 -> 拆墙
      const nc2 = Math.floor((nx + (vx / len) * 14) / TILE), nr2 = Math.floor((ny + (vy / len) * 14) / TILE);
      const wall = S.occupied.get(ck(nc2, nr2));
      if (wall && wall.type === 'barrier') {
        g.atkCd -= dt;
        if (g.atkCd <= 0) {
          g.atkCd = 1;
          wall.hp -= g.cfg.dmg * 2;
          for (let k = 0; k < 4; k++) puff(cx(wall.c), cy(wall.r), '#c9b18a');
          if (wall.hp <= 0) {
            toast(T().toast.wallDown, '#ff5f6d');
            S.buildings = S.buildings.filter(x => x !== wall);
            S.occupied.delete(ck(wall.c, wall.r));
            rebuildField();
          }
        }
        continue;
      }
      g.x = nx; g.y = ny; g.wob += dt * 6;
    }
  }

  function finish(win) {
    S.over = true; S.won = win; S.running = false;
    el.panel.classList.add('hidden');
    const R = T().res;
    $('rTitle').textContent = win ? R.winTitle : R.loseTitle;
    $('rSub').textContent = win ? R.winSub : fill(R.loseSub, { n: S.wave });
    const kv = { wave: S.wave, max: MAX_WAVE, kills: S.kills, gold: Math.round(S.earned), bed: S.bedLevel, build: S.buildings.length };
    $('rStats').innerHTML = [R.s1, R.s2, R.s3, R.s4].map(s => `<li>${fill(s, kv)}</li>`).join('');
    el.result.classList.add('show'); el.result.classList.remove('hidden');
    $('btnAgain').textContent = win ? R.endless : R.again;
  }

  // ================= 绘制 =================

  function draw() {
    ctx.save();
    if (S.shake > 0) ctx.translate((Math.random() - .5) * S.shake, (Math.random() - .5) * S.shake);
    drawRoom();
    drawPlacements();
    drawBuildings();
    drawDrones();
    drawGuards();
    drawPreview();
    drawBed();
    drawGhosts();
    drawBullets();
    if (S.slowMo > 0) {                            // 时钟塔：全场慢放滤镜
      ctx.fillStyle = 'rgba(120,140,255,.10)'; ctx.fillRect(0, 0, W, H);
    }
    drawFx();
    ctx.restore();
    // 低血量红色暗角（画质 / 手感）
    const vr = _mx > 0 ? S.hp / _mx : 1;
    if (vr < 0.5 && !S.over) {
      const a = (0.5 - vr) / 0.5;
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.28, W / 2, H / 2, H * 0.72);
      g.addColorStop(0, 'rgba(255,30,50,0)');
      g.addColorStop(1, 'rgba(255,30,50,' + (a * 0.5).toFixed(3) + ')');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
  }

  function drawRoom() {
    if (!_roomCanvas) {                 // 静态房间只画一次，缓存到离屏 canvas
      _roomCanvas = document.createElement('canvas');
      _roomCanvas.width = Math.round(W * RS); _roomCanvas.height = Math.round(H * RS);
      const rctx = _roomCanvas.getContext('2d');
      rctx.setTransform(RS, 0, 0, RS, 0, 0);
      drawRoomStatic(rctx);
    }
    ctx.drawImage(_roomCanvas, 0, 0, W, H);
  }
  function drawRoomStatic(g) {
    // 暖色木地板（宿舍夜色 + 暖木，让冷色猛鬼更跳——参考 Emberward「暖光 vs 暗怪」对比）
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#2c2438'); grad.addColorStop(1, '#1d1830');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    // 木地板：棋盘底色
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (grid[r][c] === FURN) continue;
      g.fillStyle = (c + r) % 2 ? 'rgba(255,205,150,.05)' : 'rgba(0,0,0,.12)';
      g.fillRect(c * TILE, r * TILE, TILE, TILE);
    }
    // 木纹：横向板缝 + 错位的竖向板缝
    g.strokeStyle = 'rgba(255,210,160,.06)'; g.lineWidth = 1; g.beginPath();
    for (let r = 0; r <= ROWS; r++) { g.moveTo(0, r * TILE + .5); g.lineTo(W, r * TILE + .5); }
    for (let r = 0; r < ROWS; r++) {
      const off = (r % 2) ? TILE / 2 : 0;
      for (let c = 0; c <= COLS; c++) { const x = c * TILE + off + .5; if (x > 0 && x < W) { g.moveTo(x, r * TILE); g.lineTo(x, (r + 1) * TILE); } }
    }
    g.stroke();
    // 地毯
    g.fillStyle = 'rgba(255,140,190,.09)';
    g.fillRect(TILE * 0.2, TILE * (ROWS - 4.2), TILE * 4.2, TILE * 3.4);
    // 四周木墙 + 上下踢脚线
    g.strokeStyle = '#7a5c3a'; g.lineWidth = 6; g.strokeRect(3, 3, W - 6, H - 6);
    g.fillStyle = 'rgba(122,92,58,.55)';
    g.fillRect(6, H - 12, W - 12, 6); g.fillRect(6, 6, W - 12, 6);
    // 门（矢量门板 + 面板线 + 门把手）
    DOORS.forEach(d => {
      const dy = cy(d.r);
      g.fillStyle = '#5b4326'; g.fillRect(W - 13, dy - 18, 13, 36);
      g.fillStyle = '#caa46a'; roundRectOn(g, W - 11, dy - 16, 8, 32, 2); g.fill();
      g.strokeStyle = 'rgba(70,45,25,.5)'; g.lineWidth = 1; g.beginPath();
      g.moveTo(W - 9, dy - 12); g.lineTo(W - 5, dy - 12); g.moveTo(W - 9, dy + 12); g.lineTo(W - 5, dy + 12); g.stroke();
      g.fillStyle = '#3d2c18'; g.beginPath(); g.arc(W - 4, dy, 1.6, 0, 6.3); g.fill();
    });
    // 家具：先垫一块暖色地垫，再画矢量家具
    FURNITURE.forEach(f => {
      const x = f.c * TILE, y = f.r * TILE;
      g.fillStyle = 'rgba(255,200,150,.07)';
      roundRectOn(g, x + 4, y + 4, TILE - 8, TILE - 8, 9); g.fill();
      g.strokeStyle = 'rgba(255,210,160,.10)'; g.lineWidth = 1; g.stroke();
      g.save(); g.translate(cx(f.c), cy(f.r)); drawFurniture(g, f.k); g.restore();
    });
    // 柔和暗角，把视线聚到中央
    const vg = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.30)');
    g.fillStyle = vg; g.fillRect(0, 0, W, H);
  }

  function drawPlacements() {
    if (!S.placing) return;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (grid[r][c] !== FLOOR || S.occupied.has(ck(c, r))) continue;
      ctx.strokeStyle = 'rgba(86,225,255,.20)'; ctx.lineWidth = 1;
      ctx.strokeRect(c * TILE + 3.5, r * TILE + 3.5, TILE - 7, TILE - 7);
    }
  }

  function drawBuildings() {
    S.buildings.forEach(b => {
      if (b.type === 'drone' || b.type === 'guard') return;   // 移动单位单独绘制
      const cf = CONF[b.type], x = cx(b.c), y = cy(b.r);
      const off = b.type !== 'barrier' && cf.use && cf.use[b.level - 1] > 0 && !_pinfo.ok;
      const pop = 1 + Math.max(0, b.pop) * 0.25;
      ctx.save(); ctx.translate(x, y); ctx.scale(pop, pop);

      if (cf.be === 'cone' && b.flash > 0 && b.target) {
        ctx.save(); ctx.rotate(b.angle);
        const gg = ctx.createRadialGradient(0, 0, 4, 0, 0, rngOf(b, cf));
        gg.addColorStop(0, 'rgba(255,190,80,.75)'); gg.addColorStop(1, 'rgba(255,90,30,0)');
        ctx.fillStyle = gg;
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.arc(0, 0, rngOf(b, cf), -0.6, 0.6); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      if (b.type === 'tesla' && b.flash > 0) {
        ctx.strokeStyle = 'rgba(140,255,255,.8)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, 20 + b.flash * 60, 0, 6.3); ctx.stroke();
      }
      if (b.type === 'trap') {
        ctx.strokeStyle = b.cd > 0 ? 'rgba(255,204,77,.35)' : 'rgba(255,95,109,.85)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, rngOf(b, cf), 0, 6.3); ctx.stroke();
      }
      if (b.type === 'spikes') {                        // 地面尖刺
        ctx.fillStyle = off ? '#5b6070' : '#c8d0ff';
        for (let k = -1; k <= 1; k++) {
          ctx.beginPath();
          ctx.moveTo(k * 11 - 5, 9); ctx.lineTo(k * 11, -9); ctx.lineTo(k * 11 + 5, 9);
          ctx.closePath(); ctx.fill();
        }
      }
      if (b.type === 'beam' && b.target && !off) {          // 聚能射线
        ctx.strokeStyle = 'rgba(255,233,168,.9)';
        ctx.lineWidth = 1.5 + (b.heat || 0) * 1.6;
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.lineTo(b.target.x - x, b.target.y - y); ctx.stroke();
      }
      if (b.type === 'workshop' || b.type === 'field' || b.type === 'amplifier' || b.type === 'spotlight') {
        const pulse = 0.35 + Math.sin(S.time * 2) * 0.12;   // 范围光环
        ctx.strokeStyle = b.type === 'field' ? `rgba(190,150,255,${pulse})`
          : b.type === 'amplifier' ? `rgba(255,150,90,${pulse})`
            : b.type === 'spotlight' ? `rgba(255,220,120,${pulse})` : `rgba(120,255,180,${pulse})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, rngOf(b, cf), 0, 6.3); ctx.stroke();
      } else if (b.type === 'shield' || b.type === 'medic') {
        const pulse = 0.35 + Math.sin(S.time * 2) * 0.12;
        ctx.fillStyle = `rgba(120,180,255,${pulse * .35})`;
        ctx.beginPath(); ctx.arc(0, 0, 30 + Math.sin(S.time * 2) * 4, 0, 6.3); ctx.fill();
      } else if (b.type === 'radar') {                       // 雷达波纹（向外扩散）
        for (let k = 0; k < 3; k++) {
          const t2 = (S.time * 0.6 + k / 3) % 1;
          ctx.strokeStyle = `rgba(86,225,255,${(1 - t2) * 0.35})`; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(0, 0, t2 * 7 * TILE, 0, 6.3); ctx.stroke();
        }
      } else if (b.type === 'critcore') {                    // 暴击核心脉冲
        const pulse = 0.3 + Math.sin(S.time * 4) * 0.15;
        ctx.strokeStyle = `rgba(255,204,77,${pulse})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, 26 + Math.sin(S.time * 4) * 5, 0, 6.3); ctx.stroke();
      }

      // 底座
      ctx.fillStyle = off ? '#3a3f55' : CAT_COLOR[cf.cat];
      roundRect(-19, -19, 38, 38, 10); ctx.fill();
      ctx.strokeStyle = off ? '#6b7085' : 'rgba(255,255,255,.18)'; ctx.lineWidth = 2; ctx.stroke();

      if (b.type === 'portal') {                            // 传送门漩涡
        ctx.save(); ctx.rotate(S.time * 1.6);
        ctx.strokeStyle = 'rgba(167,139,250,.8)'; ctx.lineWidth = 2;
        for (let k = 0; k < 3; k++) {
          ctx.beginPath(); ctx.arc(0, 0, 9 + k * 5, k * 2.1, k * 2.1 + 2.4); ctx.stroke();
        }
        ctx.restore();
      }
      if (b.type === 'freezer' && b.flash > 0) {            // 急冻冲击
        ctx.strokeStyle = `rgba(159,230,255,${Math.min(1, b.flash * 2)})`; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, 18 + (0.4 - b.flash) * 110, 0, 6.3); ctx.stroke();
      }
      if (b.type === 'clock' && b.flash > 0) {              // 慢放冲击
        ctx.strokeStyle = `rgba(201,184,255,${Math.min(1, b.flash)})`; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, 18 + (0.6 - b.flash) * 130, 0, 6.3); ctx.stroke();
      }

      // 炮管
      if (cf.be === 'bullet' || cf.be === 'laser' || cf.be === 'cone' || cf.be === 'chain') {
        ctx.save(); ctx.rotate(b.angle);
        ctx.fillStyle = off ? '#5b6070' : (b.type === 'sniper' ? '#e58fd0' : b.type === 'frost' ? '#9fe6ff' : b.type === 'flame' ? '#ff9a3c' : b.type === 'tesla' ? '#8ff' : '#8fa3e8');
        if (b.type === 'sniper') roundRect(0, -3, 28, 6, 3);
        else if (b.type === 'flame') roundRect(0, -6, 16, 12, 5);
        else if (b.type === 'tesla') { roundRect(0, -3, 4, 6, 2); }
        else roundRect(0, -5, 22, 10, 4);
        ctx.fill(); ctx.restore();
        ctx.fillStyle = off ? '#5b6070' : (b.type === 'frost' ? '#9fe6ff' : b.type === 'tesla' ? '#8ff' : b.type === 'flame' ? '#ff9a3c' : '#56e1ff');
        ctx.beginPath(); ctx.arc(0, 0, b.type === 'tesla' ? 6 : 9, 0, 6.3); ctx.fill();
      }
      if (b.type !== 'spikes') drawGlyph(ctx, b.type, off, (cf.be === 'bullet' || cf.be === 'laser' || cf.be === 'cone' || cf.be === 'chain') ? b.angle : 0);

      // 等级徽章（1-4 白银 / 5-8 黄金 / 9-12 紫晶）
      const tier = b.level >= 9 ? '#d38bff' : b.level >= 5 ? '#ffcc4d' : '#cfe0ff';
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      roundRect(-17, 10, 34, 12, 6); ctx.fill();
      ctx.strokeStyle = tier; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = tier; ctx.font = 'bold 9px system-ui';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('Lv.' + b.level, 0, 16.5);
      if (b.level >= MAXLV) {   // 满级光环
        ctx.strokeStyle = 'rgba(211,139,255,.6)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(0, 0, 22 + Math.sin(S.time * 3) * 1.5, 0, 6.3); ctx.stroke();
      }
      if (off) { ctx.font = '12px system-ui'; ctx.fillStyle = '#ff8a8a'; ctx.fillText('⚡', 0, -15); }
      ctx.restore();

      // 路障 / 诱饵血条
      if (b.type === 'barrier' || b.type === 'decoy') {
        const w = 34, ratio = Math.max(0, b.hp / b.maxHp);
        ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(x - w / 2, y - 26, w, 4);
        ctx.fillStyle = '#ffb36b'; ctx.fillRect(x - w / 2, y - 26, w * ratio, 4);
      }
      if (S.selected === b) {
        if (cf.range) {
          ctx.strokeStyle = '#56e1ff'; ctx.lineWidth = 2; ctx.fillStyle = 'rgba(86,225,255,.07)';
          ctx.beginPath(); ctx.arc(x, y, rngOf(b, cf), 0, 6.3); ctx.fill(); ctx.stroke();
        }
        ctx.strokeStyle = '#56e1ff'; ctx.setLineDash([5, 4]);
        ctx.strokeRect(x - 22, y - 22, 44, 44); ctx.setLineDash([]);
      }
    });
  }

  function drawBed() {
    const t = BED[0], f = BED[1];
    const bx = cx(t.c), by = cy(t.r), fy = cy(f.r);
    const hurtFlash = Math.max(0, 1 - (S.hp / _mx));
    const breathe = Math.sin(S.time * 2) * 1.2;
    // 床架
    ctx.fillStyle = '#4a3b6b'; roundRect(bx - 20, by - 22, 40, (fy - by) + TILE - 4, 8); ctx.fill();
    // 枕头（铺在床头）
    ctx.fillStyle = '#cdbcf0'; roundRect(bx - 15, by - 20, 30, 19, 9); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.35)'; roundRect(bx - 11, by - 17, 22, 6, 3); ctx.fill();
    // 人头：枕在枕头上（俯视 —— 后脑 + 脸 + 闭着的睡眼）
    const hy = by - 10 + breathe;
    ctx.fillStyle = hurtFlash > 0.5 ? '#ffb0b0' : '#3f8fd8';
    ctx.beginPath(); ctx.arc(bx, hy, 10, 0, 6.3); ctx.fill();
    ctx.fillStyle = hurtFlash > 0.5 ? '#ffd2d2' : '#ffd9b8';
    ctx.beginPath(); ctx.arc(bx, hy + 1.5, 8.2, 0, 6.3); ctx.fill();
    ctx.strokeStyle = '#a17b5c'; ctx.lineWidth = 1.3; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(bx - 4.6, hy + 1.6); ctx.lineTo(bx - 1.6, hy + 1.6);
    ctx.moveTo(bx + 1.6, hy + 1.6); ctx.lineTo(bx + 4.6, hy + 1.6);
    ctx.stroke();
    // 被子（盖住身体）
    ctx.fillStyle = '#5f4c92'; roundRect(bx - 18, by + 7, 36, (fy - by) + TILE - 33, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.10)'; roundRect(bx - 14, by + 12, 28, 6, 3); ctx.fill();
    // 飘 z
    ctx.font = '13px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < 3; i++) {
      const p = (S.time * 0.7 + i * 0.33) % 1;
      ctx.globalAlpha = Math.max(0, 1 - p); ctx.fillStyle = '#cfe0ff';
      ctx.fillText('z', bx + 20 + p * 16, by - 16 - p * 22);
    }
    ctx.globalAlpha = 1;
  }

  function drawDrones() {
    S.buildings.forEach(b => {
      if (b.type !== 'drone') return;
      const cf = CONF[b.type];
      const x = b.x === undefined ? cx(b.c) : b.x;
      const y = (b.y === undefined ? cy(b.r) : b.y) + Math.sin((b.wob || 0) * 0.6) * 2;
      if (S.selected === b) {                      // 活动半径
        ctx.strokeStyle = 'rgba(86,225,255,.35)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx(b.c), cy(b.r), rngOf(b, cf), 0, 6.3); ctx.stroke();
      }
      ctx.save(); ctx.translate(x, y);
      ctx.fillStyle = 'rgba(0,0,0,.25)';
      ctx.beginPath(); ctx.ellipse(0, 13, 11, 4, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = CAT_COLOR[cf.cat];
      roundRect(-15, -9, 30, 18, 8); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#8ff';
      ctx.beginPath(); ctx.arc(-9, -11, 3.5, 0, 6.3); ctx.arc(9, -11, 3.5, 0, 6.3); ctx.fill();
      drawGlyph(ctx, 'drone', false, 0);
      const tier = b.level >= 9 ? '#d38bff' : b.level >= 5 ? '#ffcc4d' : '#cfe0ff';
      ctx.fillStyle = 'rgba(0,0,0,.6)'; roundRect(-14, 8, 28, 10, 5); ctx.fill();
      ctx.strokeStyle = tier; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = tier; ctx.font = 'bold 8px system-ui';
      ctx.fillText('Lv.' + b.level, 0, 13.5);
      ctx.restore();
    });
  }

  function drawGuards() {
    S.buildings.forEach(b => {
      if (b.type !== 'guard') return;
      const cf = CONF[b.type];
      const x = b.x === undefined ? cx(b.c) : b.x;
      const y = b.y === undefined ? cy(b.r) : b.y;
      if (S.selected === b) {                      // 活动半径
        ctx.strokeStyle = 'rgba(86,225,255,.35)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx(b.c), cy(b.r), rngOf(b, cf), 0, 6.3); ctx.stroke();
      }
      ctx.save(); ctx.translate(x, y);
      if (b.dead) {                                // 阵亡：等待复活
        ctx.globalAlpha = .35;
        ctx.fillStyle = '#5b6070'; roundRect(-15, -10, 30, 20, 8); ctx.fill();
        ctx.font = '14px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#cfe0ff'; ctx.globalAlpha = .8;
        ctx.fillText(Math.ceil(b.respawnT) + 's', 0, 1);
        ctx.globalAlpha = 1; ctx.restore(); return;
      }
      ctx.fillStyle = 'rgba(0,0,0,.25)';
      ctx.beginPath(); ctx.ellipse(0, 14, 11, 4, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = CAT_COLOR[cf.cat];
      roundRect(-16, -10, 32, 20, 8); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 2; ctx.stroke();
      drawGlyph(ctx, 'guard', false, 0);
      const tier = b.level >= 9 ? '#d38bff' : b.level >= 5 ? '#ffcc4d' : '#cfe0ff';
      ctx.fillStyle = 'rgba(0,0,0,.6)'; roundRect(-15, 9, 30, 10, 5); ctx.fill();
      ctx.strokeStyle = tier; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = tier; ctx.font = 'bold 8px system-ui';
      ctx.fillText('Lv.' + b.level, 0, 14.5);
      ctx.restore();
      const w = 34, ratio = Math.max(0, b.hp / b.maxHp);   // 血条
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(x - w / 2, y - 26, w, 4);
      ctx.fillStyle = '#ffd08a'; ctx.fillRect(x - w / 2, y - 26, w * ratio, 4);
    });
  }

  function drawGhosts() {
    S.ghosts.forEach(g => {
      const s = g.cfg.scale, x = g.x, y = g.y + Math.sin(g.wob) * 2;
      ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
      ctx.fillStyle = 'rgba(0,0,0,.28)';
      ctx.beginPath(); ctx.ellipse(0, 16, 14, 5, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = g.hitFlash > 0 ? '#fff' : (g.poisonT > 0 ? '#8fd45a' : (g.slow > 0 ? '#6fd8ff' :
        (g.cfg.king ? '#e0455f' : (g.cfg.boss ? '#ff5f9e' : '#a06bff'))));
      ctx.beginPath();
      ctx.moveTo(-13, 12);
      ctx.quadraticCurveTo(-15, -12, 0, -14);
      ctx.quadraticCurveTo(15, -12, 13, 12);
      ctx.quadraticCurveTo(8, 6, 3, 12);
      ctx.quadraticCurveTo(0, 6, -3, 12);
      ctx.quadraticCurveTo(-8, 6, -13, 12);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(-5, -3, 3.4, 0, 6.3); ctx.arc(5, -3, 3.4, 0, 6.3); ctx.fill();
      ctx.fillStyle = '#241338';
      ctx.beginPath(); ctx.arc(-5, -3, 1.6, 0, 6.3); ctx.arc(5, -3, 1.6, 0, 6.3); ctx.fill();
      if (g.cfg.boss) {
        ctx.fillStyle = '#ffe9a8';
        ctx.beginPath(); ctx.moveTo(-12, -10); ctx.lineTo(-9, -20); ctx.lineTo(-5, -11); ctx.fill();
        ctx.beginPath(); ctx.moveTo(12, -10); ctx.lineTo(9, -20); ctx.lineTo(5, -11); ctx.fill();
      }
      if (g.cfg.king) {                    // 王冠 + 光环
        ctx.strokeStyle = 'rgba(255,204,77,.5)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(0, 0, 17 + Math.sin(S.time * 3) * 1.5, 0, 6.3); ctx.stroke();
        ctx.fillStyle = '#ffcc4d';
        ctx.beginPath();
        ctx.moveTo(-11, -12); ctx.lineTo(-11, -21); ctx.lineTo(-6, -15);
        ctx.lineTo(0, -23); ctx.lineTo(6, -15); ctx.lineTo(11, -21); ctx.lineTo(11, -12);
        ctx.closePath(); ctx.fill();
      }
      if (g.frozen > 0) {              // 冻结：冰壳
        ctx.strokeStyle = 'rgba(159,230,255,.9)'; ctx.lineWidth = 2;
        roundRect(-16, -17, 32, 34, 8); ctx.stroke();
      }
      if (g.markMul > 1) {             // 被聚光灯标记
        ctx.strokeStyle = 'rgba(255,220,120,.9)'; ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.arc(0, 0, 19, 0, 6.3); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
      const w = 26 * s;
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x - w / 2, y - 22 * s, w, 4);
      ctx.fillStyle = '#ff6b6b'; ctx.fillRect(x - w / 2, y - 22 * s, w * Math.max(0, g.hp / g.maxHp), 4);
    });
  }

  function drawBullets() {
    S.bullets.forEach(b => {
      const ice = b.kind === 'ice';
      ctx.fillStyle = ice ? '#bff0ff' : '#ffee9c';
      ctx.beginPath(); ctx.arc(b.x, b.y, 3.5, 0, 6.3); ctx.fill();
      ctx.fillStyle = ice ? 'rgba(150,230,255,.35)' : 'rgba(255,238,156,.35)';
      ctx.beginPath(); ctx.arc(b.x, b.y, 7, 0, 6.3); ctx.fill();
    });
  }

  function drawFx() {
    S.fx.forEach(f => {
      const a = Math.max(0, f.life / f.max);
      if (f.ring) {                              // 爆炸 / 磁暴冲击波
        ctx.globalAlpha = a * .9; ctx.strokeStyle = f.color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(f.ring[0], f.ring[1], f.ring[2] * (1.2 - a * 0.2), 0, 6.3); ctx.stroke();
        ctx.globalAlpha = 1; return;
      }
      if (f.line) {
        ctx.globalAlpha = a; ctx.strokeStyle = f.color; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(f.line[0], f.line[1]); ctx.lineTo(f.line[2], f.line[3]); ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (f.text) {
        ctx.globalAlpha = a; ctx.fillStyle = f.color;
        ctx.font = 'bold 15px system-ui'; ctx.textAlign = 'center';
        ctx.fillText(f.text, f.x, f.y); ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = a; ctx.fillStyle = f.color;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 6.3); ctx.fill(); ctx.globalAlpha = 1;
      }
    });
  }

  function drawPreview() {
    if (!S.placing || !S.hover) return;
    const { c, r } = S.hover;
    if (!grid[r] || grid[r][c] === undefined) return;
    const ok = canBuild(c, r) && S.gold >= CONF[S.placing].cost[0];
    const x = cx(c), y = cy(r);
    ctx.globalAlpha = .65;
    ctx.fillStyle = ok ? 'rgba(86,225,255,.25)' : 'rgba(255,95,109,.25)';
    roundRect(x - 20, y - 20, 40, 40, 10); ctx.fill();
    ctx.globalAlpha = 1;
    if (CONF[S.placing].range) {
      ctx.strokeStyle = ok ? '#56e1ff' : '#ff5f6d';
      ctx.beginPath(); ctx.arc(x, y, CONF[S.placing].range[0] * TILE, 0, 6.3); ctx.stroke();
    }
    if (ok) {
      ctx.save(); ctx.translate(x, y);
      ctx.fillStyle = CAT_COLOR[CONF[S.placing].cat]; roundRect(-18, -18, 36, 36, 9); ctx.fill();
      drawGlyph(ctx, S.placing, false, 0);
      ctx.restore();
    } else {
      ctx.fillStyle = '#ff5f6d'; ctx.font = '22px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('✖', x, y);
    }
  }

  function roundRectOn(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // 矢量图标（统一替代 emoji）：棋盘建筑、无人机、保安、放置预览、建造栏卡片、详情面板共用
  function drawGlyph(g, type, dim, angle) {
    g.save();
    if (dim) g.globalAlpha = 0.42;
    g.lineWidth = 2.2; g.lineCap = 'round'; g.lineJoin = 'round';
    const gun = type === 'turret' || type === 'sniper' || type === 'flame' || type === 'frost' || type === 'tesla';
    if (gun) {
      g.save(); g.rotate(angle || 0);
      g.fillStyle = ACCENT[type] || '#ffffff';
      if (type === 'sniper') { roundRectOn(g, 0, -3, 26, 6, 3); g.fill(); }
      else if (type === 'flame') { roundRectOn(g, 0, -6, 15, 12, 5); g.fill(); }
      else if (type === 'tesla') { roundRectOn(g, 0, -3, 8, 6, 2); g.fill(); }
      else { roundRectOn(g, 0, -5, 22, 10, 4); g.fill(); }
      g.restore();
      g.fillStyle = '#1b2247'; g.beginPath(); g.arc(0, 0, type === 'tesla' ? 5 : 7, 0, 6.3); g.fill();
    }
    g.fillStyle = '#ffffff'; g.strokeStyle = '#ffffff';
    switch (type) {
      case 'turret':
        g.beginPath(); g.arc(0, 0, 3, 0, 6.3); g.stroke(); break;
      case 'sniper':
        g.beginPath(); g.arc(0, 0, 8, 0, 6.3); g.stroke();
        g.beginPath(); g.moveTo(-11, 0); g.lineTo(11, 0); g.moveTo(0, -11); g.lineTo(0, 11); g.stroke(); break;
      case 'flame':
        g.beginPath(); g.moveTo(0, 9); g.bezierCurveTo(-9, -1, -4, -12, 0, -9); g.bezierCurveTo(4, -12, 9, -1, 0, 9); g.fill(); break;
      case 'frost':
      case 'freezer':
        for (let a = 0; a < 3; a++) { g.save(); g.rotate(a * Math.PI / 3); g.beginPath(); g.moveTo(0, -11); g.lineTo(0, 11); g.stroke(); g.beginPath(); g.moveTo(0, -11); g.lineTo(-3, -7); g.moveTo(0, -11); g.lineTo(3, -7); g.stroke(); g.restore(); } break;
      case 'tesla':
        g.beginPath(); g.moveTo(3, -10); g.lineTo(-4, 1); g.lineTo(1, 1); g.lineTo(-3, 10); g.lineTo(5, -2); g.lineTo(0, -2); g.closePath(); g.fill(); break;
      case 'trap':
        g.beginPath(); g.arc(0, 0, 7, 0, 6.3); g.stroke();
        for (let a = 0; a < 8; a++) { g.save(); g.rotate(a * Math.PI / 4); g.beginPath(); g.moveTo(7, 0); g.lineTo(11, 0); g.stroke(); g.restore(); } break;
      case 'barrier':
        [[-8, -7], [0, -7], [8, -7], [-4, 0], [4, 0], [-8, 7], [0, 7], [8, 7]].forEach(p => { roundRectOn(g, p[0] - 4, p[1] - 2, 8, 4, 1); g.fill(); }); break;
      case 'mine':
        g.beginPath(); g.arc(0, 0, 9, 0, 6.3); g.fill();
        g.strokeStyle = '#1b2247'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, -5); g.lineTo(0, 5); g.moveTo(-5, -2); g.lineTo(0, -5); g.lineTo(5, -2); g.stroke(); break;
      case 'vault':
        g.beginPath(); g.moveTo(-10, -2); g.lineTo(0, -10); g.lineTo(10, -2); g.closePath(); g.fill();
        roundRectOn(g, -9, -2, 18, 10, 2); g.fill();
        g.fillStyle = '#1b2247'; roundRectOn(g, -2, 1, 4, 5, 1); g.fill(); break;
      case 'gen':
        roundRectOn(g, -9, -7, 16, 14, 3); g.stroke();
        g.fillRect(7, -3, 3, 6);
        g.beginPath(); g.moveTo(1, -6); g.lineTo(-4, 1); g.lineTo(0, 1); g.lineTo(-2, 6); g.lineTo(4, -2); g.lineTo(0, -2); g.closePath(); g.fill(); break;
      case 'medic':
        g.fillRect(-3, -9, 6, 18); g.fillRect(-9, -3, 18, 6); break;
      case 'workshop':
      case 'transformer':
        g.beginPath(); g.arc(0, 0, 9, 0, 6.3); g.stroke();
        for (let a = 0; a < 8; a++) { g.save(); g.rotate(a * Math.PI / 4); g.beginPath(); g.moveTo(9, 0); g.lineTo(12, 0); g.stroke(); g.restore(); }
        if (type === 'transformer') { g.beginPath(); g.moveTo(2, -6); g.lineTo(-3, 1); g.lineTo(1, 1); g.lineTo(-2, 7); g.lineTo(4, -2); g.lineTo(0, -2); g.closePath(); g.fill(); }
        else { g.beginPath(); g.arc(0, 0, 3, 0, 6.3); g.fill(); } break;
      case 'shield':
      case 'guard':
        g.beginPath(); g.moveTo(0, -10); g.lineTo(9, -5); g.lineTo(9, 3); g.quadraticCurveTo(9, 9, 0, 11); g.quadraticCurveTo(-9, 9, -9, 3); g.lineTo(-9, -5); g.closePath(); g.fill();
        if (type === 'guard') { g.fillStyle = '#1b2247'; g.beginPath(); g.arc(0, -1, 3.5, 0, 6.3); g.fill(); } break;
      case 'bomb':
        g.beginPath(); g.arc(0, 2, 8, 0, 6.3); g.fill();
        g.lineWidth = 2; g.beginPath(); g.moveTo(6, -4); g.quadraticCurveTo(10, -8, 8, -12); g.stroke();
        g.beginPath(); g.arc(8, -12, 1.6, 0, 6.3); g.fill(); break;
      case 'poison':
        g.beginPath(); g.moveTo(0, -10); g.bezierCurveTo(8, -2, 7, 9, 0, 9); g.bezierCurveTo(-7, 9, -8, -2, 0, -10); g.closePath(); g.fill(); break;
      case 'beam':
        g.beginPath(); g.arc(0, 0, 5, 0, 6.3); g.fill();
        for (let a = 0; a < 8; a++) { g.save(); g.rotate(a * Math.PI / 4); g.beginPath(); g.moveTo(0, -8); g.lineTo(0, -11); g.stroke(); g.restore(); } break;
      case 'magnet':
        g.lineWidth = 4;
        g.beginPath(); g.moveTo(-8, -7); g.lineTo(-8, 2); g.arc(0, 2, 8, Math.PI, 0, true); g.lineTo(8, -7); g.stroke();
        g.fillStyle = '#ffffff'; g.fillRect(-10, -7, 4, 5); g.fillRect(6, -7, 4, 5); break;
      case 'field':
        g.beginPath(); g.moveTo(-8, -9); g.lineTo(8, -9); g.lineTo(0, 0); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(-8, 9); g.lineTo(8, 9); g.lineTo(0, 0); g.closePath(); g.fill(); break;
      case 'drone':
        g.lineWidth = 1.6;
        [[-9, -7], [9, -7], [-9, 7], [9, 7]].forEach(p => { g.beginPath(); g.moveTo(0, 0); g.lineTo(p[0], p[1]); g.stroke(); });
        [[-9, -7], [9, -7], [-9, 7], [9, 7]].forEach(p => { g.beginPath(); g.arc(p[0], p[1], 3, 0, 6.3); g.stroke(); });
        g.beginPath(); g.arc(0, 0, 4, 0, 6.3); g.fill(); break;
      case 'decoy':
        g.beginPath(); g.arc(0, -2, 8, Math.PI, 0); g.lineTo(8, 8);
        g.quadraticCurveTo(5, 4, 2, 8); g.quadraticCurveTo(0, 4, -2, 8); g.quadraticCurveTo(-5, 4, -8, 8); g.closePath(); g.fill();
        g.fillStyle = '#1b2247'; g.beginPath(); g.arc(-3, -2, 1.6, 0, 6.3); g.arc(3, -2, 1.6, 0, 6.3); g.fill(); break;
      case 'bank':
        g.lineWidth = 1.8;
        for (let i = 0; i < 3; i++) { g.beginPath(); g.ellipse(0, 6 - i * 6, 9, 3, 0, 0, 6.3); g.stroke(); } break;
      case 'spikes':
        g.beginPath(); g.moveTo(-9, 9); g.lineTo(-11, -9); g.lineTo(-7, 9); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(-2, 9); g.lineTo(0, -11); g.lineTo(2, 9); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(7, 9); g.lineTo(9, -9); g.lineTo(11, 9); g.closePath(); g.fill(); break;
      case 'portal':
        for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(0, 0, 4 + k * 4, k * 2.1, k * 2.1 + 2.4); g.stroke(); } break;
      case 'clock':
        g.beginPath(); g.arc(0, 0, 9, 0, 6.3); g.stroke();
        g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -6); g.moveTo(0, 0); g.lineTo(5, 2); g.stroke(); break;
      case 'amplifier':
        g.beginPath(); g.moveTo(-9, -4); g.lineTo(-4, -4); g.lineTo(2, -9); g.lineTo(2, 9); g.lineTo(-4, 4); g.lineTo(-9, 4); g.closePath(); g.fill();
        g.beginPath(); g.arc(4, 0, 4, -0.8, 0.8); g.stroke();
        g.beginPath(); g.arc(4, 0, 8, -0.8, 0.8); g.stroke(); break;
      case 'radar':
        g.beginPath(); g.arc(0, 2, 9, Math.PI, 2 * Math.PI); g.stroke();
        g.beginPath(); g.moveTo(-9, 2); g.lineTo(9, 2); g.stroke();
        g.beginPath(); g.arc(0, -7, 2.4, 0, 6.3); g.fill(); break;
      case 'critcore':
        roundRectOn(g, -8, -8, 16, 16, 3); g.stroke();
        g.beginPath(); g.arc(-3, -3, 1.6, 0, 6.3); g.arc(3, 3, 1.6, 0, 6.3); g.arc(3, -3, 1.6, 0, 6.3); g.arc(-3, 3, 1.6, 0, 6.3); g.fill(); break;
      case 'spotlight':
        g.beginPath(); g.arc(-8, -8, 4, 0, 6.3); g.fill();
        g.beginPath(); g.moveTo(-5, -5); g.lineTo(11, 1); g.lineTo(11, 10); g.closePath(); g.fill(); break;
      case 'bed':
        roundRectOn(g, -11, -4, 22, 10, 3); g.stroke();
        g.beginPath(); g.moveTo(-11, -4); g.lineTo(-11, -10); g.lineTo(-6, -10); g.lineTo(-6, -4); g.stroke(); break;
      case 'fix':
        g.save(); g.rotate(-0.6);
        g.lineWidth = 3; g.beginPath(); g.arc(6, -6, 5, 0, 6.3); g.stroke();
        g.beginPath(); g.moveTo(2, -2); g.lineTo(-8, 8); g.stroke(); g.restore(); break;
      default:
        g.beginPath(); g.arc(0, 0, 7, 0, 6.3); g.fill();
    }
    g.restore();
  }

  // 家具矢量插画（k 决定种类）—— 带阴影 / 描边 / 渐变的贴纸插画风
  function drawFurniture(g, k) {
    const shadow = () => { g.fillStyle = 'rgba(0,0,0,.22)'; g.beginPath(); g.ellipse(0, 15, 14, 4.5, 0, 0, 6.3); g.fill(); };
    const stroke = (col) => { g.strokeStyle = col || 'rgba(45,28,20,.38)'; g.lineWidth = 1.4; g.lineJoin = 'round'; g.stroke(); };
    const vg = (x0, y0, x1, y1, c0, c1) => { const gr = g.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, c0); gr.addColorStop(1, c1); return gr; };
    switch (k) {
      case 'sofa': {
        shadow();
        g.fillStyle = vg(0, -12, 0, 2, '#eba487', '#d9876a'); roundRectOn(g, -16, -12, 32, 13, 5); g.fill(); stroke();
        g.fillStyle = vg(0, -2, 0, 11, '#f0a384', '#d9876a'); roundRectOn(g, -16, -2, 32, 13, 5); g.fill(); stroke();
        g.fillStyle = '#cf7d5c'; roundRectOn(g, -17, -7, 7, 17, 3); g.fill(); stroke();
        g.fillStyle = '#cf7d5c'; roundRectOn(g, 10, -7, 7, 17, 3); g.fill(); stroke();
        g.fillStyle = 'rgba(255,255,255,.20)'; roundRectOn(g, -12, -9, 11, 7, 3); g.fill(); roundRectOn(g, 1, -9, 11, 7, 3); g.fill();
        break;
      }
      case 'tv': {
        shadow();
        g.fillStyle = '#3a4059'; roundRectOn(g, -5, 8, 10, 4, 1); g.fill(); stroke();
        g.fillStyle = vg(0, -13, 0, 9, '#3b4160', '#262b40'); roundRectOn(g, -15, -13, 30, 22, 4); g.fill(); stroke();
        g.fillStyle = vg(-12, -10, 12, 8, '#86d3ff', '#3a7fd6'); roundRectOn(g, -12, -10, 24, 16, 2); g.fill();
        g.fillStyle = 'rgba(255,255,255,.28)'; g.beginPath(); g.moveTo(-10, -8); g.lineTo(-2, -8); g.lineTo(-8, 6); g.lineTo(-10, 6); g.closePath(); g.fill();
        break;
      }
      case 'plant': {
        shadow();
        g.fillStyle = vg(0, 2, 0, 14, '#d3985a', '#b9773d'); g.beginPath(); g.moveTo(-7, 2); g.lineTo(7, 2); g.lineTo(5, 14); g.lineTo(-5, 14); g.closePath(); g.fill(); stroke();
        g.fillStyle = '#c98a4b'; roundRectOn(g, -8, 0, 16, 3, 1); g.fill(); stroke();
        g.strokeStyle = '#2f8a55'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 2); g.lineTo(-6, -9); g.moveTo(0, 2); g.lineTo(7, -11); g.moveTo(0, 2); g.lineTo(0, -14); g.stroke();
        [[-6, -9, 5], [7, -11, 5], [0, -14, 6], [3, -7, 4], [-3, -5, 4]].forEach(p => {
          const gg = g.createRadialGradient(p[0] - 1, p[1] - 1, 1, p[0], p[1], p[2]); gg.addColorStop(0, '#6fc98c'); gg.addColorStop(1, '#3a8f5b');
          g.fillStyle = gg; g.beginPath(); g.arc(p[0], p[1], p[2], 0, 6.3); g.fill();
        });
        break;
      }
      case 'bear': {
        shadow();
        g.fillStyle = '#c98a4b'; g.beginPath(); g.arc(-7, -8, 5, 0, 6.3); g.fill(); stroke();
        g.beginPath(); g.arc(7, -8, 5, 0, 6.3); g.fill(); stroke();
        const gg = g.createRadialGradient(-3, -3, 2, 0, 0, 12); gg.addColorStop(0, '#e3aa6c'); gg.addColorStop(1, '#c98a4b');
        g.fillStyle = gg; g.beginPath(); g.arc(0, 0, 12, 0, 6.3); g.fill(); stroke();
        g.fillStyle = '#f3d3a8'; g.beginPath(); g.arc(0, 3, 5, 0, 6.3); g.fill();
        g.fillStyle = '#3a2418'; g.beginPath(); g.arc(-4, -1, 1.8, 0, 6.3); g.arc(4, -1, 1.8, 0, 6.3); g.fill();
        g.beginPath(); g.arc(0, 2, 1.7, 0, 6.3); g.fill();
        break;
      }
      case 'chair': {
        shadow();
        g.fillStyle = vg(0, -12, 0, 8, '#caa05f', '#a9763f'); roundRectOn(g, -9, -12, 14, 20, 3); g.fill(); stroke();
        g.fillStyle = '#bd8f4f'; roundRectOn(g, -11, -2, 20, 7, 2); g.fill(); stroke();
        g.fillStyle = '#8a5d32'; roundRectOn(g, -11, 5, 4, 9, 1); g.fill(); roundRectOn(g, 7, 5, 4, 9, 1); g.fill();
        break;
      }
      case 'plate': {
        shadow();
        const gg = g.createRadialGradient(-3, -3, 2, 0, 2, 14); gg.addColorStop(0, '#ffffff'); gg.addColorStop(1, '#cdd4e2');
        g.fillStyle = gg; g.beginPath(); g.arc(0, 2, 14, 0, 6.3); g.fill(); stroke();
        g.fillStyle = '#dbe1ee'; g.beginPath(); g.arc(0, 2, 9, 0, 6.3); g.fill();
        g.fillStyle = '#ffb45e'; g.beginPath(); g.arc(0, 2, 5, 0, 6.3); g.fill();
        g.strokeStyle = '#9aa6c2'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(15, -6); g.lineTo(15, 9); g.moveTo(13, -6); g.lineTo(13, 0); g.moveTo(17, -6); g.lineTo(17, 0); g.stroke();
        break;
      }
      case 'shower': {
        shadow();
        g.strokeStyle = '#9aa6c2'; g.lineWidth = 3; g.beginPath(); g.moveTo(0, -15); g.lineTo(0, -8); g.stroke();
        g.fillStyle = vg(0, -8, 0, -3, '#c2cbdd', '#9aa6c2'); roundRectOn(g, -7, -8, 14, 5, 2); g.fill(); stroke();
        g.fillStyle = '#8b96ad'; for (let i = -5; i <= 5; i += 3) { g.beginPath(); g.arc(i, -3, 1, 0, 6.3); g.fill(); }
        g.strokeStyle = 'rgba(120,200,255,.85)'; g.lineWidth = 1.4; g.beginPath();
        for (let i = -4; i <= 4; i += 2) { g.moveTo(i * 1.2, 0); g.lineTo(i * 1.2, 9); } g.stroke();
        g.fillStyle = 'rgba(120,200,255,.30)'; g.beginPath(); g.ellipse(0, 12, 8, 2.5, 0, 0, 6.3); g.fill();
        break;
      }
      case 'books': {
        shadow();
        [['#e2553f', -8], ['#5b9bff', 0], ['#37b97a', 8]].forEach(b => {
          g.fillStyle = b[0]; roundRectOn(g, -13, b[1] - 5, 26, 10, 2); g.fill(); stroke();
          g.fillStyle = 'rgba(255,255,255,.18)'; roundRectOn(g, -13, b[1] - 5, 26, 3, 2); g.fill();
          g.fillStyle = '#f3ead2'; roundRectOn(g, 9, b[1] - 4, 3, 8, 1); g.fill();
        });
        break;
      }
      case 'fridge': {
        shadow();
        g.fillStyle = vg(-10, -14, 10, -14, '#eef2f8', '#c3ccdd'); roundRectOn(g, -10, -14, 20, 28, 4); g.fill(); stroke();
        g.strokeStyle = 'rgba(120,130,150,.6)'; g.lineWidth = 1.4; g.beginPath(); g.moveTo(-10, -2); g.lineTo(10, -2); g.stroke();
        g.fillStyle = '#9aa6c2'; roundRectOn(g, 4, -11, 2, 6, 1); g.fill(); roundRectOn(g, 4, 1, 2, 6, 1); g.fill();
        g.fillStyle = 'rgba(120,255,180,.75)'; g.beginPath(); g.arc(-6, -9, 1.6, 0, 6.3); g.fill();
        break;
      }
      case 'cart': {
        shadow();
        g.fillStyle = vg(0, -4, 0, 8, '#c2cbdd', '#9aa6c2'); g.beginPath(); g.moveTo(-12, -2); g.lineTo(8, -2); g.lineTo(4, 8); g.lineTo(-12, 8); g.closePath(); g.fill(); stroke();
        g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1; g.beginPath();
        g.moveTo(-8, -2); g.lineTo(-9, 8); g.moveTo(-4, -2); g.lineTo(-5, 8); g.moveTo(0, -2); g.lineTo(-1, 8); g.moveTo(4, -2); g.lineTo(1, 8); g.stroke();
        g.strokeStyle = '#9aa6c2'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(8, -2); g.lineTo(11, -10); g.lineTo(3, -10); g.stroke();
        g.fillStyle = '#4a4f63'; g.beginPath(); g.arc(-8, 11, 2.4, 0, 6.3); g.arc(2, 11, 2.4, 0, 6.3); g.fill();
        break;
      }
    }
  }

  // 把图标画到一张小 canvas 上（建造栏卡片 / 详情面板复用 drawGlyph）
  function paintIcon(canvas, type) {
    if (!canvas || !canvas.getContext) return;
    const g = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    g.clearRect(0, 0, w, h);
    const cat = (type === 'bed' || type === 'fix') ? null : (CONF[type] && CONF[type].cat);
    if (cat && CAT_COLOR[cat]) { g.fillStyle = CAT_COLOR[cat]; roundRectOn(g, 4, 4, w - 8, h - 8, 8); g.fill(); }
    else { g.fillStyle = '#2a3358'; roundRectOn(g, 4, 4, w - 8, h - 8, 8); g.fill(); }
    g.save(); g.translate(w / 2, h / 2); g.scale(Math.min(w, h) / 40 * 1.05, Math.min(w, h) / 40 * 1.05);
    drawGlyph(g, type, false, 0); g.restore();
  }

  // ================= UI =================
  function syncUI() {
    const inc = _income, mx = _mx;
    el.gold.textContent = Math.floor(S.gold);
    el.income.textContent = '+' + inc.rate.toFixed(1) + '/s';
    el.power.textContent = _pinfo.use + ' / ' + _pinfo.cap;
    el.powerTip.textContent = _pinfo.ok ? T().ui.powerOk : T().ui.powerLow;
    el.powerTip.style.color = _pinfo.ok ? 'var(--dim)' : 'var(--red)';
    el.wave.textContent = S.wave + ' / ' + (S.endless ? '∞' : MAX_WAVE);
    el.waveTip.textContent = S.over ? T().ui.over : S.waveActive ?
      fill(T().ui.waveLeft, { n: S.ghosts.filter(g => !g.king).length + S.spawnQueue.length }) :
      fill(T().ui.waveNext, { n: Math.max(0, Math.ceil(S.waveTimer)) });
    const kings = S.ghosts.filter(g => g.king);
    el.kingStat.classList.toggle('hidden', !kings.length);
    if (kings.length) {
      const k = kings.reduce((a, b) => a.hp <= b.hp ? a : b);
      el.kingInfo.textContent = kings.length + ' 👑 ' + Math.ceil(k.hp) + '/' + k.maxHp;
    }
    el.hp.textContent = Math.ceil(S.hp);
    el.hpMax.textContent = Math.ceil(mx);
    el.bar.style.width = (S.hp / mx * 100) + '%';
    el.bar.style.background = S.hp / mx > .5 ? 'linear-gradient(90deg,#6ee7a0,#4ade80)' :
      S.hp / mx > .25 ? 'linear-gradient(90deg,#ffd27a,#ffcc4d)' : 'linear-gradient(90deg,#ff8a8a,#ff5f6d)';

    document.querySelectorAll('.card').forEach(card => {
      const a = card.dataset.act;
      card.classList.toggle('active', S.placing === a);
      const cost = costOf(a);
      const cb = card.querySelector('[data-cost]');
      if (cb) cb.textContent = cost === null ? 'MAX' : cost;
      card.classList.toggle('poor', cost !== null && S.gold < cost);
      if (a === 'fix') card.querySelector('.name').textContent = S.hp >= maxHp() ? T().ui.fortify : T().ui.fix;
      if (a === 'bed' && cost === null) card.querySelector('.name').textContent = T().ui.bedMax;
    });
    if (S.selected) {
      const b = S.selected, cf = CONF[b.type], L = b.level, maxed = L >= MAXLV;
      paintIcon(el.pIco, b.type); el.pName.textContent = cf.name;
      el.pLv.textContent = `Lv.${L} / ${MAXLV}`;
      el.pLv.style.color = maxed ? '#d38bff' : L >= 5 ? '#ffcc4d' : 'var(--gold)';
      el.pDesc.innerHTML = cf.desc(b) +
        (cf.range ? `<br>${fill(T().ui.rangePower, { r: D(cf.range[L - 1]), u: cf.use ? cf.use[L - 1] : 0 })}` : '') +
        (maxed ? `<br><span style="color:#d38bff">${T().ui.maxed}</span>` :
          `<br><span style="color:#97a0cc">${T().ui.nextLv}</span>${cf.desc({ type: b.type, level: L + 1 })}`);
      el.pUp.disabled = maxed || S.gold < cf.cost[L];
      el.pUpCost.textContent = maxed ? 'MAX' : cf.cost[L];
      el.pSellBack.textContent = Math.floor(totalSpent(b) * 0.6);
    }
  }
  function costOf(a) {
    if (a === 'bed') return bedCost();
    if (a === 'fix') return S.hp >= maxHp() ? reinforceCost() : fixCost();
    return CONF[a].cost[0];
  }

  function selectBuilding(b) {
    S.selected = b;
    if (!b) { el.panel.classList.add('hidden'); return; }
    el.panel.classList.remove('hidden');
    syncUI();
  }

  // 悬停说明（建造栏卡片）
  function showTip(card, a) {
    let name, desc;
    if (a === 'bed') { name = T().ui.bedUp; desc = '💰 升级床铺，每秒被动金币收益更高（3 → 18/s）'; }
    else if (a === 'fix') { name = T().ui.fix; desc = S.hp >= maxHp() ? '🔧 床位已满级，可「加固」+300 上限' : '🔨 立刻修复床位 35% 耐久'; }
    else { const cf = CONF[a]; name = cf.name; desc = cf.desc({ type: a, level: 1 }); }
    const cost = costOf(a);
    el.tip.innerHTML = `<div class="tip-h">${name} <span class="tip-c">💰${cost === null ? '—' : cost}</span></div><div class="tip-b">${desc}</div>`;
    el.tip.classList.add('show');
    const r = card.getBoundingClientRect(), w = el.tip.offsetWidth, h = el.tip.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    el.tip.style.left = left + 'px';
    el.tip.style.top = (r.top - h - 8) + 'px';
  }
  function hideTip() { el.tip.classList.remove('show'); }

  // ================= 交互 =================
  function toTile(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (W / rect.width), y = (e.clientY - rect.top) * (H / rect.height);
    return { c: Math.floor(x / TILE), r: Math.floor(y / TILE) };
  }
  canvas.addEventListener('mousemove', e => { S.hover = toTile(e); });
  canvas.addEventListener('mouseleave', () => { S.hover = null; });
  canvas.addEventListener('click', e => {
    if (!S.running) return;
    const { c, r } = toTile(e);
    if (S.placing) {
      if (place(S.placing, c, r)) { if (S.gold < CONF[S.placing].cost[0]) setPlacing(null); }
      else if (grid[r] && grid[r][c] === FURN) toast(T().toast.furniture, '#97a0cc');
      return;
    }
    selectBuilding(S.occupied.get(ck(c, r)) || null);
  });
  canvas.addEventListener('contextmenu', e => { e.preventDefault(); setPlacing(null); selectBuilding(null); });

  function setPlacing(a) {
    S.placing = a;
    el.hint.textContent = a ? fill(T().ui.placeHint, { name: CONF[a].name }) : T().ui.idleHint;
    syncUI();
  }

  el.dock.addEventListener('click', e => {
    const btn = e.target.closest('.card');
    if (!btn || !S.running) return;
    const a = btn.dataset.act;
    if (a === 'bed') { upgradeBed(); setPlacing(null); return; }
    if (a === 'fix') { repairBed(); setPlacing(null); return; }
    setPlacing(S.placing === a ? null : a);
    selectBuilding(null);
  });
  el.tabs.addEventListener('click', e => {
    const t = e.target.closest('.tab'); if (!t) return;
    DOCK_CAT = t.dataset.cat; buildTabs(); buildDock(); syncUI();
  });
  el.dock.addEventListener('mouseover', e => {
    const card = e.target.closest('.card'); if (card) showTip(card, card.dataset.act);
  });
  el.dock.addEventListener('mouseout', e => {
    if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('.card')) hideTip();
  });
  el.pUp.addEventListener('click', () => { if (S.selected) upgradeBuilding(S.selected); });
  el.pSell.addEventListener('click', () => { if (S.selected) sellBuilding(S.selected); });

  $('btnSpeed').addEventListener('click', () => {
    S.speed = S.speed === 1 ? 2 : S.speed === 2 ? 3 : 1;
    $('btnSpeed').textContent = '▶ ' + S.speed + 'x';
  });
  $('btnPause').addEventListener('click', () => {
    S.paused = !S.paused;
    $('btnPause').textContent = S.paused ? T().ui.resume : T().ui.pause;
  });
  document.querySelectorAll('.langbtn').forEach(b => b.addEventListener('click', () => setLang(LANG === 'zh' ? 'en' : 'zh')));
  window.addEventListener('keydown', e => {
    if (e.key === 'l' || e.key === 'L') setLang(LANG === 'zh' ? 'en' : 'zh');
  });
  window.addEventListener('keydown', e => {
    if (!S.running) return;
    const i = e.key === '0' ? 9 : '123456789'.indexOf(e.key);
    if (i >= 0 && i < 10) {
      const a = CARDS[i];
      if (a === 'bed') upgradeBed();
      else if (a === 'fix') repairBed();
      else { setPlacing(S.placing === a ? null : a); selectBuilding(null); }
    } else if (e.key === 'Escape') { setPlacing(null); selectBuilding(null); }
    else if (e.code === 'Space') { e.preventDefault(); $('btnSpeed').click(); }
    else if (e.key === 'p' || e.key === 'P') $('btnPause').click();
  });

  const COACH_STEPS = [
    { zh: '👋 欢迎来到《躺平发育》！\n你躺在床上每秒自动赚金币。猛鬼会从右侧三扇门冲进来啃你的床——建塔挡住它们，保住床就赢。',
      en: '👋 Welcome to Lying Flat: Dorm Defense!\nYou earn gold every second while lying in bed. Ghosts storm in from the three right doors to eat your bed — build towers to stop them.' },
    { zh: '🏗️ 在下方【建造栏】选「炮台」→ 点房间空地放下。它会自动锁定最近的猛鬼开火，你不用管。注意顶部「电力」别超上限。',
      en: '🏗️ Pick a Turret from the build bar below → click an empty tile to place it. It auto-fires at the nearest ghost. Keep the Power stat under its cap.' },
    { zh: '🌊 金币够了就点建筑升级、或升级床涨收益。撑过 15 波即躺赢，之后还能进无尽模式。开干！',
      en: '🌊 Spend gold to upgrade towers or your bed for more income. Survive 15 waves to win, then try Endless. Let’s go!' }
  ];
  function showCoach() {
    let i = 0;
    const render = () => {
      el.coachBody.textContent = LANG === 'zh' ? COACH_STEPS[i].zh : COACH_STEPS[i].en;
      el.coachStep.textContent = (i + 1) + ' / ' + COACH_STEPS.length;
      el.coachNext.textContent = i === COACH_STEPS.length - 1 ? (LANG === 'zh' ? '开始躺平 ▶' : 'Start ▶') : (LANG === 'zh' ? '下一步 →' : 'Next →');
    };
    render();
    el.coach.classList.add('show');
    el.coachNext.onclick = () => {
      if (i < COACH_STEPS.length - 1) { i++; render(); }
      else { el.coach.classList.remove('show'); S.paused = false; }
    };
    S.paused = true;
  }
  function begin() {
    el.overlay.classList.remove('show'); el.overlay.classList.add('hidden');
    el.result.classList.remove('show'); el.result.classList.add('hidden');
    if (S.over && !S.won) reset();
    S.running = true; S.paused = false; S.over = false;
    if (S.endless) { S.hpBase += 600; S.hp = maxHp(); }
    if (!coached) { coached = true; showCoach(); }
  }
  $('btnStart').addEventListener('click', begin);
  $('btnAgain').addEventListener('click', () => {
    if (!S.won) { reset(); }
    else { S.endless = true; S.over = false; S.won = false; S.waveTimer = 10; S.waveActive = false; }
    begin();
  });

  // ================= 主循环 =================
  reset(); recomputeGlobals(); selectBuilding(null); applyLang();
  fitCanvas();                                   // 建造栏就位后再校准一次，确保与上下边缘对齐
  window.addEventListener('load', fitCanvas);
  if (window.requestAnimationFrame) requestAnimationFrame(fitCanvas);
  let last = performance.now(), acc = 0;
  function loop(now) {
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    if (S.running && !S.paused && !S.over) update(dt * S.speed);
    acc += dt;
    if (acc > 0.1) { syncUI(); acc = 0; }
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
