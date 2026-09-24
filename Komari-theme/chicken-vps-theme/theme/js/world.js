// 场景与鸡场世界搭建：地面、光照、根据服务器障碍物数据生成网格。

import * as THREE from 'three';
import { groundHeight } from '/shared/physics.js';

// 简单可复现伪随机（装饰物不参与碰撞，无需与服务器同步，但固定种子让画面稳定）
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#7fae46';
  g.fillRect(0, 0, 512, 512);
  const rand = mulberry32(7);
  for (let i = 0; i < 500; i++) {
    const x = rand() * 512, y = rand() * 512, r = 4 + rand() * 26;
    g.fillStyle = rand() < 0.5 ? 'rgba(106,154,60,0.35)' : 'rgba(148,190,90,0.3)';
    g.beginPath(); g.ellipse(x, y, r, r * (0.5 + rand() * 0.5), rand() * 3.14, 0, 6.29); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const MAT = {
  fence: new THREE.MeshLambertMaterial({ color: 0x9a6a3a }),
  fenceTop: new THREE.MeshLambertMaterial({ color: 0x7a5230 }),
  coopWall: new THREE.MeshLambertMaterial({ color: 0xb5553d }),
  coopRoof: new THREE.MeshLambertMaterial({ color: 0x6b4a3a }),
  coopDoor: new THREE.MeshLambertMaterial({ color: 0x3a2a20 }),
  coopTrim: new THREE.MeshLambertMaterial({ color: 0xf0e6d0 }),
  trough: new THREE.MeshLambertMaterial({ color: 0x8a7a5a }),
  water: new THREE.MeshLambertMaterial({ color: 0x5aa7d6 }),
  hay: new THREE.MeshLambertMaterial({ color: 0xd8b95a }),
  trunk: new THREE.MeshLambertMaterial({ color: 0x7a5230 }),
  leaf: new THREE.MeshLambertMaterial({ color: 0x4e8f3a }),
  leaf2: new THREE.MeshLambertMaterial({ color: 0x5da344 }),
  rock: new THREE.MeshLambertMaterial({ color: 0x9a9a92, flatShading: true }),
  hill: new THREE.MeshLambertMaterial({ color: 0x6f9e4b }),
  grass: new THREE.MeshLambertMaterial({ color: 0x6da33f })
};

function buildObstacleMesh(o) {
  const grp = new THREE.Group();
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    grp.add(m);
    return m;
  };

  switch (o.type) {
    case 'fence': {
      const horizontal = o.w > o.d;
      const len = horizontal ? o.w : o.d;
      const geo = new THREE.BoxGeometry(horizontal ? len : 0.12, o.h, horizontal ? 0.12 : len);
      add(geo, MAT.fence, 0, o.h / 2, 0);
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(horizontal ? len : 0.08, 0.09, horizontal ? 0.08 : len), MAT.fenceTop);
      rail.position.set(0, o.h - 0.05, 0);
      rail.castShadow = true;
      grp.add(rail);
      // 栅栏柱（同一根围栏内所有柱子共用一份几何体）
      const n = Math.max(2, Math.round(len / 3));
      const postGeo = new THREE.BoxGeometry(0.18, o.h + 0.15, 0.18);
      for (let i = 0; i <= n; i++) {
        const t = -len / 2 + (len / n) * i;
        const post = new THREE.Mesh(postGeo, MAT.fenceTop);
        post.position.set(horizontal ? t : 0, (o.h + 0.15) / 2, horizontal ? 0 : t);
        post.castShadow = true;
        grp.add(post);
      }
      break;
    }
    case 'coop': {
      add(new THREE.BoxGeometry(o.w, o.h, o.d), MAT.coopWall, 0, o.h / 2, 0);
      const roofL = new THREE.Mesh(new THREE.BoxGeometry(o.w * 0.62, 0.18, o.d + 0.5), MAT.coopRoof);
      roofL.position.set(-o.w * 0.24, o.h + 0.42, 0);
      roofL.rotation.z = 0.5; roofL.castShadow = true;
      grp.add(roofL);
      const roofR = roofL.clone();
      roofR.position.x = o.w * 0.24;
      roofR.rotation.z = -0.5;
      grp.add(roofR);
      add(new THREE.BoxGeometry(1.1, 1.6, 0.1), MAT.coopDoor, 0, 0.8, o.d / 2 + 0.02);
      add(new THREE.BoxGeometry(o.w + 0.2, 0.16, o.d + 0.2), MAT.coopTrim, 0, 0.08, 0);
      break;
    }
    case 'trough': {
      add(new THREE.BoxGeometry(o.w, o.h, o.d), MAT.trough, 0, o.h / 2, 0);
      const water = new THREE.Mesh(new THREE.BoxGeometry(o.w - 0.3, 0.06, o.d - 0.3), MAT.water);
      water.position.set(0, o.h, 0);
      grp.add(water);
      break;
    }
    case 'hay':
      add(new THREE.BoxGeometry(o.w, o.h, o.d), MAT.hay, 0, o.h / 2, 0);
      break;
    case 'tree': {
      add(new THREE.CylinderGeometry(0.22, 0.3, o.h, 7), MAT.trunk, 0, o.h / 2, 0);
      const s1 = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5, 0), MAT.leaf);
      s1.position.set(0, o.h + 0.7, 0); s1.castShadow = true;
      const s2 = new THREE.Mesh(new THREE.IcosahedronGeometry(1.05, 0), MAT.leaf2);
      s2.position.set(0.5, o.h + 1.4, 0.3); s2.castShadow = true;
      const s3 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9, 0), MAT.leaf2);
      s3.position.set(-0.55, o.h + 1.2, -0.35); s3.castShadow = true;
      grp.add(s1, s2, s3);
      break;
    }
    case 'rock': {
      const r = new THREE.Mesh(new THREE.DodecahedronGeometry(o.w / 2, 0), MAT.rock);
      r.position.set(0, o.h / 2, 0);
      r.scale.y = o.h / (o.w / 2) * 0.6;
      r.castShadow = r.receiveShadow = true;
      grp.add(r);
      break;
    }
  }
  grp.position.set(o.x, 0, o.z);
  return grp;
}

export function buildScene(renderer, opts = {}) {
  const lowPower = !!opts.lowPower; // 手机/窄屏：阴影降档换流畅
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa8d8f0);
  scene.fog = new THREE.Fog(0xa8d8f0, 45, 110);

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 220);

  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x8a9a5a, 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
  sun.position.set(24, 34, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(lowPower ? 1024 : 2048, lowPower ? 1024 : 2048);
  sun.shadow.camera.left = -34; sun.shadow.camera.right = 34;
  sun.shadow.camera.top = 34; sun.shadow.camera.bottom = -34;
  sun.shadow.camera.far = 90;
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = lowPower ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;

  return { scene, camera };
}

export function buildWorld(scene, worldData) {
  const { half, obstacles } = worldData;

  function makeGroundMesh(size, segments) {
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    const pos = geo.attributes.position;
    // PlaneGeometry 位于 XY 平面，rotateX(-90°) 后 y→z。高度取 groundHeight(x, -y)。
    for (let i = 0; i < pos.count; i++) {
      pos.setZ(i, groundHeight(pos.getX(i), -pos.getY(i)));
    }
    geo.computeVertexNormals();
    return geo;
  }

  const ground = new THREE.Mesh(
    makeGroundMesh(half * 2 + 60, 110),
    new THREE.MeshLambertMaterial({ map: groundTexture() })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  for (const o of obstacles) {
    const mesh = buildObstacleMesh(o);
    mesh.position.y = groundHeight(o.x, o.z); // 坡上的障碍物贴地
    scene.add(mesh);
  }

  // 围栏外的远景山丘（装饰）
  const rand = mulberry32(42);
  for (let i = 0; i < 9; i++) {
    const ang = (i / 9) * Math.PI * 2 + rand() * 0.5;
    const dist = half + 14 + rand() * 18;
    const hill = new THREE.Mesh(
      new THREE.SphereGeometry(7 + rand() * 8, 12, 8), MAT.hill);
    hill.position.set(Math.cos(ang) * dist, -2.5, Math.sin(ang) * dist);
    hill.scale.y = 0.55;
    hill.receiveShadow = true;
    scene.add(hill);
  }

  // 草丛（装饰，无碰撞，随地形起伏）
  const bladeGeo = new THREE.ConeGeometry(0.05, 0.34, 4);
  const blades = new THREE.InstancedMesh(bladeGeo, MAT.grass, 240);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 240; i++) {
    const gx = (rand() * 2 - 1) * (half - 1.5);
    const gz = (rand() * 2 - 1) * (half - 1.5);
    dummy.position.set(gx, groundHeight(gx, gz) + 0.16, gz);
    dummy.rotation.y = rand() * 3.14;
    dummy.scale.setScalar(0.7 + rand() * 0.9);
    dummy.updateMatrix();
    blades.setMatrixAt(i, dummy.matrix);
  }
  // 草叶不投影：240 个实例的阴影 pass 不便宜，而草影肉眼几乎不可见
  blades.castShadow = false;
  scene.add(blades);
}
