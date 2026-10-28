// 设备身份契约（F-IDENT-1）：`<storagePath>.identity.json` 是 deviceId/deviceName 的唯一权威。
//
// 本模块只做 MCP/CLI 侧策略：读取与结构校验、bootstrap 取值、显式创建身份、清理旧 config 字段。
// 证书链的密码学校验仍由 core 在使用身份时完成；这里不做额外的链验证。
//
// 关键不变量：
//   - identity 存在且有效 → 以 identity 为准；env 只警告，legacy config 字段备份后删除；
//   - identity 缺失 → 仅允许在 store 为空时 bootstrap；绝不覆盖已有事件（避免自动换钥）；
//   - identity 无效 → fail closed，不写任何文件。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { IdentityManager } from '@mebular/core';

const HEX_32_BYTES = /^[0-9a-f]{64}$/i;

/** 旧 config 身份字段的备份名（与 config-apply 的 config.json.bak 区分）。 */
export const LEGACY_CONFIG_BACKUP_SUFFIX = '.identity-legacy.bak';

export function identityPathFor(storagePath) {
  return `${storagePath}.identity.json`;
}

function errorWith(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function sanitize(value) {
  return String(value ?? '').trim().replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function defaultDeviceId() {
  const host = process.env.HOSTNAME || hostname() || 'local';
  return `device-${sanitize(host) || 'local'}`;
}

function defaultDeviceName() {
  return hostname() || 'mebular-device';
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * 读取并做**结构**校验（不触碰私钥、不验证证书签名）。
 * @returns {{status:'missing'|'valid'|'invalid', path:string, record?:object, deviceId?:string, deviceName?:string, problems?:string[]}}
 */
export function readIdentityFile(storagePath) {
  const path = identityPathFor(storagePath);
  if (!existsSync(path)) return { status: 'missing', path };

  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    return { status: 'invalid', path, problems: [`身份文件读取失败：${error?.message ?? error}`] };
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    return { status: 'invalid', path, problems: [`身份文件损坏：${error?.message ?? error}`] };
  }
  record = asRecord(record);
  if (record === null) return { status: 'invalid', path, problems: ['身份文件顶层必须是对象'] };

  const problems = [];
  if (typeof record.deviceId !== 'string' || record.deviceId.trim().length === 0) {
    problems.push('缺少有效 deviceId');
  }
  if (typeof record.publicKeyHex !== 'string' || !HEX_32_BYTES.test(record.publicKeyHex)) {
    problems.push('publicKeyHex 不是 32 字节十六进制');
  }
  const certificate = asRecord(record.certificate);
  if (certificate === null) {
    problems.push('缺少设备证书');
  } else {
    if (certificate.deviceId !== record.deviceId) problems.push('证书 deviceId 与身份不一致');
    if (typeof record.publicKeyHex === 'string'
      && String(certificate.devicePublicKey ?? '').toLowerCase() !== record.publicKeyHex.toLowerCase()) {
      problems.push('证书公钥与 publicKeyHex 不一致');
    }
    if (typeof certificate.signature !== 'string' || certificate.signature.length === 0) {
      problems.push('证书缺少签名');
    }
  }
  if (Array.isArray(record.certificateChain)) {
    if (record.certificateChain.length === 0) problems.push('certificateChain 不能为空');
    else if (asRecord(record.certificateChain[0])?.deviceId !== record.deviceId) {
      problems.push('certificateChain 叶证书与 deviceId 不一致');
    }
  }
  const hasPlain = typeof record.privateKeyPkcs8 === 'string' && record.privateKeyPkcs8.length > 0;
  const hasSealed = asRecord(record.privateKeyEncrypted) !== null;
  if (!hasPlain && !hasSealed) problems.push('缺少设备私钥材料');

  if (problems.length > 0) return { status: 'invalid', path, problems };

  const deviceName = typeof record.deviceName === 'string' && record.deviceName.trim().length > 0
    ? record.deviceName
    : record.deviceId;
  return { status: 'valid', path, record, deviceId: record.deviceId, deviceName };
}

/**
 * 只读准备：返回 identity 或 bootstrap 取值，绝不写盘。
 * @returns {{ok:true,status:'valid'|'missing',identityPath:string,identity:{deviceId:string,deviceName:string},source:'identity'|'bootstrap',warnings:string[]}
 *          | {ok:false,status:'invalid'|'conflict',code:string,identityPath:string,message:string,problems?:string[]}}
 */
export function prepareIdentity({ config = {}, storagePath, env = process.env, explicit = null } = {}) {
  const read = readIdentityFile(storagePath);
  const warnings = [];
  if (read.status === 'invalid') {
    return {
      ok: false,
      status: 'invalid',
      code: 'IDENTITY_INVALID',
      identityPath: read.path,
      message: `身份文件无效：${read.path}（${(read.problems ?? []).join('；')}）`,
      problems: read.problems ?? [],
    };
  }

  if (read.status === 'valid') {
    const identity = { deviceId: read.deviceId, deviceName: read.deviceName };
    const requestedId = typeof explicit?.deviceId === 'string' ? explicit.deviceId.trim() : '';
    if (requestedId.length > 0 && requestedId !== identity.deviceId) {
      return {
        ok: false,
        status: 'conflict',
        code: 'IDENTITY_MISMATCH',
        identityPath: read.path,
        message: `--device-id ${requestedId} 与已有身份 ${identity.deviceId} 不一致；已有身份不能通过 init/配置改写。`,
      };
    }
    if (typeof env?.MEBULAR_DEVICE_ID === 'string' && env.MEBULAR_DEVICE_ID.length > 0
      && env.MEBULAR_DEVICE_ID !== identity.deviceId) {
      warnings.push(`忽略 MEBULAR_DEVICE_ID=${env.MEBULAR_DEVICE_ID}：已有身份 ${identity.deviceId} 是唯一权威`);
    }
    if (typeof env?.MEBULAR_DEVICE_NAME === 'string' && env.MEBULAR_DEVICE_NAME.length > 0
      && env.MEBULAR_DEVICE_NAME !== identity.deviceName) {
      warnings.push(`忽略 MEBULAR_DEVICE_NAME=${env.MEBULAR_DEVICE_NAME}：已有身份设备名 ${identity.deviceName} 是唯一权威`);
    }
    const legacyConfig = {};
    if (hasOwn(config ?? {}, 'deviceId')) legacyConfig.deviceId = config.deviceId;
    if (hasOwn(config ?? {}, 'deviceName')) legacyConfig.deviceName = config.deviceName;
    if (legacyConfig.deviceId !== undefined && legacyConfig.deviceId !== identity.deviceId) {
      warnings.push(
        `legacy config.deviceId=${String(legacyConfig.deviceId)} 与身份 ${identity.deviceId} 不一致：`
        + '按身份继续，并备份后移除旧字段',
      );
    }
    return {
      ok: true,
      status: 'valid',
      identityPath: read.path,
      identity,
      source: 'identity',
      warnings,
    };
  }

  // identity 缺失：只生成 bootstrap 候选，不创建、不写 config。
  const explicitId = typeof explicit?.deviceId === 'string' ? explicit.deviceId.trim() : '';
  const explicitName = typeof explicit?.deviceName === 'string' ? explicit.deviceName.trim() : '';
  const configId = typeof config?.deviceId === 'string' ? config.deviceId.trim() : '';
  const configName = typeof config?.deviceName === 'string' ? config.deviceName.trim() : '';
  const deviceId = explicitId
    || (typeof env?.MEBULAR_DEVICE_ID === 'string' ? env.MEBULAR_DEVICE_ID.trim() : '')
    || configId
    || defaultDeviceId();
  const deviceName = explicitName
    || (typeof env?.MEBULAR_DEVICE_NAME === 'string' ? env.MEBULAR_DEVICE_NAME.trim() : '')
    || configName
    || defaultDeviceName();
  return {
    ok: true,
    status: 'missing',
    identityPath: read.path,
    identity: { deviceId, deviceName: deviceName || deviceId },
    source: 'bootstrap',
    warnings,
  };
}

/** 已有 store 数据时禁止自动签发新身份（避免自动换钥）。 */
export function assertFreshStore(storagePath) {
  try {
    const stat = statSync(storagePath);
    if (stat.size > 0) {
      // JSONL：只有空白/空行 = 空 store；SQLite 等二进制文件按体积判空。
      if (/\.jsonl?$/i.test(storagePath)) {
        const text = readFileSync(storagePath, 'utf-8');
        if (text.split('\n').every((line) => line.trim().length === 0)) return;
      }
      throw errorWith(
        'IDENTITY_STORE_OCCUPIED',
        `存储已有数据但身份文件缺失：拒绝自动生成新身份（${storagePath}）。请恢复原身份文件或从备份恢复。`,
      );
    }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
    throw error;
  }
}

/**
 * 显式创建身份文件（仅用于 bootstrap：init / provision create / restore）。
 * 不加密私钥；若配置了口令，core 首次 initialize 会按既有逻辑迁移为加密封套。
 */
export async function createIdentity({
  storagePath,
  deviceId,
  deviceName,
  userMasterPrivateKey,
  userMasterPublicKey = undefined,
}) {
  const path = identityPathFor(storagePath);
  if (existsSync(path)) {
    const existing = readIdentityFile(storagePath);
    if (existing.status === 'valid') {
      if (existing.deviceId !== deviceId) {
        throw errorWith('IDENTITY_MISMATCH', `已有身份 ${existing.deviceId} 与请求 ${deviceId} 不一致`);
      }
      return { deviceId: existing.deviceId, deviceName: existing.deviceName, path, created: false };
    }
    throw errorWith('IDENTITY_INVALID', `身份文件已存在但无效：${path}`);
  }
  if (!userMasterPrivateKey) {
    throw errorWith('IDENTITY_TRUST_ROOT_MISSING', '创建设备身份需要用户主私钥（user-master-key.json）');
  }
  const manager = new IdentityManager();
  if (userMasterPublicKey) manager.setUserMasterPublicKey(userMasterPublicKey);
  manager.setUserMasterPrivateKey(userMasterPrivateKey);
  const identity = await manager.generateDeviceKey(deviceId, deviceName || deviceId);
  identity.certificate = await manager.issueDeviceCertificate(deviceId);
  const record = {
    deviceId: identity.deviceId,
    deviceName: identity.name,
    publicKeyHex: Buffer.from(identity.publicKey).toString('hex'),
    certificate: identity.certificate,
    ...(identity.certificateChain !== undefined ? { certificateChain: identity.certificateChain } : {}),
    createdAt: identity.createdAt,
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(identity.privateKey),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(record, null, 2), 'utf-8');
  await chmod(path, 0o600);
  return { deviceId: identity.deviceId, deviceName: identity.name, path, created: true, record };
}

/** 文件系统写失败统一映射为 storage 初始化失败（身份文件与 store 同路径域）。 */
export async function createIdentityForStorage(input) {
  try {
    return await createIdentity(input);
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('IDENTITY_')) throw error;
    const wrapped = errorWith(
      'STORAGE_INIT_FAILED',
      `身份文件写入失败（${identityPathFor(input.storagePath)}）：${error?.message ?? error}`,
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

/**
 * 旧 config 的 deviceId/deviceName：备份整份 config 后删除字段，原子写回。
 * 无论旧值是否与身份一致都移除（身份是唯一权威）；文件不存在或无字段时 no-op。
 */
export async function cleanLegacyConfig({ configPath: cfgPath, identity = null } = {}) {
  if (typeof cfgPath !== 'string' || cfgPath.length === 0 || !existsSync(cfgPath)) {
    return { migrated: false, backupPath: null, warnings: [] };
  }
  let current;
  try {
    current = JSON.parse(await readFile(cfgPath, 'utf-8'));
  } catch (error) {
    throw errorWith('CONFIG_INVALID', `配置文件损坏：${cfgPath}（${error?.message ?? error}）`);
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    throw errorWith('CONFIG_INVALID', `配置文件损坏：${cfgPath}（顶层必须是对象）`);
  }
  const hasDeviceId = hasOwn(current, 'deviceId');
  const hasDeviceName = hasOwn(current, 'deviceName');
  if (!hasDeviceId && !hasDeviceName) {
    return { migrated: false, backupPath: null, warnings: [] };
  }

  const backupPath = `${cfgPath}${LEGACY_CONFIG_BACKUP_SUFFIX}`;
  if (!existsSync(backupPath)) {
    await copyFile(cfgPath, backupPath);
    await chmod(backupPath, 0o600);
  }
  delete current.deviceId;
  delete current.deviceName;

  const tmp = `${cfgPath}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(current, null, 2), 'utf-8');
  await rename(tmp, cfgPath);
  try { await chmod(cfgPath, 0o600); } catch { /* Windows best-effort */ }

  const warnings = [];
  if (identity && typeof identity.deviceId === 'string') {
    warnings.push(`已从 config.json 移除旧身份字段，设备身份以 ${identity.deviceId} 为准`);
  }
  return { migrated: true, backupPath, warnings };
}
