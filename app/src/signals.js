// Rule-based classification of an event into a canonical signal key (see config/scoring.json).
// Used as the fallback, and as the starting point the LLM can override with the skill's judgement.

const has = (re, s) => re.test(s);

export function classifyByRules(source, text, attended) {
  const t = String(text || "").toLowerCase();
  if (has(/unsubscri|opt.?out/, t)) return "unsubscribe";

  switch (source) {
    case "web":
      if (has(/pricing|\/plans?\b|\/price|\/cost|\/quote/, t)) return "pricing_visit";
      if (has(/demo|contact|talk.?to|get.?started|free.?trial|\/trial|book|request|sales/, t)) return "high_intent_page";
      if (has(/case.?stud|customer|compare|\bvs\b|-vs-|alternative|integration|product|solution|feature|platform|security|roi/, t)) return "research_page";
      if (has(/careers|jobs|login|signin|sign-in|privacy|terms|cookie/, t)) return "ignore";
      return "web_visit";

    case "email":
      if (has(/bounce|deferred|dropped|spam|complain|delivered|sent|processed/, t) && !has(/open|click|repl/, t)) return "ignore";
      if (has(/repl/, t)) return "email_reply";
      if (has(/click/, t)) return "email_click";
      if (has(/open/, t)) return "email_open";
      return "email_open";

    case "form":
      if (has(/demo|contact|sales|quote|pricing|trial|consult|meeting|talk/, t)) return "demo_request";
      if (has(/webinar|event|register/, t)) return "webinar_registered";
      if (has(/download|ebook|e-book|whitepaper|white paper|guide|report|checklist|template|case.?stud|gated/, t)) return "content_download";
      if (has(/newsletter|subscribe|blog/, t)) return "form_submission";
      return "form_submission";

    case "webinar":
      if (attended === true || has(/\battended\b|attendee|joined/, t)) return "webinar_attended";
      return "webinar_registered";

    case "crm":
      if (has(/opportunit|deal|proposal|pipeline/, t)) return "opportunity";
      if (has(/demo|meeting|appointment|discovery/, t)) return "meeting";
      if (has(/call|email|linkedin|inmail|connected/, t)) return "crm_call";
      return "crm_touch";

    default:
      return "web_visit";
  }
}
