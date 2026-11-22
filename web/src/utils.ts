export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : decimals)} ${sizes[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  if (bytesPerSec < 1024 * 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
  return `${(bytesPerSec / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
}

export function formatMbps(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 Mbps';
  const bitsPerSec = bytesPerSec * 8;
  if (bitsPerSec < 1_000_000) return `${Math.round(bitsPerSec / 1000)} Kbps`;
  if (bitsPerSec < 100_000_000) return `${(bitsPerSec / 1_000_000).toFixed(1)} Mbps`;
  if (bitsPerSec < 1_000_000_000) return `${Math.round(bitsPerSec / 1_000_000)} Mbps`;
  return `${(bitsPerSec / 1_000_000_000).toFixed(2)} Gbps`;
}

export function billingModeLabel(mode?: string): string {
  switch (mode) {
    case 'tx':
      return '仅出站计费';
    case 'rx':
      return '仅入站计费';
    case 'max':
      return '取收发大值';
    default:
      return '双向合计';
  }
}

const PROXY_KEYWORDS = ['proxy', '代理', '落地', '中转', 'vpn', 'xray', 'sing-box', 'hysteria', 'vless', 'trojan'];

export function isProxyServer(server: {
  id: string;
  name: string;
  role?: string;
  tags?: string[];
  proxyEnabled?: boolean;
}): boolean {
  if (typeof server.proxyEnabled === 'boolean') return server.proxyEnabled;
  const hay = `${server.id} ${server.name} ${server.role || ''} ${(server.tags || []).join(' ')}`.toLowerCase();
  return PROXY_KEYWORDS.some((kw) => hay.includes(kw));
}

export function formatUptime(seconds?: number): string {
  if (!seconds || seconds <= 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${mins} 分钟`;
  return `${mins} 分钟`;
}

export function formatRelativeTime(iso?: string): string {
  if (!iso) return '从未';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

export function formatDateTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    return true;
  }
}

export function usageBarColor(pct: number): string {
  if (pct >= 85) return 'bg-rose-500';
  if (pct >= 70) return 'bg-amber-400';
  return 'bg-sky-400';
}

export function usageTextColor(pct: number): string {
  if (pct >= 85) return 'text-rose-400';
  if (pct >= 70) return 'text-amber-300';
  return 'text-slate-100';
}

const REGION_CODE_MAP: Record<string, string> = {
  HK: 'HK', '香港': 'HK', 'HONG KONG': 'HK',
  CN: 'CN', '中国': 'CN', 'CHINA': 'CN', '北京': 'CN', '上海': 'CN', '广州': 'CN', '广东': 'CN', '深圳': 'CN', '腾讯云': 'CN',
  TW: 'TW', '台湾': 'TW', '台北': 'TW', 'TAIWAN': 'TW',
  MO: 'MO', '澳门': 'MO',
  JP: 'JP', '日本': 'JP', '东京': 'JP', '大阪': 'JP', 'JAPAN': 'JP', 'TOKYO': 'JP',
  SG: 'SG', '新加坡': 'SG', 'SINGAPORE': 'SG', 'ALISG': 'SG',
  KR: 'KR', '韩国': 'KR', '首尔': 'KR', 'KOREA': 'KR',
  US: 'US', '美国': 'US', '洛杉矶': 'US', '纽约': 'US', '硅谷': 'US', '圣何塞': 'US', '西雅图': 'US', 'USA': 'US', 'UNITED STATES': 'US', 'OVERSEAS': 'US',
  GB: 'GB', 'UK': 'GB', '英国': 'GB', '伦敦': 'GB', 'LONDON': 'GB',
  DE: 'DE', '德国': 'DE', '法兰克福': 'DE', 'GERMANY': 'DE',
  NL: 'NL', '荷兰': 'NL', '阿姆斯特丹': 'NL', 'NETHERLANDS': 'NL',
  FR: 'FR', '法国': 'FR', '巴黎': 'FR',
  AU: 'AU', '澳大利亚': 'AU', '澳洲': 'AU', '悉尼': 'AU', 'AUSTRALIA': 'AU',
  BR: 'BR', '巴西': 'BR', '圣保罗': 'BR', 'BRAZIL': 'BR',
  CA: 'CA', '加拿大': 'CA', '多伦多': 'CA', '温哥华': 'CA',
  IN: 'IN', '印度': 'IN', '孟买': 'IN',
  RU: 'RU', '俄罗斯': 'RU', '莫斯科': 'RU',
  MY: 'MY', '马来西亚': 'MY', '吉隆坡': 'MY',
  TH: 'TH', '泰国': 'TH', '曼谷': 'TH',
  VN: 'VN', '越南': 'VN',
  PH: 'PH', '菲律宾': 'PH',
  ID: 'ID', '印度尼西亚': 'ID', '印尼': 'ID',
  TR: 'TR', '土耳其': 'TR',
  CH: 'CH', '瑞士': 'CH',
  SE: 'SE', '瑞典': 'SE',
  FI: 'FI', '芬兰': 'FI',
  IE: 'IE', '爱尔兰': 'IE',
  IT: 'IT', '意大利': 'IT',
  ES: 'ES', '西班牙': 'ES',
  PL: 'PL', '波兰': 'PL',
};

function isoToFlag(iso2: string): string {
  if (!/^[A-Z]{2}$/.test(iso2)) return '';
  return String.fromCodePoint(
    0x1f1e6 + iso2.charCodeAt(0) - 65,
    0x1f1e6 + iso2.charCodeAt(1) - 65
  );
}

/**
 * Resolves an ISO code, bracketed code like "[HK] 香港", city name like "东京",
 * or special service region like "ALISG" into a crisp Unicode flag emoji.
 */
export function countryFlag(input?: string): string {
  if (!input) return '';
  const trimmed = input.trim();
  const bracketM = trimmed.match(/\[([A-Z]{2,5})\]/);
  if (bracketM) {
    const code = bracketM[1].toUpperCase();
    if (REGION_CODE_MAP[code]) return isoToFlag(REGION_CODE_MAP[code]);
    if (code.length === 2) return isoToFlag(code);
    const tail2 = code.slice(-2);
    if (/^[A-Z]{2}$/.test(tail2)) return isoToFlag(tail2);
  }
  const upper = trimmed.toUpperCase();
  if (REGION_CODE_MAP[upper]) return isoToFlag(REGION_CODE_MAP[upper]);
  if (/^[A-Z]{2}$/.test(upper)) return isoToFlag(upper);
  for (const [k, iso] of Object.entries(REGION_CODE_MAP)) {
    if (k.length >= 2 && upper.includes(k.toUpperCase())) {
      return isoToFlag(iso);
    }
  }
  return '';
}

export function serverFlag(region?: string, nqCountry?: string, tags?: string[]): string {
  return (
    countryFlag(nqCountry) ||
    countryFlag(region) ||
    (tags || []).map((t) => countryFlag(t)).find(Boolean) ||
    '🌐'
  );
}
