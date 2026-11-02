---
name: first-party-intent-calculator
description: PLACEHOLDER. Replace this file with the real First-Party Intent Calculator skill exported from claude.ai (SKILL.md plus any reference files in this folder).
---

# First-Party Intent Calculator (placeholder methodology)

> Replace this folder's contents with the real skill. Every `.md`, `.txt` and `.json`
> file in `skill/` is loaded (SKILL.md first) and sent to the OpenRouter model as its
> system prompt. Rebuild the image after changing it.

## Goal
Score each account 0 to 100 on first-party buying intent from the customer's own
website, email, form, webinar and CRM activity. Hot 70 to 100, Warm 40 to 69, Watch 0 to 39.

## How to read signals
- Strongest: demo or contact-sales requests, booked sales meetings, open opportunities.
- Strong: pricing page visits, webinar attendance, email replies, demo/contact page visits, gated content downloads.
- Moderate: webinar registrations without attendance, product, integration, comparison and case study pages, sales calls and emails logged in CRM.
- Weak: email clicks, email opens, general blog or home page visits.
- Not a signal: careers, login, legal pages, bounces, deliveries, sends.
- Negative: unsubscribes.

## Weighting principles
- Recent activity matters more than old activity.
- Several engaged people at one account (a buying group) is stronger than one very active person.
- Repeated low-value events (dozens of opens) must not outweigh one high-value action.
- If the customer says a channel is their main buying signal, emphasise it.

## Writing style for explanations
Plain business English for marketing and sales leaders. Name the concrete signals behind
each score, say how recent they are, and give one practical next step. No jargon, no hype,
and never invent facts that are not in the data.
