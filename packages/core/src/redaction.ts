const SECRET_KEY_RE = /(SECRET|PRIVATE|PASSWORD|PASS|TOKEN|API_KEY|ACCESS_KEY|CREDENTIAL|DATABASE_URL|DB_URL|REDIS_URL|REDIS_URI|RPC_URL|(^|_)KEY($|_))/i;

export function isSecretLikeKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export function redactValue(key: string, value: string, showSecrets = false): string {
  if (showSecrets) return value;
  return isSecretLikeKey(key) ? (value ? '<redacted>' : '') : value;
}

export function redactRecord(values: Record<string, string>, showSecrets = false): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, redactValue(key, value, showSecrets)]));
}
