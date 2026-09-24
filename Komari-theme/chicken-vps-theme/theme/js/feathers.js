// 被啄掉毛的羽毛粒子池。

import * as THREE from 'three';

function featherTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.beginPath();
  g.ellipse(16, 16, 5, 13, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(200,190,170,0.9)';
  g.beginPath(); g.moveTo(16, 4); g.lineTo(16, 28); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Feathers {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    const tex = featherTexture();
    for (let i = 0; i < 80; i++) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false
      }));
      m.scale.setScalar(0.14);
      m.visible = false;
      scene.add(m);
      this.pool.push({ s: m, vel: new THREE.Vector3(), spin: 0, life: 0 });
    }
  }

  burst(pos, n = 9, tint = 0xffffff) {
    let used = 0;
    for (const f of this.pool) {
      if (f.life > 0) continue;
      f.life = 0.9 + Math.random() * 0.5;
      f.s.visible = true;
      f.s.position.set(
        pos.x + (Math.random() - 0.5) * 0.4,
        pos.y + 0.45 + Math.random() * 0.3,
        pos.z + (Math.random() - 0.5) * 0.4
      );
      f.vel.set((Math.random() - 0.5) * 2.4, 1.4 + Math.random() * 1.6, (Math.random() - 0.5) * 2.4);
      f.spin = (Math.random() - 0.5) * 8;
      f.s.material.color.setHex(tint);
      f.s.material.rotation = Math.random() * 6.28;
      if (++used >= n) break;
    }
  }

  update(dt) {
    for (const f of this.pool) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) { f.s.visible = false; continue; }
      f.vel.y -= 2.6 * dt;          // 羽毛飘落
      f.vel.multiplyScalar(1 - 1.4 * dt);
      f.s.position.addScaledVector(f.vel, dt);
      if (f.s.position.y < 0.03) { f.s.position.y = 0.03; f.vel.set(0, 0, 0); }
      f.s.material.rotation += f.spin * dt;
      f.s.material.opacity = Math.min(1, f.life * 2.2);
    }
  }
}
