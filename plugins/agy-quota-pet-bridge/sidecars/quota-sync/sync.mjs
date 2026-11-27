/**
 * Antigravity 官方 Sidecar 真实额度同步桥接脚本
 *
 * 职责：
 *   1. 由 Antigravity 宿主通过官方 Plugin Sidecar 机制自动拉起，读取宿主注入的标准环境变量
 *      ANTIGRAVITY_LS_ADDRESS 与 ANTIGRAVITY_CSRF_TOKEN；
 *   2. 定时调用本地 Connect-RPC `RetrieveUserQuotaSummary` 获取账号官方 5 小时与每周真实剩余额度；
 *   3. 将解析后的配额原子写入 `~/.gemini/antigravity-pet-quota.json`，供猫娘额度桌宠自动读取；
 *   4. 将无敏感信息的运行诊断状态写入 `~/.gemini/antigravity-pet-quota.status.json`（绝不记录 Token 或邮箱）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const BRIDGE_FILE_PATH = path.join(GEMINI_DIR, 'antigravity-pet-quota.json');
const STATUS_FILE_PATH = path.join(GEMINI_DIR, 'antigravity-pet-quota.status.json');
const RPC_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';

const POLL_INTERVAL_MS = 45_000;
const ERROR_RETRY_MS = 55_000;
const MISSING_ENV_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * 原子写 JSON 文件，防止读取方读到半截文件内容。
 */
function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * 写入不含任何凭据或用户隐私的诊断状态文件。
 */
function writeStatus(status) {
  try {
    writeJsonAtomic(STATUS_FILE_PATH, {
      updated_at: new Date().toISOString(),
      ...status,
    });
  } catch (_) {
    // 状态文件写入失败不影响主流程
  }
}

/**
 * 解析并严格校验 ANTIGRAVITY_LS_ADDRESS，仅允许本机回环地址。
 */
export function parseLoopbackAddress(rawAddress) {
  const trimmed = String(rawAddress || '').trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) {
    return null;
  }

  const protocol = parsed.protocol === 'https:' ? 'https:' : 'http:';
  const port = Number(parsed.port || (protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }

  return {
    protocol,
    hostname: hostname === '[::1]' ? '::1' : hostname,
    port,
  };
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function parseFraction(value) {
  if (typeof value !== 'number') {
    if (
      typeof value !== 'string' ||
      !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.trim())
    ) {
      return null;
    }
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 1) return null;
  return num;
}

function readBucketField(bucket, field) {
  if (Object.hasOwn(bucket, field)) return bucket[field];
  if (isPlainObject(bucket.remaining)) return bucket.remaining[field];
  return undefined;
}

function resolveCadence(bucket) {
  if (typeof bucket?.window === 'string') {
    const w = bucket.window.trim().toLowerCase();
    if (w === '5h' || w === 'weekly') return w;
    return null;
  }
  const id = typeof bucket?.bucketId === 'string' ? bucket.bucketId : '';
  const match = id.match(/-(5h|weekly)$/i);
  return match ? match[1].toLowerCase() : null;
}

function normalizeResetIso(rawResetTime, nowMs) {
  if (typeof rawResetTime === 'string' && rawResetTime.trim()) {
    const ms = Date.parse(rawResetTime);
    if (Number.isFinite(ms)) {
      return new Date(ms).toISOString();
    }
  }
  if (typeof rawResetTime === 'number' && Number.isFinite(rawResetTime) && rawResetTime > 0) {
    const ms = rawResetTime > 1e12 ? rawResetTime : nowMs + rawResetTime * 1000;
    return new Date(ms).toISOString();
  }
  return null;
}

function sanitizeGroupSlug(rawText, fallbackIndex) {
  const cleaned = String(rawText || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || `pool-${fallbackIndex}`;
}

/**
 * 从 RetrieveUserQuotaSummary 响应中提取猫娘桌宠可识别的标准化配额结构。
 *
 * 兼容结构：
 *   1. `{ groups: [{ displayName, buckets: [...] }] }`
 *   2. `{ response: { groups: [...] } }`
 *   3. 旧版平铺 `{ buckets: [...] }`
 */
export function extractQuotaForPet(response, now = Date.now()) {
  const root = isPlainObject(response?.response)
    ? response.response
    : isPlainObject(response)
      ? response
      : {};

  let rawGroups = Array.isArray(root.groups) ? root.groups.filter(isPlainObject) : [];
  if (!rawGroups.length && Array.isArray(root.buckets)) {
    const families = new Map();
    for (const [idx, bucket] of root.buckets.entries()) {
      if (!isPlainObject(bucket)) continue;
      const bucketId = typeof bucket.bucketId === 'string' ? bucket.bucketId : '';
      const familyKey = bucketId.replace(/-(5h|weekly)$/i, '') || `group-${idx}`;
      if (!families.has(familyKey)) {
        families.set(familyKey, {
          displayName: typeof bucket.displayName === 'string' && bucket.displayName ? bucket.displayName : familyKey,
          buckets: [],
        });
      }
      families.get(familyKey).buckets.push(bucket);
    }
    rawGroups = [...families.values()];
  }

  const parsedGroups = rawGroups.map((group, idx) => {
    const buckets = Array.isArray(group.buckets) ? group.buckets.filter(isPlainObject) : [];
    const firstId = buckets.map((b) => (typeof b.bucketId === 'string' ? b.bucketId : '')).find(Boolean) || '';
    const familyId = firstId.replace(/-(5h|weekly)$/i, '') || sanitizeGroupSlug(group.displayName, idx);
    const displayName = typeof group.displayName === 'string' ? group.displayName : familyId;

    let win5h = null;
    let winWeekly = null;

    for (const bucket of buckets) {
      const cadence = resolveCadence(bucket);
      if (!cadence) continue;
      const frac = parseFraction(readBucketField(bucket, 'remainingFraction'));
      if (frac === null) continue;
      const resetTime = normalizeResetIso(bucket.resetTime ?? bucket.reset_time, now);
      const entry = {
        remaining_fraction: Number(frac.toFixed(6)),
        reset_time: resetTime,
      };
      if (cadence === '5h' && !win5h) win5h = entry;
      if (cadence === 'weekly' && !winWeekly) winWeekly = entry;
    }

    const searchText = `${familyId} ${displayName} ${firstId}`.toLowerCase();
    const isExcluded = searchText.includes('claude') || searchText.includes('gpt');
    const isExplicitGemini = searchText.includes('gemini') && !isExcluded;

    return {
      slug: sanitizeGroupSlug(familyId, idx),
      displayName,
      isExplicitGemini,
      isExcluded,
      win5h,
      winWeekly,
    };
  });

  // 优先选择显式 Gemini 池；否则回退到首个非 Claude/GPT 池
  const hasAnyQuota = (g) => Boolean(g.win5h || g.winWeekly);
  const primaryGroup =
    parsedGroups.find((g) => g.isExplicitGemini && hasAnyQuota(g)) ||
    parsedGroups.find((g) => !g.isExcluded && hasAnyQuota(g)) ||
    parsedGroups.find(hasAnyQuota) ||
    null;

  const quota = {};
  if (primaryGroup?.win5h) {
    quota['gemini-5h'] = primaryGroup.win5h;
  }
  if (primaryGroup?.winWeekly) {
    quota['gemini-weekly'] = primaryGroup.winWeekly;
  }

  // 同步记录其他配额池，方便后续扩展多模型展示
  for (const g of parsedGroups) {
    if (g.win5h) {
      const key = g === primaryGroup ? 'gemini-5h' : `${g.slug}-5h`;
      if (!quota[key]) quota[key] = g.win5h;
    }
    if (g.winWeekly) {
      const key = g === primaryGroup ? 'gemini-weekly' : `${g.slug}-weekly`;
      if (!quota[key]) quota[key] = g.winWeekly;
    }
  }

  const bucketsFound = Object.keys(quota).length;
  return {
    record: {
      updated_at: new Date(now).toISOString(),
      source: 'antigravity-sidecar',
      quota,
    },
    bucketsFound,
    fiveHourPct: quota['gemini-5h']
      ? Number((quota['gemini-5h'].remaining_fraction * 100).toFixed(1))
      : null,
    weeklyPct: quota['gemini-weekly']
      ? Number((quota['gemini-weekly'].remaining_fraction * 100).toFixed(1))
      : null,
  };
}

/**
 * 调用本机 Antigravity Language Server 的 RetrieveUserQuotaSummary 接口。
 */
function callQuotaRpc(endpoint, csrfToken) {
  return new Promise((resolve, reject) => {
    const body = '{}';
    const transport = endpoint.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: RPC_PATH,
        method: 'POST',
        // 本机回环自签证书场景允许完成 TLS 握手，仅限上述严格校验后的回环地址
        ...(endpoint.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrfToken,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (raw.length < 4 * 1024 * 1024) {
            raw += chunk;
          }
        });
        res.on('end', () => {
          const status = res.statusCode || 0;
          if (status !== 200) {
            const err = new Error(`HTTP_${status}`);
            err.httpStatus = status;
            reject(err);
            return;
          }
          try {
            resolve({ httpStatus: status, payload: JSON.parse(raw || '{}') });
          } catch {
            const err = new Error('INVALID_JSON');
            err.httpStatus = status;
            reject(err);
          }
        });
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('REQUEST_TIMEOUT'));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function syncOnce() {
  const rawAddress = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrfToken = String(process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  const endpoint = parseLoopbackAddress(rawAddress);

  if (!endpoint || !csrfToken) {
    writeStatus({
      ok: false,
      http_status: null,
      buckets_found: 0,
      five_hour_pct: null,
      weekly_pct: null,
      error: !endpoint ? 'waiting_for_ls_address' : 'waiting_for_csrf_token',
    });
    return { nextDelayMs: MISSING_ENV_INTERVAL_MS };
  }

  try {
    const { httpStatus, payload } = await callQuotaRpc(endpoint, csrfToken);
    const extracted = extractQuotaForPet(payload, Date.now());

    if (extracted.bucketsFound > 0) {
      writeJsonAtomic(BRIDGE_FILE_PATH, extracted.record);
      writeStatus({
        ok: true,
        http_status: httpStatus,
        buckets_found: extracted.bucketsFound,
        five_hour_pct: extracted.fiveHourPct,
        weekly_pct: extracted.weeklyPct,
        error: null,
      });
    } else {
      writeStatus({
        ok: false,
        http_status: httpStatus,
        buckets_found: 0,
        five_hour_pct: null,
        weekly_pct: null,
        error: 'empty_quota_buckets',
      });
    }

    return { nextDelayMs: POLL_INTERVAL_MS };
  } catch (err) {
    const httpStatus = typeof err?.httpStatus === 'number' ? err.httpStatus : null;
    const errorCode =
      httpStatus === 403
        ? 'rpc_restricted_403'
        : String(err?.message || err?.code || 'sync_failed').slice(0, 64);

    writeStatus({
      ok: false,
      http_status: httpStatus,
      buckets_found: 0,
      five_hour_pct: null,
      weekly_pct: null,
      error: errorCode,
    });

    return { nextDelayMs: ERROR_RETRY_MS };
  }
}

function runSelfTest() {
  const now = Date.parse('2026-11-27T04:00:00.000Z');
  const mockGroups = {
    response: {
      groups: [
        {
          displayName: 'Claude & GPT',
          buckets: [
            { bucketId: 'claude-5h', remainingFraction: 0.4, resetTime: '2026-11-27T07:00:00.000Z' },
            { bucketId: 'claude-weekly', remainingFraction: 0.5, resetTime: '2026-12-03T00:00:00.000Z' },
          ],
        },
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-5h', remainingFraction: 0.875, resetTime: '2026-11-27T08:30:00.000Z' },
            { bucketId: 'gemini-weekly', remainingFraction: '0.92', resetTime: '2026-12-04T00:00:00.000Z' },
          ],
        },
      ],
    },
  };

  const res1 = extractQuotaForPet(mockGroups, now);
  assert.equal(res1.fiveHourPct, 87.5);
  assert.equal(res1.weeklyPct, 92);
  assert.equal(res1.record.quota['gemini-5h'].reset_time, '2026-11-27T08:30:00.000Z');
  assert.equal(res1.record.quota['claude-5h'].remaining_fraction, 0.4);

  const mockFlatBuckets = {
    buckets: [
      { bucketId: 'gemini-pro-5h', displayName: 'Gemini Pro', remainingFraction: 0.65, resetTime: '2026-11-27T06:00:00.000Z' },
      { bucketId: 'gemini-pro-weekly', displayName: 'Gemini Pro', remainingFraction: 0.71, resetTime: '2026-12-01T00:00:00.000Z' },
    ],
  };
  const res2 = extractQuotaForPet(mockFlatBuckets, now);
  assert.equal(res2.fiveHourPct, 65);
  assert.equal(res2.weeklyPct, 71);

  assert.deepEqual(parseLoopbackAddress('127.0.0.1:64058'), {
    protocol: 'http:',
    hostname: '127.0.0.1',
    port: 64058,
  });
  assert.equal(parseLoopbackAddress('https://example.com:443'), null);

  console.log(JSON.stringify({ ok: true, selfTest: 'passed', sample: res1 }));
}

async function main() {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }

  let stopped = false;
  let timer = null;
  const shutdown = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const loop = async () => {
    if (stopped) return;
    const { nextDelayMs } = await syncOnce();
    if (stopped) return;
    timer = setTimeout(loop, nextDelayMs);
  };

  await loop();
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  main().catch((err) => {
    writeStatus({
      ok: false,
      http_status: null,
      buckets_found: 0,
      five_hour_pct: null,
      weekly_pct: null,
      error: String(err?.message || 'fatal').slice(0, 64),
    });
    process.exit(1);
  });
}
