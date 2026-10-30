// API baseUrl 归一化/拒绝：https、loopback、userinfo、metadata、link-local、/v1。

import { describe, it, expect } from '@jest/globals';
import { normalizeChatBaseUrl } from '../../src/inference/url.js';

function normalized(value: string): string {
  const result = normalizeChatBaseUrl(value);
  expect(result.ok).toBe(true);
  return result.ok ? result.url : '';
}

function rejected(value: string | null | undefined): string {
  const result = normalizeChatBaseUrl(value);
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.reason;
}

describe('normalizeChatBaseUrl', () => {
  it('补全 /v1，且不重复追加', () => {
    expect(normalized('https://api.example.test')).toBe('https://api.example.test/v1');
    expect(normalized('https://api.example.test/')).toBe('https://api.example.test/v1');
    expect(normalized('https://api.example.test/v1')).toBe('https://api.example.test/v1');
    expect(normalized('https://api.example.test/v1/')).toBe('https://api.example.test/v1');
    expect(normalized('https://api.example.test/openai')).toBe('https://api.example.test/openai/v1');
    expect(normalized('  https://api.example.test/v1  ')).toBe('https://api.example.test/v1');
  });

  it('http 仅允许回环：127/8、localhost、::1', () => {
    expect(normalized('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/v1');
    expect(normalized('http://127.10.20.30/v1')).toBe('http://127.10.20.30/v1');
    expect(normalized('http://localhost:1234/v1')).toBe('http://localhost:1234/v1');
    expect(normalized('http://[::1]:1234')).toBe('http://[::1]:1234/v1');
    expect(normalized('http://[::ffff:127.0.0.1]:1234')).toBe('http://[::ffff:7f00:1]:1234/v1');
    expect(rejected('http://192.168.1.2/v1')).toBe('base_url_insecure');
    expect(rejected('http://api.example.test/v1')).toBe('base_url_insecure');
    expect(rejected('http://localhost.evil.test/v1')).toBe('base_url_insecure');
    expect(rejected('ftp://api.example.test/v1')).toBe('base_url_insecure');
  });

  it('拒绝 userinfo，避免把凭据写进 baseUrl', () => {
    expect(rejected('https://user:pass@api.example.test/v1')).toBe('base_url_userinfo');
    expect(rejected('https://token@api.example.test/v1')).toBe('base_url_userinfo');
  });

  it('拒绝云 metadata 地址', () => {
    expect(rejected('https://169.254.169.254/latest/meta-data')).toBe('base_url_metadata');
    expect(rejected('https://100.100.100.200/latest/meta-data')).toBe('base_url_metadata');
    expect(rejected('https://metadata.google.internal/computeMetadata/v1')).toBe('base_url_metadata');
    expect(rejected('https://[fd00:ec2::254]/latest/meta-data')).toBe('base_url_metadata');
    expect(rejected('https://[::ffff:169.254.169.254]/latest/meta-data')).toBe('base_url_metadata');
  });

  it('拒绝 link-local 地址', () => {
    expect(rejected('https://169.254.1.1/v1')).toBe('base_url_link_local');
    expect(rejected('https://[fe80::1]/v1')).toBe('base_url_link_local');
    expect(rejected('https://[febf::1]/v1')).toBe('base_url_link_local');
    expect(rejected('https://[::ffff:169.254.1.1]/v1')).toBe('base_url_link_local');
  });

  it('拒绝缺失/非法 URL、query 与 fragment', () => {
    expect(rejected(null)).toBe('base_url_required');
    expect(rejected('')).toBe('base_url_required');
    expect(rejected('   ')).toBe('base_url_required');
    expect(rejected('not-a-url')).toBe('base_url_invalid');
    expect(rejected('https://api.example.test/v1?token=secret')).toBe('base_url_invalid');
    expect(rejected('https://api.example.test/v1#fragment')).toBe('base_url_invalid');
  });
});
