export type SafeLogFields = Readonly<Record<string, string | number | boolean>>;
const allowedKey =
  /^(event|code|count|bytes|durationMs|version|engine|anonymousId)$/;
export function safeLog(event: string, fields: SafeLogFields = {}): void {
  const invalid = Object.keys(fields).find(key => !allowedKey.test(key));
  if (invalid) throw new Error(`UNSAFE_LOG_FIELD:${invalid}`);
  console.info('[AIContextPack]', { event, ...fields });
}
