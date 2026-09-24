// 程序化低多边形鸡：建模（基本几何体拼装）、动作（走路摇摆/啄击/被啄晕/翅膀）、
// 头顶名牌（本地 Unicode 国旗 + AS号·品种 + 血条）。

import * as THREE from 'three';
import { CONF, ST_DEAD, ST_PECK, ST_AIR, ST_RUN, ST_FLAP } from '/shared/physics.js';

export const PALETTES = [
  { body: 0xf5f0e6, wing: 0xe8e0d0, tail: 0xd8cfc0 }, // 白羽
  { body: 0xb5793a, wing: 0xa3682c, tail: 0x8a5522 }, // 黄褐
  { body: 0x3a3a3a, wing: 0x2c2c2c, tail: 0x1f1f1f }, // 乌骨
  { body: 0xe0b34a, wing: 0xd0a038, tail: 0xb98a2c }, // 油鸡金
  { body: 0x8a6a52, wing: 0x7a5a44, tail: 0x6a4a38 }  // 麻鸡
];

const ORANGE = 0xd98a2b, RED = 0xc93434, DARK = 0x1a1a1a;

function labelMode() {
  return document.body?.dataset?.labelMode || 'full';
}

// 网站鸡离线原因（err 由服务端分类下发）：
//   'unreachable'          → 无法连接（超时/拒绝/DNS 失败）
//   '404'                  → 页面不存在
//   'http:<code>'          → 服务异常（如 503）
//   'cf:<code>'            → Cloudflare 报源站失联（520~527 / 错误页特征）
// VPS 探针鸡没有 err，返回空串 → 名牌保持通用的「离线」。
function siteDownReason(s) {
  const e = s && s.err ? String(s.err) : '';
  if (!e) return '';
  if (e === 'unreachable') return '无法连接';
  if (e === '404') return '404 不存在';
  if (e.startsWith('cf:')) return 'CF源站失联';
  const m = e.match(/^http:(\d+)/);
  return m ? `HTTP ${m[1]}` : '';
}

// ---- 共享渲染资产 ----------------------------------------------------------
// 每只鸡约 20 个几何体，25+ 只探针鸡就是 500+ 份完全相同的 BoxGeometry。
// 这些几何体/材质从不变异，做成模块级共享：userData.shared = true，
// dispose/disposeGroup 见到这个标记就跳过（否则删一只鸡会拆掉全场的共享资产）。
// 注意：bodyMat/wingMat/tailMat 不能共享 —— 受击闪红（emissive）与离线变灰
// 是逐鸡修改的，必须每实例一份。
const geoCache = new Map();
function boxGeo(w, h, d) {
  const k = `b${w},${h},${d}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.BoxGeometry(w, h, d); (g.userData ||= {}).shared = true; geoCache.set(k, g); }
  return g;
}
function coneGeo(r, h, seg) {
  const k = `c${r},${h},${seg}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.ConeGeometry(r, h, seg); (g.userData ||= {}).shared = true; geoCache.set(k, g); }
  return g;
}
// 带平移的几何体（枢轴不在中心的翅膀/腿）
function translatedBoxGeo(w, h, d, tx, ty, tz) {
  const k = `t${w},${h},${d},${tx},${ty},${tz}`;
  let g = geoCache.get(k);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    g.translate(tx, ty, tz);
    (g.userData ||= {}).shared = true;
    geoCache.set(k, g);
  }
  return g;
}
const sharedMat = (c) => {
  const m = new THREE.MeshLambertMaterial({ color: c });
  (m.userData ||= {}).shared = true;
  return m;
};
const MAT_ORANGE = sharedMat(ORANGE);
const MAT_RED = sharedMat(RED);
const MAT_DARK = sharedMat(DARK);

// 躺倒时名牌的额外抬升量（世界坐标单位）。卡片挂在会跟着 group 侧翻的坐标系里，
// 不抬就会滑到地面被尸体盖住。数值由实测标定：
// 净空 = 卡片下沿 − 尸体最高点，lift=1.3 时约 +0.03（刚好脱离，不会飘太高）。
const PLATE_LIFT = 1.3;

// ---- 本地 Unicode 国旗（不请求第三方图片服务）------------
const flagCache = new Map();
function codePoint(letter) {
  return String.fromCodePoint(letter.toUpperCase().charCodeAt(0) + 127397);
}
export function flagEntry(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return null;
  let entry = flagCache.get(normalized);
  if (!entry) {
    entry = { emoji: codePoint(normalized[0]) + codePoint(normalized[1]), ok: true, done: true };
    flagCache.set(normalized, entry);
  }
  return entry;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// 探针数值格式化（输入 KB / 字节）
const fmtKb = (v) => v >= 1024 * 1024 * 1024 ? `${(v / 1024 / 1024 / 1024).toFixed(1)}T`
  : v >= 1024 * 1024 ? `${(v / 1024 / 1024).toFixed(1)}G`
  : v >= 1024 ? `${(v / 1024).toFixed(1)}M` : `${v.toFixed(0)}K`;
const fmtBytes = (v) => v >= 2 ** 30 ? `${(v / 2 ** 30).toFixed(1)}G` : v >= 2 ** 20 ? `${(v / 2 ** 20).toFixed(1)}M` : `${(v / 1024).toFixed(0)}K`;

const loadColor = (pct) => pct > 0.8 ? '#e05252' : pct > 0.5 ? '#e8b23a' : '#7ec850';

// 圆圈进度条
function ring(g, cx, cy, r, pct, color, label) {
  g.lineWidth = 7;
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = color;
  g.beginPath(); g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.min(1, Math.max(0, pct)) * Math.PI * 2); g.stroke();
  g.fillStyle = '#fff';
  g.font = 'bold 12px Consolas,monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, cx, cy + 1);
  g.textAlign = 'left';
}

export class Chicken {
  constructor(colorIdx, info, isMe) {
    this.info = info;             // {name, flag, asn}
    this.isMe = isMe;
    this.offline = !!info.offline;  // 离线探针鸡：躺倒、不可选中、名牌只显示"离线"
    this.t = Math.random() * 10;
    this.walkPhase = 0;
    this.speed = 0;
    this.st = 0;
    this.peckT = 0;
    this.flapT = 0;
    this.flashT = 0;
    this.idlePeckIn = 2 + Math.random() * 4;
    this.hp = CONF.maxHp;
    this.ready = false;
    this.animSpeed = 0; // 平滑后的动画速度（远端实体的估算速度有量化噪声）

    this.group = new THREE.Group();
    this.group.scale.setScalar(1.18);
    this.buildBody(colorIdx);
    this.buildPlate();
  }

  buildBody(colorIdx) {
    const pal = PALETTES[colorIdx % PALETTES.length];
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    this.bodyMat = mat(pal.body);
    const wingMat = mat(pal.wing);
    const tailMat = mat(pal.tail);
    // 存下来供"离线压暗 / 回色"使用
    this._wingMat = wingMat;
    this._tailMat = tailMat;
    this._offlineTint = new THREE.Color(0x6b6b6b);
    // 各部位的原始色（离线时往灰里 lerp，恢复在线时用这个目标回色）
    this._baseCols = [
      new THREE.Color(pal.body),
      new THREE.Color(pal.wing),
      new THREE.Color(pal.tail)
    ];
    // 喙/腿橙、鸡冠红、眼珠黑：全场共享材质（从不单独修改，见文件头说明）
    const orangeMat = MAT_ORANGE, redMat = MAT_RED, darkMat = MAT_DARK;

    const box = (w, h, d, m, x, y, z, parent) => {
      const mesh = new THREE.Mesh(boxGeo(w, h, d), m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      (parent || this.bodyG).add(mesh);
      return mesh;
    };

    this.bodyG = new THREE.Group();
    this.bodyG.position.y = 0.42;
    this.group.add(this.bodyG);

    box(0.5, 0.42, 0.62, this.bodyMat, 0, 0, 0); // 躯干
    // 尾羽
    for (const [dz, rz] of [[0, 0], [0.06, 0.3], [-0.06, -0.3]]) {
      const t = box(0.06, 0.26, 0.04, tailMat, 0, 0.16, -0.34);
      t.position.x = dz * 0.9;
      t.rotation.x = -0.55; t.rotation.z = rz;
    }
    // 头颈（啄击时整组前倾）
    this.headG = new THREE.Group();
    this.headG.position.set(0, 0.16, 0.28);
    this.bodyG.add(this.headG);
    box(0.14, 0.18, 0.14, this.bodyMat, 0, 0.05, 0.03, this.headG);   // 颈
    box(0.24, 0.22, 0.24, this.bodyMat, 0, 0.22, 0.05, this.headG);   // 头
    box(0.06, 0.1, 0.18, redMat, 0, 0.37, 0.03, this.headG);          // 鸡冠
    const beak = new THREE.Mesh(coneGeo(0.05, 0.18, 4), orangeMat);
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, 0.2, 0.24);
    beak.castShadow = true;
    this.headG.add(beak);
    box(0.05, 0.08, 0.05, redMat, 0, 0.12, 0.2, this.headG);          // 肉垂
    box(0.035, 0.05, 0.035, darkMat, 0.125, 0.26, 0.1, this.headG);   // 眼
    box(0.035, 0.05, 0.035, darkMat, -0.125, 0.26, 0.1, this.headG);
    // 翅膀（枢轴在肩部）
    const wingGeo = translatedBoxGeo(0.06, 0.28, 0.42, 0, -0.14, 0);
    this.wingL = new THREE.Mesh(wingGeo, wingMat);
    this.wingL.position.set(-0.27, 0.1, -0.02);
    this.wingR = new THREE.Mesh(wingGeo, wingMat);
    this.wingR.position.set(0.27, 0.1, -0.02);
    for (const w of [this.wingL, this.wingR]) { w.castShadow = true; this.bodyG.add(w); }
    // 腿（枢轴在髋部）
    const legGeo = translatedBoxGeo(0.055, 0.24, 0.055, 0, -0.12, 0);
    const footGeo = boxGeo(0.1, 0.03, 0.14);
    this.legL = new THREE.Group(); this.legL.position.set(-0.11, -0.2, 0.02);
    this.legR = new THREE.Group(); this.legR.position.set(0.11, -0.2, 0.02);
    for (const [leg, side] of [[this.legL, -1], [this.legR, 1]]) {
      const thigh = new THREE.Mesh(legGeo, orangeMat);
      thigh.castShadow = true;
      const foot = new THREE.Mesh(footGeo, orangeMat);
      foot.position.set(0, -0.235, 0.04);
      leg.add(thigh, foot);
      this.bodyG.add(leg);
    }
  }

  buildPlate() {
    const stats = !!this.info.stats;           // 探针小鸡：大号数据名牌
    const site = stats && this.info.stats.site; // 网站鸡：紧凑延迟卡片
    // 离线只显示「名字 + 离线」，用一张紧凑卡片即可
    const off = this.offline && stats;
    const c = document.createElement('canvas');
    c.width = off ? 260 : site ? 280 : stats ? 380 : 256;
    c.height = off ? 76 : site ? 110 : stats ? 170 : 76;
    this.plateCanvas = c;
    this.plateCtx = c.getContext('2d');
    this.tex = new THREE.CanvasTexture(c);
    if (THREE.SRGBColorSpace) this.tex.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, depthTest: true, transparent: true }));
    this.sprite.visible = labelMode() !== 'off';
    if (off) this.sprite.scale.set(2.0, 0.58, 1);
    else if (site) this.sprite.scale.set(2.2, 0.86, 1);
    else if (stats) this.sprite.scale.set(2.9, 1.3, 1);
    else this.sprite.scale.set(1.5, 0.45, 1);
    // 名牌挂在一个「反旋转容器」下：鸡侧翻倒地时，这个容器反向转回来，
    // 于是卡片永远竖直悬在头顶，不会被旋转甩到地上被尸体盖住。
    // anchor 默认在 group 原点（y=0），sprite.position.y 保持站立时的原义；
    // 倒地时由 update() 抬高 anchor.position.y，让卡片从尸体上方让开。
    this.plateAnchor = new THREE.Group();
    this.plateAnchor.rotation.z = -this.group.rotation.z;
    this.sprite.position.y = off ? 0.85 : site ? 1.3 : stats ? 1.45 : 1.16;
    this.plateAnchor.add(this.sprite);
    this.group.add(this.plateAnchor);
    this.drawPlate();
  }

  drawPlate() {
    const mode = labelMode();
    this.sprite.visible = mode !== 'off';
    if (mode === 'off') {
      const g = this.plateCtx;
      g.clearRect(0, 0, this.plateCanvas.width, this.plateCanvas.height);
      return;
    }
    if (mode === 'compact') {
      this.sprite.scale.set(this.info.stats ? 2.0 : 1.5, this.info.stats ? 0.72 : 0.45, 1);
      return this.drawCompactPlate();
    }
    const offPlate = this.offline && this.info.stats;
    const sitePlate = this.info.stats?.site;
    if (offPlate) this.sprite.scale.set(2.0, 0.58, 1);
    else if (sitePlate) this.sprite.scale.set(2.2, 0.86, 1);
    else if (this.info.stats) this.sprite.scale.set(2.9, 1.3, 1);
    else this.sprite.scale.set(1.5, 0.45, 1);
    if (this.info.stats) {
      if (this.offline) return this.drawOfflinePlate();
      if (this.info.stats.site) return this.drawSitePlate();
      return this.drawStatsPlate();
    }
    const g = this.plateCtx, W = 256, H = 76;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(15,25,10,0.55)';
    roundRect(g, 2, 2, W - 4, H - 4, 14); g.fill();

    // 国旗：使用本地 Unicode 字符，避免把访客 IP 暴露给第三方图片 CDN。
    const code = this.info.flag;
    const e = flagEntry(code);
    if (e?.emoji) {
      g.fillStyle = '#fff'; g.font = '25px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      g.textBaseline = 'middle';
      g.fillText(e.emoji, 14, 24);
    } else if (code && /^[A-Z]{2}$/.test(String(code).toUpperCase())) {
      g.fillStyle = '#fff'; g.font = 'bold 17px sans-serif'; g.textBaseline = 'middle';
      g.fillText(String(code).toUpperCase(), 18, 24);
    } else {
      g.font = '22px sans-serif'; g.textBaseline = 'middle';
      g.fillText(this.info.asn ? '🌐' : '🏠', 20, 24);
    }

    // 名字
    g.fillStyle = '#fff';
    g.font = 'bold 21px "Microsoft YaHei","PingFang SC",sans-serif';
    g.textBaseline = 'middle';
    let name = this.info.name;
    while (g.measureText(name).width > W - 78 && name.length > 4) name = name.slice(0, -2);
    g.fillText(name, 62, 24);

    // 血条
    const bw = W - 28, bh = 9, bx = 14, by = H - 20;
    g.fillStyle = 'rgba(255,255,255,0.22)';
    roundRect(g, bx, by, bw, bh, 4); g.fill();
    const pct = Math.max(0, this.hp) / CONF.maxHp;
    g.fillStyle = pct > 0.5 ? '#7ec850' : pct > 0.25 ? '#e8b23a' : '#e05252';
    if (pct > 0.01) { roundRect(g, bx, by, Math.max(bh, bw * pct), bh, 4); g.fill(); }
    this.tex.needsUpdate = true;
  }

  drawCompactPlate() {
    const g = this.plateCtx;
    const W = this.plateCanvas.width;
    const H = this.plateCanvas.height;
    const wide = !!this.info.stats;
    const cy = wide ? H * 0.42 : H * 0.5;
    const online = !this.offline && this.info.stats?.online !== false;
    g.clearRect(0, 0, W, H);
    g.fillStyle = online ? 'rgba(15,25,10,0.68)' : 'rgba(45,28,30,0.76)';
    roundRect(g, 3, 3, W - 6, H - 6, wide ? 20 : 14);
    g.fill();
    g.fillStyle = online ? '#7ec850' : '#e05252';
    g.beginPath(); g.arc(wide ? 38 : 28, cy, wide ? 13 : 10, 0, Math.PI * 2); g.fill();

    let name = String(this.info.name || '').replace(/^探针鸡·/, '');
    g.fillStyle = '#fff';
    g.font = `bold ${wide ? 30 : 22}px "Microsoft YaHei","PingFang SC",sans-serif`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const maxWidth = W - (wide ? 150 : 78);
    while (g.measureText(name).width > maxWidth && name.length > 2) name = name.slice(0, -1);
    g.fillText(name, wide ? 66 : 48, cy);

    if (wide) {
      g.fillStyle = online ? '#bfe89d' : '#ffb4a8';
      g.font = '21px Consolas,monospace';
      const detail = online ? `CPU ${Math.round(this.info.stats?.cpu || 0)}%` : '离线';
      g.fillText(detail, wide ? 210 : 48, cy);
    }
    this.tex.needsUpdate = true;
  }

  setInfo(info) {
    // 各算一次即可：stats 是服务端下发的纯数据，stringify 稳定且不会循环引用
    const oldStats = JSON.stringify(this.info.stats);
    const newStats = JSON.stringify(info.stats);
    const statsChanged = oldStats !== newStats;
    // 毛色档位会随机器负载变化，变色时要重建模型而不是只重绘名牌
    const colorChanged = this.info.color !== info.color;
    // 在线状态翻转时名牌要换整张卡片（数据卡 <-> 离线卡）
    const offlineChanged = !!this.info.offline !== !!info.offline;
    const changed = colorChanged || offlineChanged || this.info.flag !== info.flag || this.info.name !== info.name ||
      this.info.maxHp !== info.maxHp || statsChanged;
    this.info = info;
    if (offlineChanged) {
      this.offline = !!info.offline;
      // 卡的尺寸/字号不同，必须整张重建；旧 anchor（含 sprite）与贴图要释放
      if (this.plateAnchor) {
        this.group.remove(this.plateAnchor);
        this.plateAnchor.remove(this.sprite);
      } else if (this.sprite) {
        this.group.remove(this.sprite);
      }
      if (this.sprite?.material) {
        this.sprite.material.map?.dispose();
        this.sprite.material.dispose();
      }
      this.buildPlate();
      return;
    }
    if (colorChanged && typeof info.color === 'number') {
      this.bodyG.parent?.remove(this.bodyG);
      this.disposeGroup(this.bodyG);
      this.buildBody(info.color);
    }
    if (changed) this.drawPlate();
  }

  // 体型跟随机器负载（服务器下发 scale）
  setScale(s) {
    if (this.scaleApplied === s) return;
    this.scaleApplied = s;
    this.group.scale.setScalar(1.18 * s);
  }

  // 释放一棵子树的几何体与材质（重建模型时用，不动 sprite 名牌）。
  // 共享资产（userData.shared，见文件头）跳过 —— 它们被全场复用，不能拆。
  disposeGroup(g) {
    g.traverse(o => {
      if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose();
      if (o.material && !o.material.userData?.shared) {
        if (Array.isArray(o.material)) o.material.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
        else { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
      }
    });
  }

  // 离线探针鸡的名牌：断线图标在左侧垂直居中，名字第一行、「离线」胶囊第二行。
  // 之前胶囊在名字右侧会压住长名字；图标垂直居中跨两行时，下缘又伸进
  // 卡片下半部、容易被倒地的尸体挡住一小块 —— 现在图标收进第一行，
  // 卡片整体也抬高一点（buildPlate 里离线 y=0.85）。
  drawOfflinePlate() {
    const g = this.plateCtx, W = 260, H = 76;
    g.clearRect(0, 0, W, H);
    // 灰暗底：一眼区别在线鸡的绿色卡片
    g.fillStyle = 'rgba(28,28,30,0.78)';
    roundRect(g, 2, 2, W - 4, H - 4, 14); g.fill();
    g.strokeStyle = 'rgba(200,90,90,0.55)';
    g.lineWidth = 2;
    roundRect(g, 2, 2, W - 4, H - 4, 14); g.stroke();

    // 离线图标：一个简单的"断线"符号（断开的圆环 + 斜杠），垂直居中跨两行
    g.save();
    g.translate(28, 38);
    g.strokeStyle = 'rgba(230,120,120,0.95)';
    g.lineWidth = 3.5;
    g.lineCap = 'round';
    g.beginPath(); g.arc(0, 0, 10, Math.PI * 0.2, Math.PI * 1.9); g.stroke();
    g.beginPath(); g.moveTo(-8, -7); g.lineTo(8, 7); g.stroke();
    g.restore();

    // 名字（第一行，右侧不再被胶囊占位，截断余量放宽）
    g.fillStyle = '#e8e8e8';
    g.font = 'bold 22px "Microsoft YaHei","PingFang SC",sans-serif';
    g.textBaseline = 'middle';
    let name = String(this.info.name || '').replace(/^探针鸡·/, '');
    while (g.measureText(name).width > W - 76 && name.length > 2) name = name.slice(0, -1);
    g.fillText(name, 54, 24);

    // 「离线」标签：名字下方的小胶囊（与名字左对齐）。
    // 网站鸡带离线原因（404 / 503 / CF源站失联 / 无法连接），一眼看出为什么挂了；
    // VPS 探针鸡没有原因信息，保持通用的「离线」。
    const label = siteDownReason(this.info.stats) || '离线';
    g.font = 'bold 17px "Microsoft YaHei","PingFang SC",sans-serif';
    const tw = g.measureText(label).width;
    const bw = tw + 22, bh = 25, bx = 54, by = 40;
    g.fillStyle = 'rgba(200,70,70,0.9)';
    roundRect(g, bx, by, bw, bh, 8); g.fill();
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.fillText(label, bx + bw / 2, by + bh / 2 + 1);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';

    this.tex.needsUpdate = true;
  }

  // 网站鸡的延迟卡片：域名/在线状态两行同列对齐（x=54）+ 右上角旗标 + 血条
  drawSitePlate() {
    const g = this.plateCtx, W = 280, H = 110;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(15,25,10,0.6)';
    roundRect(g, 2, 2, W - 4, H - 4, 16); g.fill();

    const s = this.info.stats;
    // 旗标使用本地 Unicode 字符，不请求外部图片服务。
    const code = s?.region;
    const e = code && flagEntry(code);
    if (e?.emoji) {
      g.fillStyle = '#fff'; g.font = '25px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      g.textBaseline = 'middle';
      g.fillText(e.emoji, W - 54, 26);
    } else if (code && /^[A-Z]{2}$/.test(String(code).toUpperCase())) {
      g.fillStyle = '#fff'; g.font = 'bold 19px sans-serif'; g.textBaseline = 'middle';
      g.fillText(String(code).toUpperCase(), W - 52, 26);
    }

    g.fillStyle = '#fff';
    g.font = 'bold 22px "Microsoft YaHei","PingFang SC",sans-serif';
    let name = this.info.name.replace(/^探针鸡·/, '');
    while (g.measureText(name).width > W - 70 && name.length > 4) name = name.slice(0, -2);
    g.fillText(name, 54, 26);

    if (s && typeof s.latency === 'number') {
      g.font = 'bold 24px "Microsoft YaHei",sans-serif';
      g.fillStyle = '#7ec850';
      g.fillText('网站在线', 54, 64);
    } else {
      g.font = '17px Consolas,monospace';
      g.fillStyle = '#cfe8b0';
      g.fillText('检测网站中…', 54, 62);
    }

    // 血条
    const bw = W - 28, bh = 8, bx = 14, by = H - 16;
    g.fillStyle = 'rgba(255,255,255,0.22)';
    roundRect(g, bx, by, bw, bh, 4); g.fill();
    const max = this.info.maxHp || CONF.maxHp;
    const pct = Math.max(0, this.hp) / max;
    g.fillStyle = pct > 0.5 ? '#7ec850' : pct > 0.25 ? '#e8b23a' : '#e05252';
    if (pct > 0.01) { roundRect(g, bx, by, Math.max(bh, bw * pct), bh, 4); g.fill(); }
    this.tex.needsUpdate = true;
  }

  // 探针小鸡的数据名牌：旗标 + 名称 + CPU/RAM 圆圈 + 每秒/DISK/流量/在线 + 型号 + 血条
  drawStatsPlate() {
    const g = this.plateCtx, W = 380, H = 170;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(15,25,10,0.6)';
    roundRect(g, 2, 2, W - 4, H - 4, 16); g.fill();

    const s = this.info.stats;

    // 旗标使用本地 Unicode 字符，不请求外部图片服务。
    const code = s?.region;
    const e = code && flagEntry(code);
    if (e?.emoji) {
      g.fillStyle = '#fff'; g.font = '25px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      g.textBaseline = 'middle';
      g.fillText(e.emoji, 16, 26);
    } else if (code && /^[A-Z]{2}$/.test(String(code).toUpperCase())) {
      g.fillStyle = '#fff'; g.font = 'bold 19px sans-serif'; g.textBaseline = 'middle';
      g.fillText(String(code).toUpperCase(), 18, 26);
    }

    // 名称
    g.fillStyle = '#fff';
    g.font = 'bold 22px "Microsoft YaHei","PingFang SC",sans-serif';
    g.textBaseline = 'middle';
    let name = this.info.name.replace(/^探针鸡·/, '');
    while (g.measureText(name).width > 246 && name.length > 4) name = name.slice(0, -2);
    g.fillText(name, 66, 26);

    if (s) {
      // CPU / RAM 圆圈进度条（右侧，环与标注之间留足空隙）
      ring(g, W - 44, 40, 16, s.cpu / 100, loadColor(s.cpu / 100), `${s.cpu}%`);
      const ramPct = s.memT ? s.memU / s.memT : 0;
      ring(g, W - 44, 108, 16, ramPct, loadColor(ramPct), `${Math.round(ramPct * 100)}%`);
      g.font = '13px "Microsoft YaHei",sans-serif';
      g.fillStyle = '#9db884';
      g.textAlign = 'center';
      g.fillText('CPU', W - 44, 72);
      g.fillText('RAM', W - 44, 140);
      g.textAlign = 'left';

      // 左侧数据行：在线 → 每秒 → 流量 → 型号
      g.font = '17px Consolas,"Microsoft YaHei",monospace';
      g.fillStyle = '#cfe8b0';
      g.fillText(`在线 ${s.uptime}`, 16, 56);
      g.fillText(`每秒 ↑${fmtBytes(s.netTx)} ↓${fmtBytes(s.netRx)}`, 16, 86);
      g.fillText(`流量 ↓${fmtBytes(s.netIn)} ↑${fmtBytes(s.netOut)}`, 16, 116);
      // 机器型号（含到期时间）
      let typeLine = s.type || '';
      g.font = '14px "Microsoft YaHei",sans-serif';
      g.fillStyle = '#9db884';
      while (typeLine && g.measureText(typeLine).width > W - 32) typeLine = typeLine.slice(0, -2);
      if (typeLine) g.fillText(typeLine, 16, 142);
    } else {
      g.font = '17px Consolas,monospace';
      g.fillStyle = '#cfe8b0';
      g.fillText('探针数据加载中…', 16, 70);
    }

    // 血条（细）
    const bw = W - 28, bh = 7, bx = 14, by = H - 12;
    g.fillStyle = 'rgba(255,255,255,0.22)';
    roundRect(g, bx, by, bw, bh, 4); g.fill();
    const max = this.info.maxHp || CONF.maxHp;
    const pct = Math.max(0, this.hp) / max;
    g.fillStyle = pct > 0.5 ? '#7ec850' : pct > 0.25 ? '#e8b23a' : '#e05252';
    if (pct > 0.01) { roundRect(g, bx, by, Math.max(bh, bw * pct), bh, 4); g.fill(); }
    this.tex.needsUpdate = true;
  }

  setHp(hp) {
    if (hp !== this.hp) {
      this.hp = hp;
      this.drawPlate();
    }
  }

  triggerPeck() { this.peckT = CONF.peckAnim; }
  triggerFlap() { this.flapT = CONF.wingAnim; }
  flash() { this.flashT = 0.18; }

  // st: 状态位；speed: 估计水平速度 m/s；groundY: 服务器给的地面高度
  update(dt, st, speed, groundY) {
    this.t += dt;
    this.st = st;
    if (typeof groundY === 'number') this._groundY = groundY;
    const gy = this._groundY ?? this.group.position.y ?? 0;
    // 速度指数平滑：远端实体的速度来自快照差分，量化噪声会让腿部抽搐
    this.animSpeed = (this.animSpeed || 0) + (Math.max(0, speed) - (this.animSpeed || 0)) * Math.min(1, dt * 8);
    speed = this.animSpeed;
    this.speed = speed;
    const dead = !!(st & ST_DEAD);
    this.peckT = Math.max(0, this.peckT - dt);
    this.flapT = Math.max(0, this.flapT - dt);
    if (st & ST_FLAP) this.flapT = Math.max(this.flapT, 0.12);
    this.flashT = Math.max(0, this.flashT - dt);
    this.bodyMat.emissive.setHex(this.flashT > 0 ? 0x882222 : 0x000000);

    // 被啄晕：整体侧翻。离线（探针挂了）用同样的倒地姿态，但额外压暗一点，
    // 和"被打倒、3 秒后复活"区分开 —— 离线是不会自己站起来的。
    const targetZ = dead ? 1.45 : 0;
    this.group.rotation.z += (targetZ - this.group.rotation.z) * Math.min(1, dt * 8);
    // 侧翻后鸡身会有一截扎进地面（实测最低点相对 group 原点约 -0.312）。
    // 按当前翻倒角把整只鸡抬起来贴地：完全翻倒(≈83°)时抬升 0.312，站立时抬升 0。
    const tilt = Math.abs(this.group.rotation.z);
    this.group.position.y = gy + Math.sin(tilt) * 0.314;
    this.bodyG.position.y = 0.42 - (dead ? 0.1 : 0);
    // 名牌始终竖直悬在头顶：在反旋转容器上抵消倾斜，并按翻倒程度抬一点，
    // 免得卡片压在倒地的尸体上。站立时 tilt=0，anchor.y=0 —— 与原来完全一致。
    // PLATE_LIFT 是「完全躺倒时需要额外抬高的量」，由 render-check 的几何
    // 断言实测标定（名牌与尸体不重叠）。
    if (this.plateAnchor) {
      this.plateAnchor.rotation.z = -this.group.rotation.z;
      this.plateAnchor.position.y = (tilt / 1.45) * PLATE_LIFT;
    }
    // 离线压暗 / 恢复在线回色（双向，用原始色为目标）
    if (this._baseCols) {
      const k = Math.min(1, dt * 6);
      const mats = [this.bodyMat, this._wingMat, this._tailMat];
      for (let i = 0; i < mats.length; i++) {
        const m = mats[i];
        if (!m || !m.color) continue;
        const target = this.offline ? this._offlineTint : this._baseCols[i];
        m.color.lerp(target, k);
      }
    }

    if (!dead) {
      // 迈步相位按实际走过的路程推进（与地面完全同步，无量化噪声）
      const lx = this._lastX ?? this.group.position.x;
      const lz = this._lastZ ?? this.group.position.z;
      let moved = Math.min(1, Math.hypot(this.group.position.x - lx, this.group.position.z - lz));
      this._lastX = this.group.position.x;
      this._lastZ = this.group.position.z;
      const isNpc = !!this.info.npc;
      // 玩家的鸡：预测位置带微小修正抖动，对步幅做一步平滑并放缓步频，走路更稳
      if (!isNpc) {
        this._movedSm = (this._movedSm ?? moved) + (moved - (this._movedSm ?? moved)) * Math.min(1, dt * 12);
        moved = this._movedSm;
      }
      this.walkPhase += moved * (isNpc ? 9 : 3.6);
      // 玩家鸡恢复最初的轻微步伐；探针鸡保持大幅摇晃
      const moveAmp = isNpc ? Math.min(1, speed / 1.6) : Math.min(1, speed / CONF.walkSpeed);
      const swing = Math.sin(this.walkPhase) * (isNpc ? 0.85 : 0.75) * moveAmp;
      this.legL.rotation.x = swing;
      this.legR.rotation.x = -swing;
      this.bodyG.rotation.z = Math.sin(this.walkPhase * 0.5) * (isNpc ? 0.15 : 0.09) * moveAmp;
      this.bodyG.rotation.x = moveAmp * (isNpc ? 0.1 : 0.08);

      // 翅膀：扇翅攻击 > 滞空扑腾 > 疾跑微张
      if (this.flapT > 0) {
        const flap = Math.sin(this.t * 40) * 0.85 + 0.8;
        this.wingL.rotation.z = -flap;
        this.wingR.rotation.z = flap;
      } else if (st & ST_AIR) {
        const flap = Math.sin(this.t * 24) * 0.55 + 0.75;
        this.wingL.rotation.z = -flap;
        this.wingR.rotation.z = flap;
        this.legL.rotation.x = this.legR.rotation.x = -0.9;
      } else if (st & ST_RUN) {
        const flap = Math.sin(this.t * 18) * 0.18 + 0.22;
        this.wingL.rotation.z = -flap;
        this.wingR.rotation.z = flap;
      } else {
        this.wingL.rotation.z += (0 - this.wingL.rotation.z) * Math.min(1, dt * 10);
        this.wingR.rotation.z += (0 - this.wingR.rotation.z) * Math.min(1, dt * 10);
      }

      // 头部：啄击 > 走路点头 > 闲逛啄地
      let headX = 0;
      if (this.peckT > 0 || (st & ST_PECK)) {
        const p = 1 - this.peckT / CONF.peckAnim;
        headX = Math.sin(Math.min(1, Math.max(0, p)) * Math.PI) * 1.15;
      } else if (speed > 0.3) {
        headX = Math.abs(Math.sin(this.walkPhase)) * (isNpc ? 0.2 : 0.12);
      } else {
        this.idlePeckIn -= dt;
        if (this.idlePeckIn < 0) {
          if (this.idlePeckIn < -CONF.peckAnim) this.idlePeckIn = 2.5 + Math.random() * 4;
          else headX = Math.sin((-this.idlePeckIn / CONF.peckAnim) * Math.PI) * 1.0;
        }
      }
      this.headG.rotation.x += (headX - this.headG.rotation.x) * Math.min(1, dt * 14);
      this.headG.position.y = 0.16 + Math.sin(this.walkPhase) * (isNpc ? 0.03 : 0.02) * moveAmp;
      this.bodyG.position.y += Math.abs(Math.sin(this.walkPhase)) * (isNpc ? 0.045 : 0) * moveAmp
        + Math.sin(this.t * 2.2) * 0.012 * (1 - moveAmp);
    }
  }

  dispose(scene) {
    scene.remove(this.group);
    this.group.traverse(o => {
      if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose();
      if (o.material && !o.material.userData?.shared) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
  }
}
