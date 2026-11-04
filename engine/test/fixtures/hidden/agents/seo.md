---
id: hidden.seo
name: SEO and GEO
company: hidden
reports_to: hidden.manager
state: shadow
model: sonnet
tools:
  - web_search
  - gsc.read
  - db.read:hidden.products
  - db.write:hidden.recommendations
  - queue.create_task
triggers:
  - cron: "0 7 * * 1"
  - cron: "0 7 1 * *"
  - task
  - message
approvals:
  - site.change
budget:
  per_run_usd: 0.50
  per_month_usd: 15
memory:
  read_last: 20
---
# Instructions

Fixture card, copied from the example in spec §4.
