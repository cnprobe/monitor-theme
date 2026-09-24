// 移动端触屏操控层：虚拟摇杆（移动/疾跑）+ 拖动转视角 + 动作按钮（啄/扇翅/跳）。
//
// 设计要点
// --------
// 1. **不做 UA 嗅探**，用能力探测：`matchMedia('(pointer: coarse)')` 与
//    `'ontouchstart' in window` / `navigator.maxTouchPoints > 0`。
//    带触摸屏的笔记本会同时命中，但那时鼠标键盘更好用 —— 所以只在
//    "粗指针且没有精细指针" 时自动启用；否则提供手动开关。
// 2. **全部走 Pointer Events + setPointerCapture**。这样一根手指按住摇杆、
//    另一根手指转视角、第三根点按钮，三者天然互不干扰（每个 pointerId 独立跟踪），
//    比 touchstart/touchmove 自己维护触点表可靠得多。
// 3. **摇杆/按钮的命中区由 DOM 决定，视角拖动挂在 canvas 上**。
//    因为触屏控件的容器是 `pointer-events: none`，只有具体控件自己
//    `pointer-events: auto`，所以落在空白处的手指会自动穿透到 canvas 变成视角拖动。
// 4. **轻点 vs 拖动** 用位移阈值区分：按下后位移 < 6px 且时长 < 220ms 视为轻点
//    （啄一下），否则是拖动转视角。这和桌面端的 `dragMoved < 5` 逻辑一致。
// 5. 摇杆输出**归一化到 [-1,1] 的圆内**，死区 12%，和键盘的
//    `fwd/str` 二值向量最终都被 `physics.js` 的 `stepBody` 归一化，语义一致。

const DEAD_ZONE = 0.12;   // 摇杆死区（半径比例）
const TAP_MOVE = 6;       // 轻点判定的最大位移（px）
const TAP_TIME = 220;     // 轻点判定的最大时长（ms）
const LOOK_SENS = 0.0042; // 触屏视角灵敏度（比鼠标 0.0026 略高，手指行程短）

// ---- 设备能力探测 ----------------------------------------------------------

/** 是否"粗指针且无精细指针"——即典型的手机/平板。 */
export function isTouchDevice(win = globalThis) {
  try {
    const mm = win.matchMedia;
    if (typeof mm === 'function') {
      const coarse = mm.call(win, '(pointer: coarse)');
      const fine = mm.call(win, '(pointer: fine)');
      // 支持 matchMedia 时以它为准：粗指针且非精细指针 = 纯触屏设备
      if (coarse && fine) return !!coarse.matches && !fine.matches;
      if (coarse) return !!coarse.matches;
    }
  } catch { /* matchMedia 不可用或行为异常，落回能力探测 */ }
  const nav = win.navigator || {};
  const maxTouch = Number(nav.maxTouchPoints) || 0;
  return maxTouch > 1 || 'ontouchstart' in win;
}

/** 是否支持 Pointer Events（现代浏览器都有；缺了就不启用触屏层）。 */
export function hasPointerEvents(win = globalThis) {
  return typeof win.PointerEvent === 'function';
}

// ---- 工具 ------------------------------------------------------------------

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 把摇杆的像素位移换算成归一化方向向量（圆内，含死区）。 */
export function stickVector(dx, dy, radius) {
  const r = Math.max(1, radius);
  const len = Math.hypot(dx, dy);
  if (len < r * DEAD_ZONE) return { x: 0, y: 0, len: 0 };
  // 幅值线性映射：死区外从 0 平滑爬到 1，超过半径截断为 1
  const mag = Math.min(1, (len / r - DEAD_ZONE) / (1 - DEAD_ZONE));
  return { x: (dx / len) * mag, y: (dy / len) * mag, len: mag };
}

// ---- 主类 ------------------------------------------------------------------

/**
 * 触屏操控层。
 *
 * @param {object} opts
 * @param {HTMLElement} opts.root    触屏控件容器（内含 #stick / #stick-knob / [data-act]）
 * @param {HTMLElement} opts.canvas  用于视角拖动的元素（renderer.domElement）
 * @param {object} opts.camera       `{ get yaw, set yaw, get pitch, set pitch }` 形式的读写口
 * @param {(name:string)=>void} opts.action  动作回调，name ∈ 'peck' | 'wing'
 * @param {()=>void} [opts.onRunToggle]      疾跑状态变化回调（用于更新按钮外观）
 */
export function createTouchControls(opts) {
  const { root, canvas, camera, action } = opts;
  if (!root || !canvas || !camera) return null;

  const stick = root.querySelector('[data-stick]');
  const knob = root.querySelector('[data-stick-knob]');
  const buttons = [...root.querySelectorAll('[data-act]')];

  // 对外可见的状态（main.js 每帧读取）
  const state = {
    mx: 0, mz: 0,      // 归一化方向（未乘速度；stepBody 会按 speed 缩放）
    run: false,        // 疾跑：摇杆推到底自动触发，或按住疾跑键
    jump: false,       // 跳跃：按住跳跃键期间为 true（stepBody 只在贴地时起跳）
    active: false      // 是否真的接管了输入（供 main.js 决定上报策略）
  };

  let stickPointer = null,  stickOrigin = { x: 0, y: 0 }, stickRadius = 56;
  let lookPointer = null,   lookLast = { x: 0, y: 0 }, lookStart = { x: 0, y: 0 }, lookT0 = 0, lookMoved = 0;
  /** pointerId -> 按钮元素，用于按住持续触发的动作（跳跃） */
  const held = new Map();
  /** 疾跑是否被"推到底"自动锁存 —— 松手即释放，不做粘滞，免得玩家甩不掉 */
  let runByStick = false;

  // ---- 摇杆 ----

  function measureStick() {
    if (!stick) return;
    const r = stick.getBoundingClientRect();
    stickRadius = Math.max(24, Math.min(r.width, r.height) / 2 || 56);
  }

  function setKnob(dx, dy) {
    if (!knob) return;
    knob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
  }

  function updateStickFromPointer(px, py) {
    const dx = px - stickOrigin.x;
    const dy = py - stickOrigin.y;
    const v = stickVector(dx, dy, stickRadius);
    state.mx = v.x;
    state.mz = v.y;
    // 视觉上摇杆帽最多走到半径处
    const len = Math.hypot(dx, dy) || 1;
    const cl = Math.min(len, stickRadius) / len;
    setKnob(dx * cl, dy * cl);
    // 推到底（幅值 ≈ 1）自动疾跑：小屏上再点一个"疾跑键"太别扭
    const wantRun = v.len >= 0.92;
    if (wantRun !== runByStick) {
      runByStick = wantRun;
      applyRun();
    }
  }

  function releaseStick() {
    stickPointer = null;
    state.mx = 0; state.mz = 0;
    setKnob(0, 0);
    if (stick) stick.classList.remove('active');
    if (runByStick) { runByStick = false; applyRun(); }
  }

  function onStickDown(e) {
    if (stickPointer !== null) return;
    stickPointer = e.pointerId;
    measureStick();
    const r = stick.getBoundingClientRect();
    stickOrigin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    stick.classList.add('active');
    try { stick.setPointerCapture(e.pointerId); } catch { /* 某些浏览器对已捕获的指针抛错 */ }
    updateStickFromPointer(e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
  }

  function onStickMove(e) {
    if (e.pointerId !== stickPointer) return;
    updateStickFromPointer(e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
  }

  function onStickUp(e) {
    if (e.pointerId !== stickPointer) return;
    initAudioOnce();
    releaseStick();
    e.preventDefault();
    e.stopPropagation();
  }

  // ---- 视角拖动（挂在 canvas 上，空白区域自然穿透到这里）----

  function onLookDown(e) {
    if (lookPointer !== null) return;
    // 只处理真正落在 canvas 上的指针：控件容器已 pointer-events:none，
    // 但仍显式排除一次，避免 CSS 改动后误吞按钮事件。
    if (e.target !== canvas) return;
    lookPointer = e.pointerId;
    lookLast = { x: e.clientX, y: e.clientY };
    lookStart = { x: e.clientX, y: e.clientY };
    lookT0 = Date.now();
    lookMoved = 0;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  function onLookMove(e) {
    if (e.pointerId !== lookPointer) return;
    const dx = e.clientX - lookLast.x;
    const dy = e.clientY - lookLast.y;
    lookLast = { x: e.clientX, y: e.clientY };
    lookMoved += Math.abs(dx) + Math.abs(dy);
    camera.yaw = camera.yaw - dx * LOOK_SENS;
    camera.pitch = clamp(camera.pitch + dy * LOOK_SENS, 0.06, 1.25);
    e.preventDefault();
  }

  function onLookUp(e) {
    if (e.pointerId !== lookPointer) return;
    lookPointer = null;
    initAudioOnce();
    // 轻点：位移小、时间短 → 相当于桌面端"单击啄一下"
    const dt = Date.now() - lookT0;
    if (lookMoved < TAP_MOVE && dt < TAP_TIME) action?.('peck');
    e.preventDefault();
  }

  // ---- 按钮 ----

  // 疾跑：按住「疾跑」键，或摇杆推到底（runByStick），二者取或
  let runHeld = false;
  // 持续类动作（jump/run）按 action 记持有集合：两只手指同按一个键时，
  // 必须**全部**松开动作才结束（按 pointerId 记账，避免松一指就断）
  const holders = { jump: new Set(), run: new Set() };

  function applyRun() {
    runHeld = holders.run.size > 0;
    const next = runByStick || runHeld;
    if (next === state.run) { syncButtonStates(); return; }
    state.run = next;
    syncButtonStates();
    opts.onRunToggle?.(next);
  }

  function syncButtonStates() {
    for (const b of buttons) {
      const a = b.dataset.act;
      if (a === 'run') b.classList.toggle('on', runHeld || runByStick);
      else if (a === 'jump') b.classList.toggle('on', state.jump);
    }
  }

  function onBtnDown(e) {
    const btn = e.currentTarget;
    const act = btn.dataset.act;
    if (held.has(e.pointerId)) return;
    held.set(e.pointerId, btn);
    try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    btn.classList.add('press');
    initAudioOnce();

    if (act === 'peck') action?.('peck');
    else if (act === 'wing') action?.('wing');
    else if (act === 'jump') {
      holders.jump.add(e.pointerId);
      state.jump = true;
      syncButtonStates();
    }
    else if (act === 'run') {
      holders.run.add(e.pointerId);
      applyRun();
    }

    e.preventDefault();
    e.stopPropagation();
  }

  function onBtnUp(e) {
    const btn = held.get(e.pointerId);
    if (!btn) return;
    held.delete(e.pointerId);
    btn.classList.remove('press');
    const act = btn.dataset.act;
    if (act === 'jump') {
      holders.jump.delete(e.pointerId);
      if (holders.jump.size === 0) { state.jump = false; syncButtonStates(); }
    }
    else if (act === 'run') {
      holders.run.delete(e.pointerId);
      applyRun();
    }
    e.preventDefault();
    e.stopPropagation();
  }

  // ---- 音频：浏览器要求音频在用户手势里初始化 ----
  let audioInited = false;
  function initAudioOnce() {
    if (audioInited) return;
    audioInited = true;
    opts.onFirstGesture?.();
  }

  // ---- 绑定 ----

  const on = (el, type, fn, o) => el && el.addEventListener(type, fn, o);

  on(stick, 'pointerdown', onStickDown);
  on(stick, 'pointermove', onStickMove);
  on(stick, 'pointerup', onStickUp);
  on(stick, 'pointercancel', onStickUp);
  on(stick, 'lostpointercapture', onStickUp);

  on(canvas, 'pointerdown', onLookDown);
  on(canvas, 'pointermove', onLookMove);
  on(canvas, 'pointerup', onLookUp);
  on(canvas, 'pointercancel', onLookUp);
  on(canvas, 'lostpointercapture', onLookUp);

  for (const b of buttons) {
    on(b, 'pointerdown', onBtnDown);
    on(b, 'pointerup', onBtnUp);
    on(b, 'pointercancel', onBtnUp);
    on(b, 'lostpointercapture', onBtnUp);
  }

  // 窗口失焦/切后台时清空按住状态，否则会"卡着一直往前跑"
  const resetAll = () => {
    if (stickPointer !== null || state.mx || state.mz) releaseStick();
    lookPointer = null;
    held.clear();
    holders.jump.clear();
    holders.run.clear();
    runHeld = false;
    state.jump = false;
    runByStick = false;
    state.run = false;
    for (const b of buttons) b.classList.remove('press', 'on');
    setKnob(0, 0);
  };
  on(globalThis, 'blur', resetAll);
  on(globalThis.document, 'visibilitychange', () => { if (globalThis.document.hidden) resetAll(); });

  // 禁用长按选中/拖动图像等默认行为（双保险，CSS 里也有 touch-action）
  on(root, 'contextmenu', (e) => e.preventDefault());

  measureStick();
  syncButtonStates();

  state.active = true;
  state.reset = resetAll;
  state.measure = measureStick;
  return state;
}

/** 在指定容器里生成触屏控件的 DOM。 */
export function buildTouchUi(root) {
  if (!root || root.dataset.built) return root;
  root.dataset.built = '1';
  root.innerHTML = `
    <div class="tc-stick" data-stick>
      <div class="tc-stick-ring"></div>
      <div class="tc-stick-knob" data-stick-knob></div>
    </div>
    <div class="tc-actions">
      <button class="tc-btn tc-btn-run" data-act="run" type="button">疾跑</button>
      <button class="tc-btn tc-btn-jump" data-act="jump" type="button">跳</button>
      <button class="tc-btn tc-btn-wing" data-act="wing" type="button">扇翅</button>
      <button class="tc-btn tc-btn-peck" data-act="peck" type="button">啄</button>
    </div>`;
  return root;
}
