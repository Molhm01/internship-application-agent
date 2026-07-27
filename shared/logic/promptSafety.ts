import type { PromptInjectionAssessment } from '../schemas/ai.js';

const INJECTION_RULES: ReadonlyArray<{ pattern: RegExp; warning: string }> = [
  {
    pattern: /\bignore (?:all |any )?(?:previous|prior|system) instructions?\b/i,
    warning: 'Untrusted text attempts to override system instructions.',
  },
  {
    pattern:
      /\b(reveal|print|show|repeat)\b.{0,40}\b(system prompt|profile|resume|secret|token)\b/i,
    warning: 'Untrusted text requests private context or system instructions.',
  },
  {
    pattern: /\b(run|execute)\b.{0,30}\b(code|javascript|command|script)\b/i,
    warning: 'Untrusted text requests code execution.',
  },
  {
    pattern:
      /\b(click|submit|upload|navigate|send)\b.{0,40}\b(form|application|file|data|profile|resume)\b/i,
    warning: 'Untrusted text requests a browser or data-transfer action.',
  },
  {
    pattern: /\bhttps?:\/\/\S+\b.{0,40}\b(send|post|upload|exfiltrat)\b/i,
    warning: 'Untrusted text appears to request external data transfer.',
  },
];

export function assessPromptInjection(
  ...texts: Array<string | undefined>
): PromptInjectionAssessment {
  const combined = texts.filter(Boolean).join('\n');
  const warnings = INJECTION_RULES.filter(({ pattern }) => pattern.test(combined)).map(
    ({ warning }) => warning,
  );
  return { detected: warnings.length > 0, warnings: [...new Set(warnings)] };
}

export function containsUnexpectedModelInstructions(text: string): boolean {
  return (
    /```(?:javascript|js|typescript|ts|python|bash|powershell|html)/i.test(text) ||
    /\b(?:click|submit|navigate|upload|execute|run)\s+(?:the |this )?(?:button|form|code|script|command)\b/i.test(
      text,
    ) ||
    /\b(system prompt|developer message|tool call|browser action)\b/i.test(text)
  );
}
