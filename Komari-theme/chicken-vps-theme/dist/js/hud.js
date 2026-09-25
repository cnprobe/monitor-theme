// HUD：在线人数、排行榜、击倒播报、自己状态栏、横幅提示。

// 排行榜用 innerHTML 拼接，玩家名字由客户端提供，必须先转义。
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

export function formatBoardName(name, player) {
  return `${name}${player ? '（玩家）' : ''}`;
}

export class HUD {
  constructor() {
    this.$ = (id) => document.getElementById(id);
    this.online = this.$('online');
    this.visitors = this.$('visitors');
    this.board = this.$('board');
    this.boardTitle = this.$('board-title');
    this.boardRows = this.$('board-rows');
    this.feed = this.$('feed');
    this.hpfill = this.$('hpfill');
    this.scoreText = this.$('score-text');
    this.scoreRow = this.$('score');
    this.topbar = this.$('topbar');
    this.bridgeState = this.$('bridge-state');
    this.bridgeDetail = '尚未连接';
    this.bridgeState?.addEventListener('click', () => {
      this.banner(`伴生服务：${this.bridgeDetail}`, 3500);
    });
    this.meName = this.$('me-name');
    this.onProfile = null; // main.js 注入：patch => net.sendProfile(patch.name)
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
    this.collapsed = true; // 啄倒榜默认收起，点击标题展开/收起
    this.rows = [];
    this.leftBoard = [];   // 离场玩家的啄倒记录（roster.left 下发，服务端只记 score>0）
    this._lastBoardSig = ''; // 榜单渲染差分签名：没变就不动 DOM
    this._lastBoardPaint = 0; // 上次真正写 DOM 的时间（节流上限）
    this.multiplayer = false;
    this.setMultiplayerActive(false);
    this.board.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.renderBoard(true);
    });
  }

  setMultiplayerActive(active) {
    this.multiplayer = !!active;
    document.body.classList.toggle('singleplayer', !this.multiplayer);
    this.placeBridgeState();
    if (!this.multiplayer) {
      this.closeEditor();
      this.scoreText.textContent = '单机浏览模式';
      this.hpfill.style.width = '0%';
    }
  }

  placeBridgeState() {
    const parent = this.multiplayer ? this.scoreRow : this.topbar;
    if (parent && this.bridgeState && this.bridgeState.parentElement !== parent) {
      parent.append(this.bridgeState);
    }
  }

  setMe(name) {
    this.meName.textContent = String(name || '小鸡');
  }

  setBridgeState(state, detail = '') {
    this.bridgeDetail = detail || this.bridgeDetail;
    if (!this.bridgeState) return;
    const labels = {
      connected: '在线',
      connecting: '连接中',
      reconnecting: '重连中',
      missing: '单机模式',
      error: '连接失败',
    };
    this.bridgeState.textContent = labels[state] || state;
    this.bridgeState.className = state;
    this.bridgeState.title = this.bridgeDetail;
  }

  toggleNameEditor() {
    const hidden = this.nameEditor.classList.toggle('hidden');
    if (!hidden) {
      this.nameInput.value = this.meName.textContent || '';
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

  // ZIP 内浏览器直读 Komari 的健康状态；Bridge 多人连接状态在多人时由左下角按钮显示。
  setProbeHealth(health) {
    const ok = health?.ok === true;
    this.online.parentElement?.classList.toggle('stale', !ok);
    if (!this.probeWarn) return;
    this.probeWarn.classList.toggle('show', !ok);
    if (ok) {
      this._lastProbeWarnText = '';
      this.probeWarn.textContent = '';
      return;
    }
    const text = health?.unauthorized
      ? '⚠️ 需要登录 Komari，或使用有效的临时分享链接打开主题'
      : '⚠️ Komari 数据暂时不可用，当前可能显示上一次成功获取的数据';
    if (text !== this._lastProbeWarnText) {
      this.probeWarn.textContent = text;
      this._lastProbeWarnText = text;
    }
  }

  setSelfState(hp, score, koLeft) {
    if (!this.multiplayer) return;
    this.hpfill.style.width = Math.max(0, hp) + '%';
    this.hpfill.classList.toggle('low', hp <= 30);
    this.scoreText.textContent = koLeft > 0
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
    // 浏览器直读的 Komari 节点只参与“节点”计数；玩家和大鹅参与多人计数。
    const gooseIds = new Set(), monitoredIds = new Set();
    for (const info of roster.values()) {
      if (info.type === 'goose') gooseIds.add(info.id);
      else if (info.readonly) monitoredIds.add(info.id);
    }
    this.online.textContent = String(snapshotPs.filter(entry => (
      monitoredIds.has(entry[0]) && roster.get(entry[0])?.offline !== true
    )).length);
    this.visitors.textContent = String(snapshotPs.filter(entry => (
      !gooseIds.has(entry[0]) && !monitoredIds.has(entry[0])
    )).length);

    // 只读节点不可计分；玩家与每只大鹅分别占一个榜位。
    const rows = snapshotPs
      .filter(entry => !roster.get(entry[0])?.readonly)
      .map(entry => {
        const info = roster.get(entry[0]);
        return {
          id: entry[0],
          score: entry[7],
          name: info?.name || `#${entry[0]}`,
          player: !info?.npc,
        };
      });
    // 离场玩家的啄倒记录补进榜（服务端 roster.left）；还在场上的以实时数据为准
    const liveIds = new Set(rows.map(r => r.id));
    for (const rec of this.leftBoard) {
      if (rec && !liveIds.has(rec.id)) {
        rows.push({
          id: rec.id,
          score: rec.score,
          name: rec.name || `#${rec.id}`,
          player: true,
          left: true,
        });
      }
    }

    // 名字池可能随机到重复值；排行榜用玩家 ID 区分，头顶名牌仍保留原名。
    const nameCounts = new Map();
    for (const row of rows) nameCounts.set(row.name, (nameCounts.get(row.name) || 0) + 1);
    this.rows = rows.map(row => ({
      ...row,
      name: formatBoardName(row.name, row.player),
      duplicate: nameCounts.get(row.name) > 1,
    }));
    this.rows.sort((a, b) => b.score - a.score);
    this.renderBoard();
  }

  // 渲染啄倒榜（默认收起，点击标题展开/收起）。
  // 快照 20Hz 都会调进来：用签名差分 + 500ms 节流，内容没变就完全不碰 DOM；
  // 收起时只更新标题（行被 CSS 隐藏，重写 innerHTML 纯属浪费）。
  renderBoard(force = false) {
    const now = performance.now();
    const top = this.rows.slice(0, 20); // 榜单展示前 20（2026-09-21 由 10 扩到 20）
    const sig = this.collapsed + '|' + top.map(r =>
      `${r.id}:${r.score}:${r.name}:${r.duplicate ? 1 : 0}:${r.left ? 1 : 0}`
    ).join(',');
    if (!force) {
      if (sig === this._lastBoardSig) return;
      if (now - this._lastBoardPaint < 500) return;
    }
    this._lastBoardSig = sig;
    this._lastBoardPaint = now;
    this.boardTitle.textContent = this.collapsed
      ? '🐔 啄倒榜'
      : '🐔 啄倒榜（玩家与大鹅 · 点击收起）';
    this.board.classList.toggle('collapsed', this.collapsed);
    if (this.collapsed) return;
    this.boardRows.innerHTML = top.map(r => {
      const id = r.duplicate ? `<span class="board-id" title="玩家 ID">#${esc(r.id)}</span>` : '';
      return `<div class="row${r.id === this.myId ? ' me' : ''}${r.left ? ' off' : ''}"><span class="board-name">${esc(r.name)}</span>${id}<b>${esc(r.score)}</b></div>`;
    }).join('');
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
