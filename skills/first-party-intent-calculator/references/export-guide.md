# Export Guide

Which exports to pull and what columns matter. Menu names change often, so describe the export in general terms and suggest the person check their tool's help center if a menu has moved.

## What each export needs

Every file needs a **date** and either an **email** or a **company domain**. Everything else helps but is optional.

| Source | Must have | Nice to have |
|---|---|---|
| Website analytics | Date, page URL or path, company domain or visitor email | Company name, page title |
| Email platform | Date, recipient email, event type (open, click, reply) | Campaign name, clicked link |
| Form submissions | Date, email, form name | Company name |
| Webinar list | Email, registration or webinar date | Attended (yes/no), company, webinar title |
| CRM activity | Date, contact email, activity type | Account name, description |

An export window of the last 90 days works well, since older activity counts for very little.

## Common tools

**Website:** GA4 rarely includes emails or company names on its own. Visitor identification tools (reverse-IP or account identification tools), or a CRM's own website tracking (HubSpot, Salesforce Account Engagement, Marketo) give the company domain or contact email needed here. A page-level export with company domain works well.

**Email:** Mailchimp, HubSpot, Marketo, Klaviyo, Brevo, and similar tools can export campaign activity by recipient. Ask for the activity or engagement export (one row per open or click), not the campaign summary.

**Forms:** Export submissions from the form tool or CRM (HubSpot forms, Gravity Forms, Typeform, Webflow, Salesforce web-to-lead). Keep the form name column, since that decides whether a row counts as a demo request, case study download, or whitepaper download.

**Webinars:** Zoom, ON24, GoTo Webinar, and Livestorm all offer registrant and attendee reports. One file with an "Attended" column is ideal. Separate registrant and attendee files also work.

**CRM:** Export activities or engagements (meetings, inbound replies, calls) with the contact email. Rep-logged outbound activity is set aside automatically.

## Importing scores back into a CRM

General approach for any CRM:

1. Create custom fields first: Intent Score (number), Intent Level (dropdown: Hot, Warm, Watch), Intent Reason (text), Intent Scored On (date).
2. Import `intent_scores_accounts.csv` to update company/account records, matching on **Domain**.
3. Optionally import `intent_scores_contacts.csv` to contacts, matching on **Email**, to bring the account level onto each contact.
4. Build a view or list filtered to Intent Level = Hot for the sales team.
5. Rerun weekly or monthly and reimport to keep scores fresh.

HubSpot, Salesforce, and Zoho all support updating existing records by import with a matching key. Suggest the person confirm the exact matching option in their CRM's import screen.
