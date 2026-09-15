// Shared by Analytics and ban clients in this process: at most 150 starts/minute.
let nextStart = 0, blockedUntil = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function apiSlot() {
  const slot = Math.max(Date.now(), nextStart, blockedUntil); nextStart = slot + 400;
  await pause(Math.max(0, slot - Date.now()));
  if (Date.now() < blockedUntil) { const error = new Error('Cloudflare API cooldown'); error.retryAt = blockedUntil; throw error; }
}
export function createCloudflare({ token = process.env.CF_API_TOKEN, key = process.env.CF_API_KEY, email = process.env.CF_API_EMAIL, fetcher = fetch } = {}) {
  return async (path, { method = 'GET', body } = {}) => {
    if (!token && !(key && email)) throw new Error('ตั้งค่า CF_API_TOKEN หรือ CF_API_KEY และ CF_API_EMAIL');
    if (fetcher === fetch) await apiSlot();
    const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
      method, signal: AbortSignal.timeout(10000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : { 'X-Auth-Key': key, 'X-Auth-Email': email }), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (response.status === 429) {
      const header = response.headers?.get('retry-after');
      const seconds = Number(header);
      const delay = header && Number.isFinite(seconds) ? seconds * 1000 : header && Number.isFinite(Date.parse(header)) ? Date.parse(header) - Date.now() : 300000;
      blockedUntil = Date.now() + Math.max(1000, delay);
      const error = new Error('Cloudflare จำกัด API: รอ Retry-After แล้วลองใหม่'); error.retryAt = blockedUntil; throw error;
    }
    const data = await response.json();
    if (!response.ok || data.success === false || data.errors?.length) throw new Error(`Cloudflare API HTTP ${response.status ?? 200}: ตรวจ credentials, permissions และสิทธิ์ dataset`);
    return data;
  };
}
