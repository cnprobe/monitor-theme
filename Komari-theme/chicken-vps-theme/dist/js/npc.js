// NPC 动物：大白鹅的程序化低多边形模型与动作。
// 对外接口与 Chicken 一致（group/update/triggerPeck/flash/setHp/dispose），
// main.js 可以用同一套插值与事件代码驱动。
// （探针小鸡使用 Chicken 类渲染，见 main.js 的 roster 分支。）

import * as THREE from 'three';
import { CONF, ST_DEAD, ST_PECK, ST_AIR, ST_RUN } from '/shared/physics.js';

const GOOSE_W = 0xfafafa, ORANGE = 0xe08a2b, DARK = 0x1a1a1a;

// 共享渲染资产（与 chicken.js 同一套约定）：几何体与橙/黑材质全场复用，
// userData.shared = true 标记后 dispose 会跳过。白色身体材质不能共享 ——
// 受击闪红（emissive）是逐鹅修改的。
const geoCache = new Map();
function boxGeo(w, h, d) {
  const k = `b${w},${h},${d}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.BoxGeometry(w, h, d); (g.userData ||= {}).shared = true; geoCache.set(k, g); }
  return g;
}
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
function coneGeo(r, h, seg) {
  const k = `c${r},${h},${seg}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.ConeGeometry(r, h, seg); (g.userData ||= {}).shared = true; geoCache.set(k, g); }
  return g;
}
const MAT_ORANGE = new THREE.MeshLambertMaterial({ color: ORANGE });
(MAT_ORANGE.userData ||= {}).shared = true;
const MAT_DARK = new THREE.MeshLambertMaterial({ color: DARK });
(MAT_DARK.userData ||= {}).shared = true;

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export class Npc {
  constructor(info) {
    this.info = info;
    this.t = Math.random() * 10;
    this.walkPhase = 0;
    this.speed = 0;
    this.peckT = 0;
    this.flashT = 0;
    this.hp = info.maxHp || CONF.maxHp;
    this.ready = false;

    this.group = new THREE.Group();
    this.buildGoose();
    this.buildPlate();
  }

  mat(c) { return new THREE.MeshLambertMaterial({ color: c }); }

  makeLimb(w, h, m) {
    const mesh = new THREE.Mesh(translatedBoxGeo(w, h, w, 0, -h / 2, 0), m);
    mesh.castShadow = true;
    return mesh;
  }

  buildGoose() {
    const white = this.mat(GOOSE_W), orange = MAT_ORANGE, dark = MAT_DARK;
    this.bodyMat = white;
    this.bodyG = new THREE.Group();
    this.bodyG.position.y = 0.42;
    this.group.add(this.bodyG);
    this.group.scale.setScalar(1.25);

    const box = (w, h, d, m, x, y, z, parent) => {
      const mesh = new THREE.Mesh(boxGeo(w, h, d), m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      (parent || this.bodyG).add(mesh);
      return mesh;
    };

    box(0.34, 0.3, 0.52, white, 0, 0, 0);
    const tail = box(0.16, 0.1, 0.14, white, 0, 0.1, -0.3);
    tail.rotation.x = -0.5;
    // 长脖子 + 头
    this.headG = new THREE.Group();
    this.headG.position.set(0, 0.12, 0.22);
    this.bodyG.add(this.headG);
    box(0.1, 0.4, 0.1, white, 0, 0.2, 0.02, this.headG);
    box(0.15, 0.15, 0.2, white, 0, 0.44, 0.05, this.headG);
    const beak = new THREE.Mesh(coneGeo(0.045, 0.16, 4), orange);
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, 0.43, 0.2);
    this.headG.add(beak);
    box(0.035, 0.035, 0.035, dark, 0.08, 0.47, 0.08, this.headG);
    box(0.035, 0.035, 0.035, dark, -0.08, 0.47, 0.08, this.headG);
    // 翅膀（追人时狂扇）
    const wingGeo = translatedBoxGeo(0.05, 0.2, 0.34, 0, -0.1, 0);
    this.wingL = new THREE.Mesh(wingGeo, white);
    this.wingL.position.set(-0.2, 0.1, 0);
    this.wingR = new THREE.Mesh(wingGeo, white);
    this.wingR.position.set(0.2, 0.1, 0);
    for (const w of [this.wingL, this.wingR]) { w.castShadow = true; this.bodyG.add(w); }
    this.legs = [];
    for (const lx of [-0.09, 0.09]) {
      const leg = this.makeLimb(0.05, 0.28, orange);
      leg.position.set(lx, -0.14, 0);
      this.bodyG.add(leg);
      this.legs.push(leg);
    }
    this.baseY = 0.42;
    this.plateY = 1.25;
  }

  buildPlate() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 76;
    this.plateCanvas = c;
    this.plateCtx = c.getContext('2d');
    this.tex = new THREE.CanvasTexture(c);
    if (THREE.SRGBColorSpace) this.tex.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true }));
    this.sprite.scale.set(1.5, 0.45, 1);
    this.sprite.position.y = this.plateY || 1.3;
    this.group.add(this.sprite);
    this.drawPlate();
  }

  drawPlate() {
    const g = this.plateCtx, W = 256, H = 76;
    g.clearRect(0, 0, W, H);
    // 底色/文字/血条样式与 Chicken 名牌保持一致
    g.fillStyle = 'rgba(15,25,10,0.55)';
    roundRect(g, 2, 2, W - 4, H - 4, 14); g.fill();
    g.fillStyle = '#fff';
    g.font = 'bold 21px "Microsoft YaHei","PingFang SC",sans-serif';
    g.textBaseline = 'middle';
    g.fillText(this.info.name, 18, 24);

    // 血条
    const bw = W - 28, bh = 9, bx = 14, by = H - 20;
    g.fillStyle = 'rgba(255,255,255,0.22)';
    roundRect(g, bx, by, bw, bh, 4); g.fill();
    const max = this.info.maxHp || CONF.maxHp;
    const pct = Math.max(0, this.hp) / max;
    g.fillStyle = pct > 0.5 ? '#7ec850' : pct > 0.25 ? '#e8b23a' : '#e05252';
    if (pct > 0.01) { roundRect(g, bx, by, Math.max(bh, bw * pct), bh, 4); g.fill(); }
    this.tex.needsUpdate = true;
  }

  setInfo(info) {
    if (this.info.name !== info.name || this.info.maxHp !== info.maxHp) {
      this.info = info;
      this.drawPlate();
    }
  }

  setHp(hp) {
    if (hp !== this.hp) {
      this.hp = hp;
      this.drawPlate();
    }
  }

  triggerPeck() { this.peckT = CONF.peckAnim; }
  flash() { this.flashT = 0.18; }

  update(dt, st, speed) {
    this.t += dt;
    // 速度指数平滑：远端实体的速度来自快照差分，量化噪声会让腿部抽搐
    this.animSpeed = (this.animSpeed || 0) + (Math.max(0, speed) - (this.animSpeed || 0)) * Math.min(1, dt * 8);
    speed = this.animSpeed;
    this.speed = speed;
    const dead = !!(st & ST_DEAD);
    this.peckT = Math.max(0, this.peckT - dt);
    this.flashT = Math.max(0, this.flashT - dt);
    this.bodyMat.emissive.setHex(this.flashT > 0 ? 0x882222 : 0x000000);

    const targetZ = dead ? 1.45 : 0;
    this.group.rotation.z += (targetZ - this.group.rotation.z) * Math.min(1, dt * 8);

    if (!dead) {
      // 迈步相位按实际走过的路程推进（与地面完全同步，无量化噪声），大幅摇摆步伐
      const lx = this._lastX ?? this.group.position.x;
      const lz = this._lastZ ?? this.group.position.z;
      const moved = Math.min(1, Math.hypot(this.group.position.x - lx, this.group.position.z - lz));
      this._lastX = this.group.position.x;
      this._lastZ = this.group.position.z;
      this.walkPhase += moved * 9;
      const moveAmp = Math.min(1, speed / 1.3);

      const swing = Math.sin(this.walkPhase) * 0.8 * moveAmp;
      this.legs[0].rotation.x = swing;
      this.legs[1].rotation.x = -swing;
      this.bodyG.rotation.z = Math.sin(this.walkPhase * 0.5) * 0.1 * moveAmp;
      this.bodyG.position.y = this.baseY + Math.abs(Math.sin(this.walkPhase)) * 0.04 * moveAmp;

      let headX = 0;
      if (this.peckT > 0 || (st & ST_PECK)) {
        const p = 1 - this.peckT / CONF.peckAnim;
        headX = Math.sin(Math.min(1, Math.max(0, p)) * Math.PI) * 1.0;
      }
      this.headG.rotation.x += (headX - this.headG.rotation.x) * Math.min(1, dt * 12);

      let flap = 0.1;
      if (st & ST_RUN) flap = Math.sin(this.t * 26) * 0.6 + 0.7;
      else if (st & ST_AIR) flap = Math.sin(this.t * 30) * 0.7 + 0.9;
      this.wingL.rotation.z += (-flap - this.wingL.rotation.z) * Math.min(1, dt * 12);
      this.wingR.rotation.z += (flap - this.wingR.rotation.z) * Math.min(1, dt * 12);
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
