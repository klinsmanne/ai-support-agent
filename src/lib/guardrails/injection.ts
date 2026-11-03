/**
 * Heuristic prompt-injection detector (OWASP LLM01). Runs on every inbound message *before*
 * the model sees it. It is one signal among several: the model's own classification adds a
 * second, and the real defense is structural — inbound text is wrapped as data, write tools
 * are removed on suspicion, and the policy engine denies actions regardless of what the text says.
 */

interface Rule {
  id: string;
  weight: number;
  pattern: RegExp;
}

const RULES: Rule[] = [
  {
    id: "override_instructions",
    weight: 3,
    pattern:
      /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|system)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?|polic(y|ies))\b/i,
  },
  {
    id: "role_reassignment",
    weight: 2,
    pattern:
      /\b(you are now|from now on you|act as|pretend to be|roleplay as|new persona|developer mode|jailbreak|DAN\b)/i,
  },
  {
    id: "system_prompt_probe",
    weight: 3, // asking for the prompt has no legitimate support use, so it flags on its own
    pattern:
      /\b(system prompt|your (instructions|rules|prompt)|reveal (your|the) (prompt|instructions)|print (your|the) (prompt|instructions)|hidden instructions)\b/i,
  },
  {
    id: "fake_authority",
    weight: 2,
    pattern:
      /\b(i am|i'm|this is|as) (an? |the |your )?(admin|administrator|developer|supervisor|manager|anthropic|openai|google|ceo|owner)\b|\b(authorized|approved) (by|from) (management|admin|the company)\b|\bi (hereby )?authori[sz]e you\b/i,
  },
  {
    id: "tool_or_policy_manipulation",
    weight: 2,
    pattern:
      /\b(call|run|execute|invoke) (the )?(tool|function|issue_refund|update_order)\b|\b(set|change|raise|increase) (the )?(refund )?(limit|threshold|policy)\b/i,
  },
  {
    id: "delimiter_spoofing",
    weight: 3,
    pattern:
      /<\/?(system|instructions?|untrusted[_-]?\w*|assistant|tool_result)>|\[\/?(INST|SYS)\]|^\s*(system|assistant)\s*:/im,
  },
  { id: "encoded_payload", weight: 1, pattern: /\b[A-Za-z0-9+/]{120,}={0,2}\b/ },
  { id: "large_refund_demand", weight: 1, pattern: /\brefund (me )?\$?\s?\d{3,}/i },
  // Spanish / French variants for multilingual inboxes
  {
    id: "override_instructions_es_fr",
    weight: 3,
    pattern:
      /\b(ignora|olvida) (tus|las) instrucciones\b|\b(ignore[zr]?|oublie[zr]?) (tes|vos|les) instructions\b/i,
  },
];

export interface InjectionVerdict {
  suspected: boolean;
  score: number;
  signals: string[];
}

export function detectInjection(text: string, threshold = 3): InjectionVerdict {
  const normalized = text.normalize("NFKC").replace(/[​-‏⁠﻿]/g, ""); // strip zero-width tricks
  const signals = RULES.filter((r) => r.pattern.test(normalized)).map((r) => r.id);
  const score = RULES.filter((r) => signals.includes(r.id)).reduce((s, r) => s + r.weight, 0);
  return { suspected: score >= threshold, score, signals };
}

/**
 * Wraps untrusted text for inclusion in a prompt. Any copy of our delimiter inside the text is
 * neutralized so the content can never "close" the data block and smuggle in instructions.
 */
export function wrapUntrusted(label: string, text: string): string {
  const safe = text.replace(/<\/?untrusted_[a-z_]*>/gi, "[removed-tag]");
  return `<untrusted_${label}>\n${safe}\n</untrusted_${label}>`;
}
