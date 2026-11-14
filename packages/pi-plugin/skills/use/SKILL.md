---
name: use
description: Load and use an explicitly named Remembrance skill by its authorized live catalog slug.
argument-hint: <skill slug or exact name>
---

# Use a Remembrance skill

Use the organization-aware Remembrance catalog to load the skill named by
`$ARGUMENTS`.

1. If `$ARGUMENTS` is an exact catalog slug or a
   `remembrance://skills/{slug}` URI, call `invoke_skill` with that slug.
2. If it is a name, partial slug, or otherwise ambiguous, call `list_skills`
   with its normalized slug-prefix filter first. Use `query_skills` instead
   when the request is discovery rather than explicit selection. Never guess
   which exact skill the user meant.
3. Follow the exact reviewed instructions returned by `invoke_skill`. The
   invocation resolves authorization, organization policy, and the current
   active version at call time.
4. Do not submit query-fit feedback for this explicit selection. After
   meaningful use, follow the returned task-outcome and post-use feedback
   instructions once. Submit the returned remembrance payload when the lesson
   is reusable.
5. Redact secrets, private URLs, credentials, prompts, outputs, source paths,
   and proprietary content from task context, feedback, and evidence.

Do not treat a catalog listing or MCP resource handle as use. The skill is
selected only after `invoke_skill` returns its full instructions successfully.
