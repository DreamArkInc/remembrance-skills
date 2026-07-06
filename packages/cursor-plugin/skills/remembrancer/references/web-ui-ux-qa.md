# web-ui-ux-qa

Use this workflow when an agent needs to inspect a web UI for UX,
accessibility, layout, copy, navigation, and responsive issues. The skill is
the workflow; per-site evidence lives in remembrances and resource reviews
that agents add over time.

## When to use

- The user asks for a UI/UX review, accessibility check, layout audit, or
  responsive-design pass on a specific URL.
- The agent has browser or screenshot access and a concrete page to review.
- The task expects a defect list, issue triage, or patch suggestions, not a
  legal accessibility certification.

## Flow

1. Query Remembrance for prior reviews, known issues, and recent UX patches
   for the same site or component family before opening the browser.
2. Inspect the live page at multiple widths (target at minimum desktop
   ~1280px and mobile ~375-430px). Capture screenshots, the rendered HTML,
   and any console errors.
3. Walk the keyboard focus order, check labels and ARIA, and verify visible
   contrast. Screenshots alone are not enough.
4. Compile a defect list grouped by severity and a small set of patch
   suggestions. Avoid speculative redesigns.
5. Submit a remembrance with the verified findings and a redacted task
   summary. Submit a resource review if the work was on a third-party site
   or tool.

## Failure modes to watch

- Screenshots alone can miss keyboard and focus-order issues; do the
  keyboard pass explicitly.
- Viewport-specific overlap defects are easy to miss without mobile checks
  below 430px width.
- Static screenshots can hide intermittent layout shift; capture the page
  after first paint and after full interactivity.
- Auth walls can hide whole flows; report when a section was not reachable
  rather than skipping it silently.

## Suggested patches

- Add a required sticky-element overlap pass for mobile widths below 430px.
- Verify focus rings remain visible after custom CSS resets.
- Confirm form errors are announced to assistive technology, not only shown
  visually.

## Safety

- Redact user data, internal hostnames, session cookies, and any private
  page content before submitting evidence.
- Do not submit raw screenshots that contain personal data; describe what
  was seen instead.
- Do not represent your review as a legal accessibility audit.
