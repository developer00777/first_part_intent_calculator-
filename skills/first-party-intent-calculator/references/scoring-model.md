# Scoring Model

How the First-Party Intent Calculator turns activity into a 0 to 100 account score, and how to tune it. All settings live in `assets/default_config.json`.

## 1. Signal points

Each action is classified into a signal type and given base points by how close it sits to a buying decision.

| Signal | Points | Typical source |
|---|---|---|
| Email open | 1 | Email platform |
| Other page visit | 2 | Website (about, careers, legal) |
| Blog visit | 3 | Website, newsletter signup forms |
| Email click | 5 | Email platform |
| Webinar registration | 6 | Webinar list (registered, did not attend) |
| Whitepaper download | 8 | Forms, website downloads |
| Product page visit | 10 | Website (product, solution, features, case study pages) |
| Webinar attendance | 12 | Webinar list |
| Email reply | 12 | Email platform, CRM inbound replies |
| Case study download | 15 | Forms |
| Pricing page visit | 20 | Website |
| Demo or contact request | 30 | Forms |
| Meeting booked | 30 | CRM |

Rows that show the seller's own activity (emails sent or delivered, outbound calls, notes, tasks) and list hygiene events (bounces, unsubscribes) are set aside, since they don't reflect buyer interest.

## 2. Recency

Base points are multiplied by how recent the action is, measured from the as-of date.

| Age | Multiplier |
|---|---|
| 0 to 7 days | 100% |
| 8 to 30 days | 50% |
| 31 to 90 days | 20% |
| Over 90 days | 0% |

## 3. Repeat cap

Each contact can contribute the same signal type at most 5 times (the most recent ones are kept). This stops one very active visitor, or a bot, from filling the score alone, while still rewarding repeat interest such as several pricing page visits.

## 4. Buying group boost

B2B purchases usually involve several people, so engagement from more contacts at the same company lifts the score.

| Engaged contacts | Boost |
|---|---|
| 2 | +10% |
| 3 or more | +25% |

Anonymous visits (domain only, no email) count toward points but not toward the contact total. Personal email domains (gmail.com and similar) are set aside because they can't be linked to a company.

## 5. Final score

`score = 100 x (1 - e^(-weighted_points x boost / saturation_points))`, capped at 100.

With the default `saturation_points` of 50:

| Weighted points | Score |
|---|---|
| 25 | about 40 (Warm) |
| 60 | about 70 (Hot) |
| 115 | about 90 |

The curve rises quickly and levels off, so a few strong recent actions (for example, a demo request plus two pricing visits this week) reach Hot, while a long tail of light activity stays in Watch or Warm. Raw points are also included in the CSV for anyone who wants the uncapped number.

## 6. Levels

| Score | Level | Suggested action |
|---|---|---|
| 70 to 100 | Hot | Sales outreach this week |
| 40 to 69 | Warm | Targeted nurture content |
| 0 to 39 | Watch | Keep in general campaigns |

## Tuning guide

| If the person says... | Adjust |
|---|---|
| "Webinars are our strongest signal" | Raise `webinar_attended` points (for example to 20) |
| "Our sales cycle is long, 6+ months" | Widen recency windows (14 / 60 / 180 days) |
| "Almost everything shows as Hot" | Raise `saturation_points` (for example to 80) or raise the Hot threshold |
| "Hardly anything reaches Hot" | Lower `saturation_points` (for example to 35), or check the as-of date |
| "We sell to single decision makers" | Reduce or remove `buying_group_boost` |
| "Email opens are unreliable for us" (privacy features inflate opens) | Set `email_open` to 0 |
| "We have a free trial" | Map trial signups to `demo_request` via the signal column |

Signal keys can be added to the config freely. Any new key can be used through the optional `signal` column in the events file.
