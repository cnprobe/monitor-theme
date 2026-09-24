// 探针数据源（游戏侧薄封装）
//
// 真正的读取逻辑在 ./probe/reader.js（通用读取器，8 类探针自动识别）。
// 这个文件只做两件事：
//   1. 按 config.json 的 probe.sources 轮询各站点，调 readProbe/readAll；
//   2. 把统一模型（字节 / B/s / 秒 / ms）**翻译成游戏前端已在用的 stats 形状**。
//
// ⚠ 单位契约（两层各自负责，别混）：
//   reader 产出的 Node：memU/memT/diskU/diskT/netIn/netOut = 字节，netRx/netTx = B/s
//   本文件产出的 stats：memU/memT = KB，hddU/hddT = MB，netIn/netOut = 字节，netRx/netTx = B/s
//   （chicken.js 的 fmtBytes 期望字节；ring 用 memU/memT 求比例所以单位只要自洽即可。
//    之所以保留 KB/MB 是因为前端 drawStatsPlate 的历史契约就是这套，改动面最小。）
//
// 离线的机器不会被丢弃 —— 它仍然出现在场上，但是躺倒的"不可选中"状态，
// 名牌只显示"名字 + 离线"，让玩家一眼看出哪台机器挂了。

import { readAll, flatten } from './probe/reader.js';
import { readResponseText } from './probe/http.js';
import { resolveProbeSecurity } from './security.js';

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ').slice(0, max);

function publicErrorCode(error) {
  const value = String(error || '').toLowerCase();
  if (/超时|timeout|deadline/.test(value)) return 'timeout';
  if (/401|403|认证|unauthor|forbidden|token/.test(value)) return 'unauthorized';
  if (/不是 json|invalid|解析|没有响应|无数据/.test(value)) return 'invalid-response';
  if (/econn|enotfound|网络不可达|拒绝/.test(value)) return 'unreachable';
  return 'unavailable';
}

/** 秒 → "3 天" / "5 小时" / "12 分"（前端直接画字符串） */
function fmtUptime(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return null;
  if (sec < 0) return null;
  const d = Math.floor(sec / 86400);
  if (d >= 1) return `${d} 天`;
  const h = Math.floor(sec / 3600);
  if (h >= 1) return `${h} 小时`;
  const m = Math.floor(sec / 60);
  // < 1 分钟：刚重启的机器报 0~59 秒。显示 "0 分" 会让玩家以为数据坏了，
  // 用 "<1 分" 明确表达"刚刚启动"，同时保留"这是一台真机器"的语义。
  if (m < 1) return sec > 0 ? '<1 分' : '—';
  return `${m} 分`;
}

/** 字节 → KB / MB 的定值换算，null 安全 */
function toKb(v) { return v === null || v === undefined ? 0 : v / BYTES_PER_KB; }
function toMb(v) { return v === null || v === undefined ? 0 : v / BYTES_PER_MB; }

/**
 * 统一模型 Node → 游戏 stats（前端 drawStatsPlate / drawSitePlate 消费的形状）。
 * 每个字段都做 null 兜底：不同探针类型能提供的字段不一样，
 * 缺字段时必须退化成 0 / 占位符，绝不能让前端 `undefined.toFixed` 崩掉。
 */
export function nodeToStats(n) {
  return {
    key: text(n.key, 256),
    name: text(n.name || n.key, 120),
    online: !!n.online,
    kind: text(n.kind, 32),                  // 探针类型，用于调试与卡片标注

    region: n.region ? text(n.region, 16) : null,
    location: text(n.location, 120),
    // 「型号」一行：优先用类型特有说明，退化为 系统 / 架构 / 地区名
    type: text(n.meta?.type || n.meta?.spec || n.os || n.location, 160),

    cpu: n.cpu === null || n.cpu === undefined ? 0 : Math.round(n.cpu),
    memU: +toKb(n.memU).toFixed(1),      // KB（前端算比例）
    memT: +toKb(n.memT).toFixed(1),      // KB
    hddU: +toMb(n.diskU).toFixed(1),     // MB
    hddT: +toMb(n.diskT).toFixed(1),     // MB

    netRx: n.netRx ?? 0,                 // B/s
    netTx: n.netTx ?? 0,                 // B/s
    netIn: n.netIn ?? 0,                 // 字节
    netOut: n.netOut ?? 0,               // 字节
    netMonthIn: n.netMonthIn ?? null,    // 字节（部分类型有）
    netMonthOut: n.netMonthOut ?? null,

    ping: n.ping ?? null,
    cores: n.cores ?? null,
    load: n.load ?? null,                // [1m,5m,15m]

    // 在线时长：优先解析后的秒数，退化为类型自带的字符串原文
    uptime: text(fmtUptime(n.uptime) ?? (n.meta?.uptimeText || '—'), 64),
    uptimeSec: n.uptime ?? null
  };
}

/**
 * 过滤不进游戏的节点。
 * 哪吒无 token 降级模式会把 /api/v1/service 的 ping 监控任务造出来
 * （meta.isService=true，如「北京联通IPv4」）：它们不是机器，没有
 * CPU/内存/流量，渲染成机器鸡只会满屏 0%（用户反馈"有几个探针鸡没有数据"）。
 * 读取器仍然如实返回这些节点（perSite 可见），只是不让它们上场。
 */
export function keepGameNodes(nodes) {
  return (nodes || []).filter(n => !!n && !(n.meta && n.meta.isService));
}

/** 从环境变量解析 source.tokenEnv；显式 token 优先，且不修改配置对象。 */
export function resolveSourceToken(source, env = process.env) {
  if (!source || typeof source !== 'object' || (source.token !== null && source.token !== undefined)) {
    return source && typeof source === 'object' ? source.token : undefined;
  }
  if (typeof source.tokenEnv !== 'string' || !source.tokenEnv.trim() || !env ||
      !Object.prototype.hasOwnProperty.call(env, source.tokenEnv)) return undefined;
  const value = env[source.tokenEnv];
  return typeof value === 'string' ? value : undefined;
}

// 简短别名，便于运维脚本/测试调用；实际轮询使用上面的明确名称。
export const resolveTokenEnv = resolveSourceToken;

/** 返回带已解析 token 的 source 副本，避免把环境变量值写回 config。 */
export function resolveSource(source, env = process.env) {
  if (typeof source === 'string') return { url: source };
  if (!source || typeof source !== 'object') return source;
  const out = { ...source };
  const token = resolveSourceToken(source, env);
  if (token !== undefined) out.token = token;
  return out;
}

export class Probe {
  constructor(sources = [], intervalMs = +(process.env.PROBE_INTERVAL || 5000), legacySites = [], security = {}) {
    // 归一成数组：兼容老的「单个 url 字符串」传法
    this.sources = (Array.isArray(sources) ? sources : [sources])
      .map(s => (typeof s === 'string' ? { url: s } : s))
      .filter(s => s && (s.url || s.endpoint || s.base));
    // 兼容旧配置：probe.url + probe.sites 分开写的形式。
    //   ⚠ probe.sites 是「网站可用性探测」，与探针机器源是**两件独立的事**：
    //   哪怕 sources 已配好，sites 仍要照常探测。之前把它挂在 !sources.length
    //   分支里，导致配了新 sources 后网站鸡全部消失。
    this.legacySites = legacySites || [];
    // 远程 apiBase / NodeGet backend 默认不跟随；配置可显式打开。
    this.security = resolveProbeSecurity(security);

    this.intervalMs = Number.isFinite(intervalMs)
      ? Math.min(3600000, Math.max(1000, intervalMs))
      : 15000;
    this.servers = [];   // 在线+离线机器（统一 stats 形状）
    this.results = [];   // 在线网站探测结果（含延迟）
    this.lastHealth = null;  // 最近一次健康快照 {ok,error,sources}（变更才回调）
    this.perSite = [];   // 每站点读取摘要（诊断 + 前端提示用）

    this.onUpdate = null;
    this.onSitesUpdate = null;
    this.onHealth = null;
    this.pending = false;
  }

  start() {
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, this.intervalMs);
  }

  stop() { clearInterval(this.timer); }

  async poll() {
    if (this.pending) return; // 上一轮还没完（远端可能超时），不重叠
    this.pending = true;
    try {
      await this.pollServers();
      await this.pollSites();
    } catch (error) {
      console.error('[probe] 轮询失败:', error.message);
      this.setHealth(false, '探针轮询失败', this.perSite);
    } finally {
      this.pending = false;
    }
  }

  setHealth(ok, error, sources) {
    const h = { ok, error: error ?? null, sources: sources || [] };
    const prev = this.lastHealth;
    if (prev && prev.ok === h.ok && prev.error === h.error &&
        JSON.stringify(prev.sources) === JSON.stringify(h.sources)) return;
    this.lastHealth = h;
    if (this.onHealth) this.onHealth(h);
  }

  /** 每个源配置里的 timeout / totalMs / token 都透传给读取器 */
  passOpts(s) {
    return {
      ms: s.timeout ?? undefined,
      token: resolveSourceToken(s),
      kind: s.kind ?? undefined,
      totalMs: s.totalMs ?? undefined,
      backendMs: s.backendMs ?? undefined,
    };
  }

  async pollServers() {
    // ★ 一个源都没配：必须当「健康」处理，否则前端会永久显示
    //   「⚠️ 探针数据源异常…所有探针源均无数据」——配置为空不是探针坏了，
    //   别拿这个吓玩家（第 54 轮：用户只填了域名、旧解析把它丢掉后 sources=[]，
    //   正是落进这个分支才显示出那条误导横幅）。
    if (!this.sources.length) {
      this.setHealth(true, null, []);
      return;
    }
    try {
      // 每个源独立并发读取，单站超时/失败不影响其它站（readAll 内部已隔离）。
      // tokenEnv 在轮询时解析，既支持运行时注入环境变量，也不会把密钥写回配置对象。
      const sources = this.sources.map(s => ({ ...resolveSource(s), ...this.passOpts(s) }));
      const out = await readAll(sources, { security: this.security });

      this.perSite = out.map((r, i) => ({
        // 不向访客广播源 URL、内网主机名或上游原始错误正文。
        name: text(this.sources[i]?.name || `探针源 ${i + 1}`, 120),
        ok: !!r.ok,
        kind: text(r.kind, 32) || null,
        nodes: r.nodes?.length || 0,
        kept: keepGameNodes(r.nodes).length,
        error: r.error ? publicErrorCode(r.error) : null,
        warning: r.warning ? 'partial' : null,
      }));

      // 多站拍平成一个节点数组；key 加 host 前缀防不同站的同名机器互撞
      const nodes = keepGameNodes(flatten(out, { prefix: this.sources.length > 1 }))
        .map(nodeToStats);

      const changed = JSON.stringify(nodes) !== JSON.stringify(this.servers);
      this.servers = nodes;

      // 只要**有一个**源读到了数据就算健康；全失败才报错，
      // 并把每个失败源的原因拼出来（别让玩家/我看不到为什么）。
      // sources 明细随健康状态一起下发，前端据此对**单个坏源**给出提示
      //（比如刚添加的探针面板地址写错/接口识别不到，别的源正常时也能看见）。
      const okCount = out.filter(r => r.ok && r.nodes?.length).length;
      if (okCount > 0) {
        this.setHealth(true, null, this.perSite);
      } else {
        this.setHealth(false, '部分或全部探针源不可用', this.perSite);
      }

      if (changed && this.onUpdate) this.onUpdate(this.servers);
    } catch (e) {
      console.log('[probe] 读取失败（保留上次数据）:', e.message);
      this.setHealth(false, '探针轮询失败', this.perSite);
    }
  }

  async pollSites() {
    const sites = this.siteList();
    const list = [];
    for (const site of sites) {
      const t0 = Date.now();
      try {
        const res = await fetch(site.url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          // 站点源 URL 是服务端主动访问目标；不自动跟随跨源重定向，避免 SSRF。
          redirect: 'manual',
          signal: AbortSignal.timeout(site.timeout ?? 8000)
        });
        // ★ 收到 HTTP 响应 ≠ 网站在线。404 / 5xx / Cloudflare「源站失联」错误页
        //   都会「成功拿到响应」，若一律当在线，源站挂了玩家也看不出来。
        //   分类（err 随结果下发，前端把原因写在离线名牌上）：
        //     404          → '404'              页面不存在
        //     5xx 普通     → 'http:<code>'      服务异常（如 503）
        //     520~527 或 CF 错误页特征 → 'cf:<code>'  CF源站失联
        //     连不上/超时  → 'unreachable'      无法连接
        //   其余 4xx（401/403 等）视为源站存活，仍算在线。
        // 消费并限制响应体，避免成功探测时连接/缓冲区滞留。
        let body = '';
        try { body = (await readResponseText(res, 256 * 1024)).slice(0, 65536); } catch { /* 读不到响应体就按状态码判 */ }
        let online = true, err = null;
        if (res.status >= 300 && res.status < 400) {
          online = false;
          err = 'redirect';
        } else if (res.status === 404) {
          online = false; err = '404';
        } else if (res.status >= 500) {
          const cfOrigin = (res.status >= 520 && res.status <= 527) ||
            /cf-error-details|Web server is down|Origin is unreachable|Connection timed out|服务器错误/i.test(body);
          online = false;
          err = cfOrigin ? `cf:${res.status}` : `http:${res.status}`;
        }
        if (online) {
          // key 必须稳定且回传，否则服务器端匹配不到上一轮的小鸡，会反复"下线再入栏"
          list.push({
            key: site.key, name: site.name, url: site.url, region: site.region,
            online: true, latency: Date.now() - t0
          });
        } else {
          // 网站异常 → 仍然保留一只躺倒的"离线"网站鸡，带上离线原因
          list.push({
            key: site.key, name: site.name, url: site.url, region: site.region,
            online: false, latency: null, err
          });
        }
      } catch {
        // 网站无响应 → 同上，保留躺倒的网站鸡
        list.push({
          key: site.key, name: site.name, url: site.url, region: site.region,
          online: false, latency: null, err: 'unreachable'
        });
      }
    }
    const changed = JSON.stringify(list) !== JSON.stringify(this.results);
    this.results = list;
    if (changed && this.onSitesUpdate) this.onSitesUpdate(list);
  }

  /** 网站列表：合并 sources 中显式声明的站点和旧的 probe.sites。 */
  siteList() {
    const explicit = this.sources.filter(s => s.site === true && s.url);
    const legacy = Array.isArray(this.legacySites)
      ? this.legacySites.map(s => typeof s === 'string' ? { url: s } : s)
      : [];
    const seen = new Set();
    return [...explicit, ...legacy]
      .filter(s => {
        const key = s?.key || s?.name || s?.url;
        if (!key || seen.has(String(key))) return false;
        seen.add(String(key));
        return true;
      })
      .map(s => ({
        key: s.key || s.name || s.url,
        name: s.name || s.key || s.url,
        url: s.url,
        region: s.region ?? null,
        timeout: s.timeout
      }));
  }
}
