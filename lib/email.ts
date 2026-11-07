const LOCAL_PART = "[a-zA-Z0-9!#$%&'*+?^_`{|}~-]+(?:\\.[a-zA-Z0-9!#$%&'*+?^_`{|}~-]+)*";
const DOMAIN_LABEL = "[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?";
const EMAIL_SOURCE = `${LOCAL_PART}@${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*\\.(?:[a-zA-Z]{2,63}|xn--[a-zA-Z0-9-]{2,59})`;
const EMAIL_PATTERN = new RegExp(EMAIL_SOURCE, "g");
const VALID_EMAIL_PATTERN = new RegExp(`^${EMAIL_PATTERN.source}$`);

export function extractBestEmail(content: string, website: string): string | null {
  const decoded = decodeEmailMarkup(content);
  const candidates = new Set<string>();

  for (const match of decoded.matchAll(EMAIL_PATTERN)) {
    const email = normalizeEmail(match[0]);
    if (email) candidates.add(email);
  }

  const obfuscated = decoded
    .replace(/(?:&#64;|&#x40;|&commat;|%40)/gi, "@")
    .replace(/(?:&#46;|&#x2e;|&period;|&dot;|%2e)/gi, ".")
    .replace(/(?:\[\s*(?:dot|punto)\s*\]|\(\s*(?:dot|punto)\s*\)|\{\s*(?:dot|punto)\s*\}|\s+(?:dot|punto)\s+)/gi, ".")
    .replace(/(?:\[\s*(?:at|arroba)\s*\]|\(\s*(?:at|arroba)\s*\)|\{\s*(?:at|arroba)\s*\})/gi, "@")
    .replace(/\s*@\s*/g, "@")
    .replace(/\s*\.\s*/g, ".");

  for (const match of obfuscated.matchAll(EMAIL_PATTERN)) {
    const email = normalizeEmail(match[0]);
    if (email) candidates.add(email);
  }

  const atSeparated = obfuscated.matchAll(
    /([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+)\s+(?:at|arroba)\s+([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+\.[a-zA-Z]{2,})/gi,
  );
  for (const match of atSeparated) {
    const email = normalizeEmail(`${match[1]}@${match[2]}`);
    if (email) candidates.add(email);
  }

  const websiteHost = getWebsiteHost(website);
  return [...candidates]
    .map((email) => {
      const [local, domain] = email.split("@");
      if (!local || !domain || /(?:example\.|test\.|invalid$)/i.test(domain)) return null;
      if (domain === "mhtml.blink" || domain.endsWith(".mhtml.blink")) return null;
      if (/^(?:noreply|no-reply|donotreply|do-not-reply|mailer-daemon)$/i.test(local)) return null;
      let score = 0;
      if (/^(?:info|contact|hello|sales|office|enquiries|inquiries|general|business|support|admin)$/i.test(local)) score += 5;
      if (domain === websiteHost || domain.endsWith(`.${websiteHost}`)) score += 3;
      if (/^(?:privacy|abuse|webmaster|security)$/i.test(local)) score -= 4;
      return { email, score };
    })
    .filter((candidate): candidate is { email: string; score: number } => candidate !== null)
    .sort((left, right) => right.score - left.score || left.email.localeCompare(right.email))[0]?.email ?? null;
}

export function isValidEmailAddress(value: string): boolean {
  const email = normalizeEmail(value.trim());
  if (!email) return false;
  const domain = email.split("@")[1];
  return Boolean(domain && domain !== "mhtml.blink" && !domain.endsWith(".mhtml.blink"));
}

function decodeEmailMarkup(content: string): string {
  const protectedEmails: string[] = [];
  const structuredEmails = extractStructuredEmails(content);
  let decoded = content
    .replace(/\\u0040/gi, "@")
    .replace(/\\u002e/gi, ".")
    .replace(/\\x40/gi, "@")
    .replace(/\\x2e/gi, ".");

  decoded = decoded.replace(/&(#x[0-9a-f]+|#\d+|commat|period|dot|colon|amp|lt|gt|quot|apos|nbsp);/gi, (entity, value: string) => {
    const lower = value.toLowerCase();
    if (lower === "commat") return "@";
    if (lower === "period" || lower === "dot") return ".";
    if (lower === "colon") return ":";
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower === "nbsp") return " ";
    const code = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });

  decoded = decoded.replace(/data-cfemail\s*=\s*["']([a-f0-9]+)["']/gi, (attribute, encoded: string) => {
    const email = decodeCloudflareEmail(encoded);
    if (email) protectedEmails.push(email);
    return "";
  });

  const mailtoAddresses: string[] = [];
  decoded = decoded.replace(/mailto:([^"'?\s<>]+)/gi, (link, address: string) => {
    try {
      mailtoAddresses.push(decodeURIComponent(address));
    } catch {
      mailtoAddresses.push(address.replace(/%40/gi, "@").replace(/%2e/gi, "."));
    }
    return link;
  });

  decoded = decoded
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, " ")
    .replace(/(^|[\s(])(?:www\.)[^\s<>"')\]]+/gi, "$1 ");
  if (mailtoAddresses.length > 0 || protectedEmails.length > 0 || structuredEmails.length > 0) {
    decoded += `\n${[...mailtoAddresses, ...protectedEmails, ...structuredEmails].join("\n")}`;
  }
  return decoded;
}

function extractStructuredEmails(content: string): string[] {
  const emails: string[] = [];
  const scripts = content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi);

  for (const [, attributes, body] of scripts) {
    if (!/\btype\s*=\s*(?:"application\/ld\+json(?:\s*;[^"]*)?"|'application\/ld\+json(?:\s*;[^']*)?'|application\/ld\+json(?:\s|>))/i.test(attributes)) {
      continue;
    }

    try {
      const structuredData: unknown = JSON.parse(body);
      collectStructuredEmails(structuredData, emails);
    } catch {
      continue;
    }
  }

  return emails;
}

function collectStructuredEmails(value: unknown, emails: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredEmails(item, emails);
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, nestedValue] of Object.entries(value)) {
    if (key.toLowerCase() === "email" && typeof nestedValue === "string") {
      emails.push(nestedValue);
    } else {
      collectStructuredEmails(nestedValue, emails);
    }
  }
}

function decodeCloudflareEmail(encoded: string): string | null {
  if (encoded.length < 4 || encoded.length % 2 !== 0) return null;
  const key = Number.parseInt(encoded.slice(0, 2), 16);
  let email = "";
  for (let index = 2; index < encoded.length; index += 2) {
    const value = Number.parseInt(encoded.slice(index, index + 2), 16);
    if (Number.isNaN(value)) return null;
    email += String.fromCharCode(value ^ key);
  }
  return email;
}

function normalizeEmail(candidate: string): string | null {
  const email = candidate.replace(/^[<("'`\s]+|[>"),;:!?'`\s]+$/g, "").toLowerCase();
  return VALID_EMAIL_PATTERN.test(email) && email.length <= 254 ? email : null;
}

function getWebsiteHost(website: string): string {
  try {
    return new URL(website).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return website.toLowerCase();
  }
}
