# Accessibility and visual behaviour

## Product character

A quiet, light, document-oriented interface: white/off-white reading surface, dark neutral text, restrained separators and one clear action accent. No dark-first theme, gradients, neon, decorative dashboard cards, full-screen hero marketing blocks or draggable layout panels. Document authors cannot write colours, CSS, layouts or themes in V1. High-contrast/forced-colours support is a rendering concern, not new syntax.

System typography only; never ship user/container font files or fetch remote fonts. Body font stack: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif. Code stack: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace. Reading text 17px, line-height 1.65, content measure 72ch and maximum 800px, horizontal padding 24px desktop / 16px narrow. Paragraph gap 1em. H1 2em, H2 1.5em, H3 1.2em; retain semantic levels. Editor text 14px and line-height 1.55. Prose must wrap at 320 CSS px without horizontal page scrolling; code, wide tables and static charts may use labelled local scroll areas.

Controls remain compact and immediately associated with the surrounding explanation. Do not place them automatically in a side dashboard. Captions precede figure exploration controls. Error text appears near the relevant source/control and in one accessible status region. Reading must remain coherent with all controls untouched at their initial values.

## Tokens and geometry

Use stable implementation tokens: text #1F2328, surface #FFFFFF, secondary surface #F6F8FA, muted #59636E, border #D0D7DE, accent #0969DA, error #B42318. Focus ring: 2px solid accent with 2px offset. Tokens are reference UI decisions and must be verified for contrast in their actual combinations; listing a hex code is not a contrast certification.

Series palette in stable index order: #0072B2, #D55E00, #009E73, #CC79A7, #8C6D00, #6F4E7C. Always pair colour with a series name and, for lines, dash patterns `solid`, `6 3`, `2 3`, `8 3 2 3`, `1 2`, `10 3`. Scatter uses circle/square/triangle/diamond/cross/star by index. Pie legend always lists text values; selected marks receive a contrasting outline and text status. Do not claim all small marks meet a contrast target merely because this palette is selected; measure and adjust renderer outlines without changing semantic colour identity in an unrecorded way.

## Accessibility target and evidence

Target applicable WCAG 2.2 AA criteria for the reference editor/reader. This is a qualification target, not a conformance claim before testing. Primary reference S13 is normative external guidance; project-specific acceptance below is mandatory even where an automated tool cannot check it.

Every interactive control has a persistent visible label and accessible name. All functions are reachable by keyboard; native controls retain their expected behaviour. Focus order follows document order. Visible focus never disappears during a value update. At 200% text zoom, prose and controls remain usable; at 400% page zoom, reading reflows except inherently two-dimensional code/table/figure regions. Targets are at least 24x24 CSS px or have compliant separation; explicit primary buttons are at least 32px high.

Use semantic tables with caption, thead/th scope, and readable row counts. Long tabular content may scroll but must not trap focus. A chart's meaningful values/actions are exposed through the range explorer, labels, buttons and full table defined in the chart contract. SVG is decorative relative to that complete HTML alternative; do not add duplicate screen-reader announcements. Figure colour is never the sole way to identify a series, selected datum, invalid value or negative result.

Changes made by a control produce one polite status announcement summarizing the completed update, not the entire document and not every DOM mutation. Slider dragging may update visually per animation frame; announce after 150ms idle. Do not move focus to changed prose. False condition bodies are absent from tab/accessibility order. If a user action removes its own focused control, move focus to the nearest preceding still-visible control, else the article heading; announce the structural change. Rejected actions keep focus at the originating control.

Details use native summary semantics, support nested keyboard access and retain closed/open state on answer updates. Disabled Markdown tasks are not advertised as editable fields. Dialogs use a proper labelled dialog, focus containment and Escape/Cancel behaviour. No autoplay, blinking or motion is introduced; reduced-motion preferences are respected by disabling any host transition. Charts have no animation in V1.

## Manual acceptance protocol

Required runs: keyboard-only editor and reader on desktop; VoiceOver + actual Safari on macOS; NVDA + Firefox on Windows; one actual iPhone/iPad Safari reading/selection/export-open journey. Log browser/OS/assistive-tech versions, source fixture, actions, observed issues and reviewer. Emulated mobile or Playwright WebKit cannot substitute for those named manual checks. If an environment is unavailable, record BLOCKED and do not call the final gate PASS.

For each principal example: read headings; reach every control; modify answers; inspect a chart with the range; use a selected value; toggle legend; recover all-hidden; open data table; trigger and recover an invalid action; reset reading; open static/interactive export offline. Check names/values/announcements, focus retention and whether the text still explains the figure. Capture representative screenshots at 1440, 1024, 768, 390 and 320 CSS px, plus zoom/forced-colours cases. A screenshot's existence is not evidence of visual review; mark reviewer acceptance separately.
