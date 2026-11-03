---
id: hidden.manager
name: Hidden Library manager
company: hidden
reports_to: hq.chief
state: draft
model: opus
tools:
  - db.read:hidden.job_runs
  - github.trigger_workflow:nadav-hq/hidden-site/scout.yml
  - queue.create_task
  - telegram.notify
  - memory.write
triggers:
  - cron: "0 9 * * 0"
  - task
  - message
approvals:
  - site.settings_change
budget:
  per_run_usd: 1.00
  per_month_usd: 10
memory:
  read_last: 20
---
# Instructions

Fixture card. Supervises the Hidden Library site jobs; does not run them.
