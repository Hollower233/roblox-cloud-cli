import { AppError } from '../core/errors.js';
import type { JsonObject } from '../cloud/common.js';

export type EventTextField = 'title' | 'subtitle' | 'description';
const textRules = {
  title: { maxLength: 25, required: true, allowEmpty: false },
  subtitle: { maxLength: 25, required: true, allowEmpty: false },
  description: { maxLength: 1000, required: false, allowEmpty: true },
} as const;
const rules = {
  version: 1,
  counting: 'utf16-code-units',
  countingNote: 'JavaScript string.length: a supplementary emoji counts as 2; variation selectors, joiners and combining marks also count. Text is never trimmed, normalized or truncated automatically.',
  text: textRules,
  source: {
    kind: 'creator-dashboard-frontend', verifiedOn: '2026-11-13',
    page: 'https://create.roblox.com/dashboard/creations/experiences/{universeId}/events/create',
    constants: 'https://assets.create.roblox.com/5fdbdeae8b32da612bbd99ed51bdf0ade3752cd0/_next/static/chunks/18zptrgzlc58h.js',
    form: 'https://assets.create.roblox.com/5fdbdeae8b32da612bbd99ed51bdf0ade3752cd0/_next/static/chunks/066gc__slcu_c.js',
    note: 'Creator Dashboard form rules, not length metadata returned by the Game Events API. Offline snapshot; platform rules may change.',
  },
  schedule: ['Explicit ISO timezone and seconds required.', 'End must be after start; one-sided updates are checked against the existing schedule.'],
  visibility: ['Only public/private can be written; moderated is server-managed.', 'Private events can be edited, then made public by updating the same event ID.'],
  serverChecks: ['Text moderation and other business constraints', 'Account/group permissions and API key scope', 'Event quotas, schedule eligibility and venue access', 'Image moderation and display'],
  note: 'Local validation does not submit a request and does not guarantee Roblox acceptance. Use --dry-run to preview; rbx events rules shows these rules without credentials.',
};
export function eventRules() { return structuredClone(rules); }

export function validateEventText(field: EventTextField, value: unknown): string {
  const rule = textRules[field];
  if (typeof value !== 'string') throw new AppError('ARGUMENT_ERROR', `Event ${field} must be a string. Run rbx events rules.`);
  if (!rule.allowEmpty && !value.trim()) throw new AppError('ARGUMENT_ERROR', `Event ${field} must not be empty or whitespace. Run rbx events rules.`);
  if (value.length > rule.maxLength) throw new AppError('ARGUMENT_ERROR', `Event ${field} is too long: ${value.length}/${rule.maxLength} UTF-16 code units (${value.length - rule.maxLength} over). Emoji and variation selectors also count. Shorten this field; run rbx events rules.`);
  return value;
}

/** Reports only supplied fields, so partial updates do not invent replacement values. */
export function eventTextSummary(fields: JsonObject) {
  const text: { field: EventTextField; length: number; maxLength: number; remaining: number }[] = [];
  for (const field of ['title', 'subtitle', 'description'] as const) {
    if (fields[field] === undefined) continue;
    const value = validateEventText(field, fields[field]);
    text.push({ field, length: value.length, maxLength: textRules[field].maxLength, remaining: textRules[field].maxLength - value.length });
  }
  return { scope: 'local-text', counting: rules.counting, text, ruleSource: rules.source.kind, serverChecksIncluded: false, note: rules.note };
}
