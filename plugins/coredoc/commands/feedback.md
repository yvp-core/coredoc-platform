---
description: Draft session feedback on the Coredoc tooling (MCP tools, workflows, skills, task context), let the user review it, and submit it.
---

# coredoc feedback

Run the `coredoc-feedback` skill: reflect on how the coredoc MCP tools performed
this session (noise / incomplete / wrong / misleading descriptions / slow) and on
everything around them — workflow routing, plugin skill instructions, missing
task details, transport, host environment, and anything you hallucinated or
missed. Draft the feedback, show it to the user, ask **Submit as is / Add or
correct / Skip**, then call `submit_session_feedback` once with their review
recorded.
