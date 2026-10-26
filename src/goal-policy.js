export const MIN_RETRY = 3 * 60000;
export const MAX_RETRY = 30 * 60000;
export const RESUME_COOLDOWN = 10 * 60000;

export function quotaFromResponse(response, now = Date.now(), expectedID) {
  const q = { known: false, allowed: false, remaining: null, resetAt: null, checkedAt: now };
  if (!response || (response.accountId && response.accountId !== expectedID)) return q;
  if (typeof response.ordinaryUsageAllowed === 'boolean') {
    q.known = true;
    q.allowed = response.ordinaryUsageAllowed;
  }
  const limit = response.rateLimitsByLimitId?.codex || response.rateLimits;
  for (const window of [limit?.primary, limit?.secondary]) {
    if (!Number.isFinite(window?.usedPercent)) continue;
    if (window.usedPercent < 0 || window.usedPercent > 100) return { ...q, known: false, allowed: false };
    q.remaining = Math.min(q.remaining ?? 100, 100 - window.usedPercent);
    if (window.usedPercent >= 100) {
      q.known = true;
      q.allowed = false;
      const reset = window.resetsAt * 1000;
      if (Number.isFinite(reset) && reset > now) q.resetAt = Math.max(q.resetAt || 0, reset);
    }
  }
  if (limit?.spendControlReached || limit?.rateLimitReachedType) { q.known = true; q.allowed = false; }
  return q;
}
export function eligibleQuota(q, hold = 0, now = Date.now()) {
  return q?.known === true && q.allowed === true && now >= hold
    && Number.isFinite(q.checkedAt) && now - q.checkedAt >= 0 && now - q.checkedAt <= 60000;
}
export function accountRotation(current, order = ['jey', 'americano', 'hb']) {
  const index = order.indexOf(current);
  return index < 0 ? [...order] : [...order.slice(index + 1), ...order.slice(0, index)];
}
export function chooseAccount(current, quotas, holds = {}, autoSwitch = true, now = Date.now(), order = ['jey', 'americano', 'hb']) {
  if (eligibleQuota(quotas[current], holds[current], now)) return current;
  return autoSwitch ? accountRotation(current, order).find((id) => eligibleQuota(quotas[id], holds[id], now)) || null : null;
}
export function nextCheck(quotas, holds = {}, failures = 0, now = Date.now()) {
  if (failures) return now + Math.min(MAX_RETRY, MIN_RETRY * 2 ** Math.min(10, failures - 1));
  const ready = Object.entries(quotas).map(([id, q]) => Math.max(q.resetAt || now + MIN_RETRY, holds[id] || 0));
  return now + Math.max(MIN_RETRY, Math.min(MAX_RETRY, (ready.length ? Math.min(...ready) - now : MIN_RETRY)));
}
