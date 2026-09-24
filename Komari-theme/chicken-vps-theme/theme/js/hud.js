// HUD：在线人数、排行榜、击倒播报、自己状态栏、横幅提示。

// 排行榜用 innerHTML 拼接，名字必须转义：探针鸡的名字来自各站点机器名
// （运营者可控），不转义就是 HTML 注入。
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

export class HUD {
  constructor() {
    this.$ = (id) => document.getElementById(id);
    this.online = this.$('online');
    this.webOnline = this.$('web-online');
    this.visitors = this.$('visitors');
    this.board = this.$('board');
    this.boardTitle = this.$('board-title');
    this.boardRows = this.$('board-rows');
    this.feed = this.$('feed');
    this.hpfill = this.$('hpfill');
    this.score = this.$('score');
    this.bridgeState = this.$('bridge-state');
    this.bridgeDetail = '尚未连接';
    this.bridgeState?.addEventListener('click', () => {
      this.banner(`伴生服务：${this.bridgeDetail}`, 3500);
    });
    this.meName = this.$('me-name');
    // ICONS 仅用于剥旧展示名的图标前缀（换图标功能已移除，存量带图标的名字过渡期兼容）
    this.ICONS = ['🐔', '🐥', '🐤', '🐣', '🦅', '🦆', '🦉', '👑', '🔥', '⚡',
      '⭐', '🌟', '💥', '🎯', '🥷', '🤖', '👻', '🤠', '🎃', '🌈',
      '🍀', '❤️', '🥚', '🍗', '🥇', '🐉', '🦊', '🐺'];
    this.myIcon = null;
    this.onProfile = null; // main.js 注入：patch => net.send({t:'profile', ...patch})
    this.meEdit = this.$('me-edit');
    this.nameEditor = this.$('me-name-editor');
    this.nameInput = this.$('me-name-input');
    // 名字旁 ✏️：弹出/收起改名浮层（换图标功能已移除）
    this.meEdit.addEventListener('click', () => this.toggleNameEditor());
    this.$('me-name-ok').addEventListener('click', () => this.submitName());
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submitName();
      else if (e.key === 'Escape') this.closeEditor();
    });
    this.koBanner = this.$('ko-banner');
    this.bannerTimer = null;
    this.probeWarn = this.$('probe-warn');
    this.probeOk = true;
    this.collapsed = true; // 啄倒榜默认收起，点击标题展开/收起
    this.rows = [];
    this.leftBoard = [];   // 离场玩家的啄倒记录（roster.left 下发，服务端只记 score>0）
    this._lastBoardSig = ''; // 榜单渲染差分签名：没变就不动 DOM
    this._lastBoardPaint = 0; // 上次真正写 DOM 的时间（节流上限）
    this.board.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.renderBoard(true);
    });
  }

  setMe(name) {
    const clean = String(name || '小鸡');
    this.meName.textContent = clean;
    // 旧展示名可能带「图标 + 空格」前缀（换图标功能已移除，存量名字过渡期兼容）：
    // 记下当前图标，预填改名框时剥掉
    const hit = this.ICONS.find(i => clean.startsWith(i + ' '));
    this.myIcon = hit || null;
  }

  setBridgeState(state, detail = '') {
    this.bridgeDetail = detail || this.bridgeDetail;
    if (!this.bridgeState) return;
    const labels = {
      connected: '在线',
      connecting: '连接中',
      reconnecting: '重连中',
      missing: '本地模式',
      error: '连接失败',
    };
    this.bridgeState.textContent = labels[state] || state;
    this.bridgeState.className = state;
    this.bridgeState.title = this.bridgeDetail;
  }

  // 名字旁 ✏️：弹出/收起改名浮层，打开时预填剥掉图标前缀后的名字
  toggleNameEditor() {
    const hidden = this.nameEditor.classList.toggle('hidden');
    if (!hidden) {
      const cur = this.meName.textContent || '';
      this.nameInput.value = this.myIcon ? cur.slice(this.myIcon.length + 1) : cur;
      this.nameInput.focus();
      this.nameInput.select();
    }
  }

  closeEditor() { this.nameEditor.classList.add('hidden'); }
  closePopovers() { this.closeEditor(); }

  submitName() {
    const v = (this.nameInput.value || '').trim();
    if (!v) return;
    this.onProfile?.({ name: v }); // 校验在服务端（≤12 字），失败会静默忽略
    this.closeEditor();
  }

  // 探针数据源健康状态：挂了要让场内玩家知道，而不是看着过期数据发懵。
  // h.sources 是每个源的读取摘要（服务端 probe.perSite）——
  // 只要有**任何一个**源识别失败/无数据就提示（哪怕别的源正常）：
  // 「新加了一个探针面板却读不到数据」时最需要这条，而不是全场静默。
  setProbeHealth(h) {
    const sources = Array.isArray(h?.sources) ? h.sources : [];
    const broken = sources.filter(s => !s.ok || s.error || (s.warning && !s.kept));
    const ok = (!h || h.ok !== false) && broken.length === 0;
    this.probeOk = ok;
    this.online.parentElement?.classList.toggle('stale', !ok);
    if (this.probeWarn) {
      this.probeWarn.classList.toggle('show', !ok);
      if (!ok) {
        const lines = [];
        if (h?.error) lines.push(String(h.error));
        for (const s of broken) {
          lines.push(`${s.name || s.url}：${s.error || s.warning || '识别不到数据，无法自动获取接口'}`);
        }
        if (!lines.length) lines.push('探针识别不到数据，无法自动获取接口（检查面板地址 / 类型 / token）');
        // 多行：每行一个源的原因（CSS 用 pre-line 折行）；
        // roster 会反复进来，文本没变就不写 DOM
        const text = `⚠️ 探针数据源异常，以下数据可能缺失或已过期\n` + lines.map(l => `· ${l}`).join('\n');
        if (text !== this._lastProbeWarnText) {
          this.probeWarn.textContent = text;
          this._lastProbeWarnText = text;
        }
      }
    }
  }

  setSelfState(hp, score, koLeft) {
    this.hpfill.style.width = Math.max(0, hp) + '%';
    this.hpfill.classList.toggle('low', hp <= 30);
    this.score.textContent = koLeft > 0
      ? `😵 被啄晕了，${Math.ceil(koLeft)} 秒后满血复活…`
      : `🏆 啄倒 ${score} 只鸡`;
    // #ko-banner 是「死亡状态」与「瞬时提示」共用的元素，而本函数 20Hz 都会进来：
    // 以前 koLeft=0 时无条件 remove('show')，把刚弹出的瞬时提示（你啄倒了 X /
    // 静音开关 / 断线提醒）在 ~50ms 内拍灭 —— 看起来就像"没有任何提示"。
    // 现在：死亡优先接管横幅；非死亡时若瞬时提示还在展示期（bannerTimer 未到期），不动它。
    if (koLeft > 0) {
      clearTimeout(this.bannerTimer);
      this.bannerTimer = null;
      this.koBanner.textContent = '😵 你被啄晕了！';
      this.koBanner.classList.add('show');
    } else if (!this.bannerTimer) {
      this.koBanner.classList.remove('show');
    }
  }

  // 服务端 roster.left 下发的离场玩家啄倒记录（roster 广播时更新）
  setLeftBoard(list) { this.leftBoard = Array.isArray(list) ? list : []; }

  update(snapshotPs, roster) {
    // 计数：探针鸡（VPS）/ 网站鸡 / 访客（玩家）
    // ★ 离线的探针鸡/网站鸡（躺倒在场上）不算「在线」——
    //   之前只按类型计数，1 在线 + 1 离线会显示「在线 2」，误导（第 54 轮用户实测）。
    //   同时要记进 offlineIds，否则它们会被误算成「访客」。
    const gooseIds = new Set(), chickIds = new Set(), webIds = new Set(), offlineIds = new Set();
    for (const info of roster.values()) {
      if (!info.npc) continue;
      if (info.offline) { offlineIds.add(info.id); continue; }
      if (info.type === 'goose') gooseIds.add(info.id);
      if (info.type === 'chick') chickIds.add(info.id);
      if (info.type === 'web') webIds.add(info.id);
    }
    this.online.textContent = String(snapshotPs.filter(e => chickIds.has(e[0])).length);
    this.webOnline.textContent = String(snapshotPs.filter(e => webIds.has(e[0])).length);
    const visitorRows = snapshotPs.filter(e =>
      !gooseIds.has(e[0]) && !chickIds.has(e[0]) && !webIds.has(e[0]) && !offlineIds.has(e[0]));
    this.visitors.textContent = String(visitorRows.length);

    // 排行榜数据：玩家 + 探针鸡 + 网站鸡各自上榜；所有 NPC 大白鹅合并为一个榜位
    const gooseScore = snapshotPs
      .filter(e => gooseIds.has(e[0]))
      .reduce((sum, e) => sum + e[7], 0);
    this.rows = snapshotPs
      .filter(e => !gooseIds.has(e[0]))
      .map(e => {
        const info = roster.get(e[0]);
        const name = info?.name || `#${e[0]}`;
        // 玩家（非 NPC）名字后面加「（玩家）」——探针鸡/网站鸡/大白鹅不加
        return { id: e[0], score: e[7], name: info?.npc ? name : name + '（玩家）' };
      });
    // 离场玩家的啄倒记录补进榜（服务端 roster.left）；还在场上的以实时数据为准
    const liveIds = new Set(this.rows.map(r => r.id));
    for (const rec of this.leftBoard) {
      if (rec && !liveIds.has(rec.id)) {
        this.rows.push({ id: rec.id, score: rec.score, name: rec.name + '（玩家）', left: true });
      }
    }
    if (gooseIds.size > 0) this.rows.push({ id: 'goose-team', score: gooseScore, name: 'NPC·大白鹅' });
    this.rows.sort((a, b) => b.score - a.score);
    this.renderBoard();
  }

  // 渲染啄倒榜（默认收起，点击标题展开/收起）。
  // 快照 20Hz 都会调进来：用签名差分 + 500ms 节流，内容没变就完全不碰 DOM；
  // 收起时只更新标题（行被 CSS 隐藏，重写 innerHTML 纯属浪费）。
  renderBoard(force = false) {
    const now = performance.now();
    const top = this.rows.slice(0, 20); // 榜单展示前 20（2026-09-21 由 10 扩到 20）
    const sig = this.collapsed + '|' + top.map(r => `${r.id}:${r.score}:${r.name}`).join(',');
    if (!force) {
      if (sig === this._lastBoardSig) return;
      if (now - this._lastBoardPaint < 500) return;
    }
    this._lastBoardSig = sig;
    this._lastBoardPaint = now;
    this.boardTitle.textContent = this.collapsed
      ? '🐔 啄倒榜'
      : '🐔 啄倒榜（高占用触发主动攻击 · 点击收起）';
    this.board.classList.toggle('collapsed', this.collapsed);
    if (this.collapsed) return;
    this.boardRows.innerHTML = top.map(r =>
      `<div class="row${r.id === this.myId ? ' me' : ''}${r.left ? ' off' : ''}"><span>${esc(r.name)}</span><b>${esc(r.score)}</b></div>`
    ).join('');
  }

  killFeed(from, to) {
    const el = document.createElement('div');
    el.className = 'feed-item';
    el.textContent = `${from} 🐔💥 啄倒了 ${to}`;
    this.feed.appendChild(el);
    while (this.feed.children.length > 4) this.feed.firstChild.remove();
    setTimeout(() => el.remove(), 4500);
  }

  banner(text, ms = 1600) {
    clearTimeout(this.bannerTimer);
    this.koBanner.textContent = text;
    this.koBanner.classList.add('show');
    // 到期回调必须把 bannerTimer 归位 null —— setSelfState 靠它判断"有没有瞬时提示在展示期"
    this.bannerTimer = setTimeout(() => {
      this.bannerTimer = null;
      this.koBanner.classList.remove('show');
    }, ms);
  }
}
