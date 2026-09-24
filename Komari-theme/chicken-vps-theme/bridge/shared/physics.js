// 服务端与客户端共用的物理与玩法数值。
// 服务器用它做权威模拟，客户端用它对本地鸡做预测（两边必须保持一致）。

export const CONF = {
  walkSpeed: 2.8,      // 慢走 m/s
  runSpeed: 5.4,       // 疾跑 m/s
  gravity: 16,
  jumpVel: 6.2,
  radius: 0.38,        // 鸡的碰撞半径
  peckRange: 1.7,      // 啄击中心距
  peckArc: 1.9,        // 啄击扇形角度（弧度，约110°）
  peckCooldown: 0.5,   // 啄击冷却
  peckDamage: 12,      // 每口伤害
  peckKnock: 4.5,      // 击退冲量
  wingRange: 1.35,     // 扇翅：范围更短但无方向限制
  wingCooldown: 0.8,
  wingDamage: 8,
  wingKnock: 6.5,
  wingAnim: 0.45,
  maxHp: 100,
  koTime: 3.0,         // 被啄晕后复活时间
  peckAnim: 0.35,      // 啄击动画时长
  separation: 30       // 实体间软分离加速度（速度冲量式，重叠可挤过而非卡死）
};

// 跳跃链：一段跳 = 原始全幅高度（jumpVel）；二段以后 = 空中扑腾——
// 离地 ≥ 下沿（贴地不动防抽搐）时按，固定回升 JUMP_CHAIN_HOP 米
// （被天花板封顶，绝不超越一段跳顶点）。段数上限按「玩家 id + 本局第几次起跳」
// 哈希确定（两端必然一致）；落地重置；贴地前按有输入缓冲（触地补一段跳）。
export const JUMP_CHAIN_MIN = 5;
export const JUMP_CHAIN_MAX = 10;
// 扑腾天花板 = 一段跳最高点（由 jumpVel 推导，jumpVel 调整时自动跟随）
export const JUMP_CHAIN_CEILING = (CONF.jumpVel * CONF.jumpVel) / (2 * CONF.gravity);
// 扑腾下沿 = 天花板的一半（≈0.6m）：下坡 / 台阶 / 落地前的微坠落也在此之下，防贴地扑腾
export const JUMP_CHAIN_FLOOR = JUMP_CHAIN_CEILING * 0.5;
// 每次扑腾的回升高度（米）：顶点处按 = 封顶轻点，低处按 = 大力扑回 —— 永远能看得见
export const JUMP_CHAIN_HOP = 0.25;
// 跳跃输入缓冲（秒）：落地前（或贴地瞬间）按的跳，会在触地那一帧补成正式的一段跳，
// 不会因为"按早了"被浪费（否则玩家体验就是"明明按了却跳不起来"）。
export const JUMP_BUFFER = 0.15;

export const WORLD_HALF = 26;

// 快照 st 状态位
export const ST_DEAD = 1, ST_PECK = 2, ST_AIR = 4, ST_WALK = 8, ST_RUN = 16, ST_FLAP = 32;

// 小山坡：高斯包络的高度场，服务器权威模拟与客户端预测共用。
export const HILL = { x: 14, z: 13, h: 2.4, sigma2: 30 };
export function groundHeight(x, z) {
  const dx = x - HILL.x, dz = z - HILL.z;
  return HILL.h * Math.exp(-(dx * dx + dz * dz) / HILL.sigma2);
}

// 静态障碍物（轴对齐盒子）。客户端据此渲染场景，并用于本地预测碰撞。
export function buildObstacles() {
  const o = [];
  const box = (type, x, z, w, d, h) => o.push({ type, x, z, w, d, h });
  const t = 0.4;
  // 围栏（四周）
  box('fence', 0, -WORLD_HALF, WORLD_HALF * 2 + t, t, 1.1);
  box('fence', 0, WORLD_HALF, WORLD_HALF * 2 + t, t, 1.1);
  box('fence', -WORLD_HALF, 0, t, WORLD_HALF * 2 + t, 1.1);
  box('fence', WORLD_HALF, 0, t, WORLD_HALF * 2 + t, 1.1);
  // 鸡舍
  box('coop', -11, -9, 7, 5.5, 3.2);
  // 饲料槽
  box('trough', 9, 11, 2.6, 0.9, 0.55);
  // 草垛
  box('hay', 6, -12, 1.7, 1.7, 1.5);
  box('hay', -15, 10, 1.7, 1.7, 1.5);
  box('hay', 13, 3, 1.7, 1.7, 1.5);
  // 树（树干参与碰撞）
  for (const [x, z] of [[16, 15], [-18, -15], [19, -7], [-6, 17], [-19, 4]]) {
    box('tree', x, z, 0.7, 0.7, 2.6);
  }
  // 石头
  box('rock', 1, 15, 1.6, 1.4, 0.9);
  box('rock', -8, -1, 1.2, 1.1, 0.7);
  box('rock', 11, -16, 1.8, 1.5, 1.0);
  return o;
}

// 圆（鸡）对轴对齐盒子的推出，迭代两轮处理角落。
export function resolveCircle(p, r, obs) {
  for (let iter = 0; iter < 2; iter++) {
    for (const o of obs) {
      const minX = o.x - o.w / 2, maxX = o.x + o.w / 2;
      const minZ = o.z - o.d / 2, maxZ = o.z + o.d / 2;
      const cx = Math.max(minX, Math.min(p.x, maxX));
      const cz = Math.max(minZ, Math.min(p.z, maxZ));
      const dx = p.x - cx, dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r * r) continue;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2), push = (r - d) / d;
        p.x += dx * push;
        p.z += dz * push;
      } else {
        // 圆心陷入盒子内：沿最浅方向推出
        const px = Math.min(p.x - minX, maxX - p.x);
        const pz = Math.min(p.z - minZ, maxZ - p.z);
        if (px < pz) p.x += (p.x >= (minX + maxX) / 2 ? px + r : -(px + r));
        else p.z += (p.z >= (minZ + maxZ) / 2 ? pz + r : -(pz + r));
      }
    }
  }
}

// 单个实体的一步模拟。b: {x,y,z,vy,kx,kz}，inp: {mx,mz,run,jump,yaw}
// inp.speed / inp.radius 为可选覆盖（NPC 用），默认走 CONF 的鸡参数。
export function stepBody(b, inp, obs, dt) {
  let mx = Number(inp.mx) || 0, mz = Number(inp.mz) || 0;
  const m = Math.hypot(mx, mz);
  if (m > 1) { mx /= m; mz /= m; }
  const speed = Number(inp.speed) || (inp.run ? CONF.runSpeed : CONF.walkSpeed);
  const r = Number(inp.radius) || CONF.radius;

  // 击退冲量按指数衰减
  b.kx *= Math.exp(-6 * dt);
  b.kz *= Math.exp(-6 * dt);
  if (Math.abs(b.kx) < 0.02) b.kx = 0;
  if (Math.abs(b.kz) < 0.02) b.kz = 0;

  const g = groundHeight(b.x, b.z);
  const air = b.y - g; // 离地高度：扑腾绝对下限（JUMP_CHAIN_FLOOR）判定用
  const onGround = b.y <= g + 0.001;
  if (onGround) {
    b._jumps = 0;
    // 连跳上限 5~10：按「玩家 id + 本局第几次起跳」哈希确定 —— 客户端与服务端必然
    // 算出同一个值。之前两端各自 Math.random()，扑腾段数几乎每次都不一样，
    // 悬停/落地的轨迹直接分叉，快照不断回拉 = 一直甩不掉的"抽搐"。
    const pid = Number(inp.pid) || 0;
    const h = (pid * 2654435761 + (b._jumpSeq || 0) * 2246822519) >>> 0;
    b._chainMax = JUMP_CHAIN_MIN + (h % (JUMP_CHAIN_MAX - JUMP_CHAIN_MIN + 1));
    // 触地瞬间消费跳跃缓冲：落地前按的跳在这里补成正式的一段跳（不会"按了没反应"）
    if ((b._jumpBufT || 0) > 0) {
      b.vy = CONF.jumpVel;
      b._jumps = 1;
      b._jumpBufT = 0;
    }
  }
  // 跳跃「按下」判定，支持两种来源：
  //  1. 电平边沿（客户端逐帧判定，天然不漏）；
  //  2. 服务端锁存的一次性按下次号 inp.jumpPress —— 服务端 50ms 一个 tick，
  //     若「按下+松开」都落在同一 tick 内，电平采样会把这次短按整个丢掉，
  //     客户端却预测跳了 → 快照把客户端拽回去 = 抽搐。锁存可根治。
  const pressed = !!inp.jumpPress || (!!inp.jump && !b._prevJump);
  if (inp.jumpPress) inp.jumpPress = false; // 一次性消费
  b._prevJump = !!inp.jump;
  if (pressed) b._jumpBufT = JUMP_BUFFER; // 记下这次按下：贴地前按也不浪费
  else if ((b._jumpBufT || 0) > 0) b._jumpBufT = Math.max(0, b._jumpBufT - dt);
  if (pressed && onGround) {
    b.vy = CONF.jumpVel; // 一段跳：原始全幅高度（jumpVel）
    b._jumps = 1;
    b._jumpSeq = (b._jumpSeq || 0) + 1; // 本局第几次起跳：参与连跳上限的哈希
    b._jumpBufT = 0;
  } else if (!onGround) {
    // 二段以后：空中扑腾。条件：离地 ≥ 下沿（贴地不动防抽搐）且还有段数余量。
    // 回升固定 JUMP_CHAIN_HOP 米（被天花板封顶，绝不超越一段跳顶点）：
    // 顶点处按 = 封顶轻点，低处按 = 大力扑回 —— 永远有真实可见的一扑，
    // 不会像"按高度差回弹"那样在顶点处消耗一段却纹丝不动（「无法多段跳」的根因）。
    if (pressed && (b._jumps || 0) < (b._chainMax || JUMP_CHAIN_MAX)) {
      const room = Math.max(0, JUMP_CHAIN_CEILING - air);
      const hop = Math.min(JUMP_CHAIN_HOP, room);
      if (air >= JUMP_CHAIN_FLOOR && hop > 0.01) {
        b.vy = Math.sqrt(2 * CONF.gravity * hop);
        b._jumps = (b._jumps || 0) + 1;
        b._jumpBufT = 0;
      }
    }
  }
  b.vy -= CONF.gravity * dt;
  b.y += b.vy * dt;
  if (b.y < g) { b.y = g; b.vy = 0; }

  b.x += (mx * speed + b.kx) * dt;
  b.z += (mz * speed + b.kz) * dt;
  resolveCircle(b, r, obs);

  const lim = WORLD_HALF - r - 0.1;
  if (b.x > lim) b.x = lim; else if (b.x < -lim) b.x = -lim;
  if (b.z > lim) b.z = lim; else if (b.z < -lim) b.z = -lim;
}
