/**
 * Milo/EDS rule file contents for .claude/rules/.
 * Sourced from claude-code-guide-for-victor.md.
 * Written by `pim init` when user opts into EDS tooling setup.
 */

export const MILO_BLOCKS_RULE = `---
paths:
  - "libs/blocks/**"
---

# Milo Block Development Rules

These rules override generic EDS block patterns. Milo blocks differ from standard EDS blocks.

## Export Pattern

Milo blocks export \`init\`, not \`decorate\`:

\`\`\`javascript
// CORRECT for milo
export default function init(block) { ... }

// WRONG -- this is generic EDS, not milo
export default async function decorate(block) { ... }
\`\`\`

## DOM Creation

Use \`createTag()\` from utils, not \`document.createElement()\`:

\`\`\`javascript
import { createTag } from '../../utils/utils.js';

// CORRECT
const div = createTag('div', { class: 'my-wrapper' });

// WRONG
const div = document.createElement('div');
div.className = 'my-wrapper';
\`\`\`

## CSS Loading

Every block must load its own styles via \`loadStyle()\`:

\`\`\`javascript
import { createTag, loadStyle } from '../../utils/utils.js';

export default function init(block) {
  loadStyle(import.meta.url);
  // ... block logic
}
\`\`\`

## Import Extensions

All imports must include explicit \`.js\` extensions:

\`\`\`javascript
// CORRECT
import { createTag } from '../../utils/utils.js';

// WRONG
import { createTag } from '../../utils/utils';
\`\`\`

## Test File Required

Every block must have a corresponding test file at:
\`test/blocks/<block-name>/<block-name>.test.js\`

After creating or modifying a block, run:
\`\`\`bash
npm run test:file -- test/blocks/<block-name>/<block-name>.test.js
\`\`\`

## No Hardcoded User-Facing Strings

All user-visible text must come from placeholders, not hardcoded strings.
Milo fetches localized strings from \`{contentRoot}/placeholders.json\`.

\`\`\`javascript
import { replaceKey } from '../../features/placeholders.js';
import { getConfig } from '../../utils/utils.js';

// CORRECT -- localized via placeholders
const config = getConfig();
const label = await replaceKey('share-this-page', config);

// WRONG -- hardcoded English string
const label = 'Share this page';
\`\`\`

Keys are kebab-case (\`copy-to-clipboard\`). If a key isn't found, the fallback
converts dashes to spaces (\`copy to clipboard\`), so choose descriptive keys.

## Use CSS Custom Properties (Design Tokens)

Use Milo's CSS variables for colors, spacing, and typography — not hardcoded values:

\`\`\`css
/* CORRECT */
color: var(--color-gray-700);
font-size: var(--type-body-m-size);

/* WRONG */
color: #4b4b4b;
font-size: 18px;
\`\`\`

## Third-Party Dependencies

Store third-party libraries in the block's \`/deps/\` directory, not in
\`node_modules\`. Only load deps when the block actually needs them:

\`\`\`javascript
// CORRECT -- load dep only when content requires it
if (el.querySelector('.chart-data')) {
  const { Chart } = await import('./deps/chart.js');
  new Chart(canvas, chartConfig);
}
\`\`\`

## Scope All CSS to the Block Class

Block CSS must be scoped to the block's class. Never write global selectors:

\`\`\`css
/* CORRECT -- scoped to block */
.my-block {
  & .title { font-weight: bold; }
  & .description { color: var(--text-color); }
}

/* WRONG -- global selector affects ALL .title elements everywhere */
.title { font-weight: bold; }
\`\`\`

## No \`@import\` in CSS

CSS \`@import\` blocks rendering. Use \`loadStyle()\` in JS instead:

\`\`\`javascript
// CORRECT -- non-blocking dynamic load
loadStyle(\`\${miloLibs || codeRoot}/blocks/tabs/tabs.css\`);
\`\`\`

## Never Use \`!important\`

Use CSS nesting or more specific selectors instead:

\`\`\`css
/* WRONG */
.my-block .title { color: var(--color-gray-700) !important; }

/* CORRECT -- use nesting for specificity */
.my-block {
  & .title { color: var(--color-gray-700); }
}
\`\`\`

## Use CSS Nesting

\`\`\`css
/* WRONG -- repetitive flat selectors */
.my-block .title { font-size: var(--type-heading-m-size); }
.my-block .description { font-size: var(--type-body-m-size); }

/* CORRECT -- nested */
.my-block {
  & .title { font-size: var(--type-heading-m-size); }
  & .description { font-size: var(--type-body-m-size); }
}
\`\`\`

## Use Logical CSS Properties for RTL

Adobe.com supports RTL languages:

\`\`\`css
/* WRONG -- breaks in RTL */
margin-left: 16px;
text-align: left;

/* CORRECT -- works in both LTR and RTL */
margin-inline-start: 16px;
text-align: start;
\`\`\`

## Use Modern Media Query Range Syntax

\`\`\`css
/* WRONG -- old syntax */
@media (min-width: 768px) and (max-width: 1279px) { }

/* CORRECT -- range syntax */
@media (768px <= width < 1280px) { }
\`\`\`

## Verification Checklist

After building or modifying any block, verify:
1. Uses \`init(block)\` export (not \`decorate\`)
2. Uses \`createTag()\` for DOM creation (not \`document.createElement\`)
3. Calls \`loadStyle(import.meta.url)\` for CSS
4. All imports have \`.js\` extensions
5. No hardcoded user-facing strings (use \`replaceKey()\` from placeholders)
6. CSS scoped to block class — no global selectors
7. Uses CSS custom properties, not hardcoded color/spacing values
8. No \`!important\` — use nesting/specificity instead
9. No \`@import\` in CSS — use \`loadStyle()\` in JS
10. Uses logical CSS properties (\`margin-inline-start\`, not \`margin-left\`)
11. Uses CSS nesting and \`:is()\` where appropriate
12. No \`innerHTML\` from external content
13. Images have \`alt\` text and aspect ratios set
14. Interactive elements keyboard-accessible with touch targets >= 44px
15. Third-party deps committed in \`/deps/\`, not from \`node_modules\`
16. Test file exists and passes: \`npm run test:file -- test/blocks/<name>/*.test.js\`
17. Lint passes: \`npm run lint:js -- libs/blocks/<name>/\`
`;

export const MILO_CODE_STYLE_RULE = `---
paths:
  - "libs/blocks/**"
  - "libs/features/**"
---

# Milo JS Code Style

These patterns apply to all JS in blocks and features. Sourced from recurring
PR review feedback across 272 merged PRs (Oct 2025 – Apr 2026).

## Early Returns Over Nested Conditions

Prefer guard clauses that return early over deeply nested if/else blocks:

\`\`\`javascript
// WRONG -- deep nesting
function decorateCard(el) {
  if (el) {
    const image = el.querySelector('img');
    if (image) {
      // ... actual logic buried 2 levels deep
    }
  }
}

// CORRECT -- fail fast
function decorateCard(el) {
  if (!el) return;
  const image = el.querySelector('img');
  if (!image) return;
  // ... actual logic at top level
}
\`\`\`

## Don't Over-Use Optional Chaining

After a null check confirms a value exists, don't add redundant \`?.\` on it.
Also, \`el.dataset\` always exists — no need for \`el.dataset?.prop\`:

\`\`\`javascript
// WRONG -- el already confirmed non-null
if (!el) return;
el?.classList.add('active');

// CORRECT
if (!el) return;
el.classList.add('active');
el.dataset.mepLingo;
\`\`\`

## Check String Values Explicitly

Dataset attributes and env strings are always strings. Checking truthiness on
the string \`'false'\` evaluates to \`true\` — always compare explicitly:

\`\`\`javascript
// WRONG -- 'false' is truthy, this is a bug
if (el.dataset.mepLingo) { ... }

// CORRECT
if (el.dataset.mepLingo === 'true') { ... }
\`\`\`

## No \`innerHTML\` from External Content

Never set \`innerHTML\` with content from fetched data or user-generated sources:

\`\`\`javascript
// WRONG -- XSS risk from external content
el.innerHTML = data.title;

// CORRECT
el.textContent = data.title;
\`\`\`

## No Commented-Out Code

Remove dead code — don't comment it out. Git history preserves everything.

## Function Names Must Be Verbs

\`\`\`javascript
// WRONG -- noun, unclear intent
function cardLayout(el) { ... }

// CORRECT -- verb, clear action
function decorateCard(el) { ... }
\`\`\`

Boolean-returning functions must be named \`is*\`/\`has*\`/\`should*\` and must
actually return a boolean:

\`\`\`javascript
// WRONG -- name says boolean, returns string
function isLingoSite() { return el.dataset.lingo; }

// CORRECT
function isLingoSite() { return el.dataset.lingo === 'true'; }
\`\`\`

## Reuse Existing Milo Utilities

Before writing helper logic, check if Milo already provides it:

- \`loadIms()\` — wait for IMS/auth to be ready
- \`createIntersectionObserver()\` — lazy-load pattern
- \`getMetadata(name)\` — read page metadata
- \`getConfig()\` — access locale, env, paths
- \`createTag(tag, attrs, content)\` — DOM creation
- \`loadStyle(path)\` — load CSS
- \`getCookie(name)\` — read cookies (from \`libs/martech/helpers.js\`)
`;

export const MILO_ACCESSIBILITY_RULE = `---
paths:
  - "libs/blocks/**"
  - "libs/features/**"
---

# Milo Accessibility Rules

Adobe.com must meet WCAG 2.1 AA standards. Accessibility bugs are P1 blockers.

## Heading Hierarchy Must Not Skip Levels

\`\`\`javascript
// WRONG -- hardcoded heading level, skips hierarchy
const title = createTag('h3', null, data.title);

// CORRECT -- use decorateBlockText or let authors choose
const title = el.querySelector('h1, h2, h3, h4, h5, h6');
\`\`\`

## Every Interactive Element Needs an Accessible Name

Buttons, links, and form controls must have visible text, \`aria-label\`, or \`aria-labelledby\`:

\`\`\`javascript
// WRONG -- icon button with no accessible name
const btn = createTag('button', { class: 'close-btn' });
btn.innerHTML = closeIconSvg;

// CORRECT
const btn = createTag('button', {
  class: 'close-btn',
  'aria-label': await replaceKey('close', config),
});
btn.innerHTML = closeIconSvg;
\`\`\`

## Guard Against \`aria-label="null"\`

\`getAttribute()\` returns \`null\` for missing attributes:

\`\`\`javascript
// WRONG -- if aria-label is missing, this sets "null"
el.setAttribute('aria-label', el.getAttribute('aria-label'));

// CORRECT -- guard with fallback
const label = el.getAttribute('aria-label') || '';
\`\`\`

## All Images Must Have Alt Text

\`\`\`javascript
// WRONG -- no alt attribute
const img = createTag('img', { src: photoUrl });

// CORRECT -- meaningful image
const img = createTag('img', { src: photoUrl, alt: data.description });

// CORRECT -- decorative image
const img = createTag('img', { src: bgPattern, alt: '' });
\`\`\`

## Keyboard Navigation Must Work

- **Tab** moves between interactive elements
- **Enter/Space** activates buttons and links
- **Escape** closes dialogs/popups
- **Arrow keys** navigate within composite widgets (tabs, menus, carousels)

\`\`\`javascript
// WRONG -- click-only interaction on a div
div.addEventListener('click', toggle);

// CORRECT -- keyboard accessible button
const btn = createTag('button', { class: 'toggle' });
btn.addEventListener('click', toggle);
\`\`\`

## Touch Targets Must Be at Least 44x44px

\`\`\`css
/* CORRECT -- meets minimum touch target */
.my-block button,
.my-block a {
  min-width: 44px;
  min-height: 44px;
}
\`\`\`

## Use Semantic HTML Over ARIA When Possible

\`\`\`javascript
// WRONG -- generic element with ARIA
const el = createTag('div', { role: 'button', tabindex: '0' });

// CORRECT -- native element
const el = createTag('button');
\`\`\`
`;

export const MILO_PERFORMANCE_RULE = `---
paths:
  - "libs/blocks/**"
  - "libs/features/**"
---

# Milo Performance Rules

Performance is critical. Milo powers adobe.com — every unnecessary byte or
blocking await affects real page load times.

## Understand the E-L-D Loading Phases

- **Phase E (Eager)**: First section only. Critical path to LCP. Must stay
  under **100KB total** (HTML + CSS + JS + images). Target: LCP < 1.6s mobile.
- **Phase L (Lazy)**: Below-fold content. Use IntersectionObserver.
  Loads after LCP is painted.
- **Phase D (Delayed)**: Third-party scripts. Must wait **3+ seconds after LCP**.

The 100KB Phase E budget is sacred. Measure with DevTools Network tab.

## Parallelize Independent Awaits

Never await two independent operations sequentially. Use \`Promise.all()\`:

\`\`\`javascript
// WRONG -- second await waits for first to finish
const data = await fetchData(url);
const strings = await getCaasStrings(placeholderUrl);

// CORRECT
const [data, strings] = await Promise.all([
  fetchData(url),
  getCaasStrings(placeholderUrl),
]);
\`\`\`

Load module JS and CSS in parallel:

\`\`\`javascript
const [{ default: Search }] = await Promise.all([
  import('./features/search/gnav-search.js'),
  loadStyles(rootPath('features/search/gnav-search.css')),
]);
\`\`\`

## Dynamic Imports for Conditional Code

\`\`\`javascript
// WRONG -- module loaded even when mepFrag is falsy
import { handleFragmentCommand } from '../../features/personalization/personalization.js';
if (mepFrag) { relHref = handleFragmentCommand(mepFrag, a); }

// CORRECT
if (mepFrag) {
  const { handleFragmentCommand } = await import('../../features/personalization/personalization.js');
  relHref = handleFragmentCommand(mepFrag, a);
}
\`\`\`

## Lazy-Load Below-Fold Content

\`\`\`javascript
import { createIntersectionObserver } from '../../utils/utils.js';

export default async function init(el) {
  createIntersectionObserver({
    el,
    options: { rootMargin: '300px 0px' },
    callback: loadContent,
  });
}
\`\`\`

## Avoid CLS from Unawaited Async Work

\`\`\`javascript
// WRONG -- async work modifies DOM after init() returns, causing layout shift
export default function init(el) {
  fetchData(url).then((data) => { el.append(buildCards(data)); });
}

// CORRECT -- await so block content is ready before it's shown
export default async function init(el) {
  const data = await fetchData(url);
  el.append(buildCards(data));
}
\`\`\`

## LCP Images Must Not Be Lazy-Loaded

Do NOT add \`loading="lazy"\` to images in LCP-critical blocks.
Let Milo handle LCP image detection automatically.

## Set Aspect Ratios on Images to Prevent CLS

\`\`\`css
.my-block img {
  width: 100%;
  height: auto;
  aspect-ratio: 16 / 9;
}
\`\`\`

## Always Disconnect Observers

\`\`\`javascript
// CORRECT -- disconnect after use
const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      loadContent(entry.target);
      observer.unobserve(entry.target);
    }
  });
});
\`\`\`

## Scope Observers Narrowly

Never observe \`document.body\` with \`subtree: true\` — observe only the specific container.

## Use \`matchMedia\` Over Resize Event Listeners

\`\`\`javascript
// CORRECT -- fires once at breakpoint crossing
const mq = window.matchMedia('(max-width: 767px)');
mq.addEventListener('change', (e) => {
  if (e.matches) switchToMobileLayout();
});
\`\`\`

## Use Passive Event Listeners for Scroll and Touch

\`\`\`javascript
el.addEventListener('scroll', handleScroll, { passive: true });
el.addEventListener('touchstart', handleTouch, { passive: true });
\`\`\`

## Defer DOM Measurements

\`\`\`javascript
requestAnimationFrame(() => { calcOverflow(); });
\`\`\`
`;

export const MILO_FEATURES_RULE = `---
paths:
  - "libs/features/**"
---

# Milo Feature Development Rules

Features are distinct from blocks. Apply these rules when working in \`libs/features/\`.

## Export Pattern

Features export \`default async function init(...)\` but with varying signatures
depending on what the feature receives:

\`\`\`javascript
// Some features receive a DOM element
export default async function init(el) { ... }

// Some receive a config object
export default async function init(config) { ... }

// Some receive a path string
export default async function init(path) { ... }
\`\`\`

Check the feature's existing callers to determine the expected signature before
modifying or creating a feature — do not assume it matches block patterns.

## CSS Loading

Unlike blocks (which use \`loadStyle(import.meta.url)\`), features load CSS via
explicit path construction using \`miloLibs\` or \`codeRoot\`:

\`\`\`javascript
import { getConfig, loadStyle } from '../../utils/utils.js';

export default async function init(el) {
  const { miloLibs, codeRoot } = getConfig();
  const base = miloLibs || codeRoot;
  loadStyle(\`\${base}/features/my-feature/my-feature.css\`);
  // ... feature logic
}
\`\`\`

Do NOT use \`loadStyle(import.meta.url)\` in features — that pattern is for blocks only.

## Apply All Block Rules

All rules from \`milo-blocks\` apply here too unless explicitly overridden above:
- \`createTag()\` for DOM creation
- \`.js\` extensions on all imports
- No hardcoded user-facing strings (use \`replaceKey()\`)
- CSS custom properties, not hardcoded values
- Accessibility (WCAG 2.1 AA)
- Performance (E-L-D phases, parallel awaits)
`;

export const MILO_TESTS_RULE = `---
paths:
  - "test/**"
---

# Milo Testing Rules

Framework: Web Test Runner + Playwright (Chromium). Assertions: Chai expect. Mocking: Sinon.

## Test File Structure

\`\`\`javascript
import { readFile } from '@web/test-runner-commands';
import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import { setConfig } from '../../../libs/utils/utils.js';

// Load fixture HTML at file level
document.body.innerHTML = await readFile({ path: './mocks/body.html' });

// Dynamic import of the module under test
const { default: init } = await import('../../../libs/blocks/block-name/block-name.js');

describe('block-name', () => {
  it('should do something', async () => {
    const block = document.querySelector('.block-name');
    await init(block);
    expect(block.querySelector('.expected-element')).to.exist;
  });
});
\`\`\`

## Key Patterns

**Load tested module via dynamic import** (not static import):
\`\`\`javascript
const { default: init } = await import('../../../libs/blocks/name/name.js');
\`\`\`

**DOM setup via readFile** (not string literals):
\`\`\`javascript
document.body.innerHTML = await readFile({ path: './mocks/body.html' });
\`\`\`

**Fetch mocking with sinon:**
\`\`\`javascript
sinon.stub(window, 'fetch').callsFake((url) => {
  if (url.includes('expected')) return Promise.resolve({ ok: true, json: () => mockData });
  return Promise.resolve({ ok: false });
});
after(() => { sinon.restore(); });
\`\`\`

## Fixture Organization

Mocks go in \`test/<area>/<name>/mocks/\`:
\`\`\`
test/blocks/card/mocks/
  body.html          # Main test HTML fixture
  body-variant.html  # Variant for specific test cases
  data.json          # Mock API responses
\`\`\`

## Available Test Helpers

From \`test/helpers/waitfor.js\`:
- \`delay(ms)\` — Promise-based setTimeout
- \`waitForElement(selector, options)\` — wait for DOM element
- \`waitForRemoval(selector)\` — wait for element to disappear

From \`@web/test-runner-commands\`:
- \`readFile({ path })\` — read fixture files
- \`sendKeys({ press: 'Enter' })\` — simulate keyboard input
- \`setViewport({ width: 375, height: 1500 })\` — responsive testing

## Test Isolation

**Clean up window globals between tests:**
\`\`\`javascript
afterEach(() => {
  sinon.restore();
  delete window.gsap;
  document.querySelectorAll('script[src*="third-party"]').forEach((s) => s.remove());
});
\`\`\`

**Don't reuse DOM objects across tests — rebuild from fixtures:**
\`\`\`javascript
beforeEach(async () => {
  document.body.innerHTML = await readFile({ path: './mocks/body.html' });
});
\`\`\`

**Avoid real external URLs in tests:**
\`\`\`javascript
// WRONG -- 404s in CI, brittle
const img = createTag('img', { src: 'https://real-cdn.adobe.com/photo.jpg' });

// CORRECT -- use local fixtures
const img = createTag('img', { src: '/test/blocks/card/mocks/photo.png' });
\`\`\`

**Deduplicate test setup — use \`beforeEach\` or \`describe\`-level queries:**
\`\`\`javascript
describe('my-block', () => {
  let block;
  beforeEach(async () => {
    document.body.innerHTML = await readFile({ path: './mocks/body.html' });
    block = document.querySelector('.my-block');
  });
  it('test 1', () => { /* use block */ });
  it('test 2', () => { /* use block */ });
});
\`\`\`

## After Modifying Tests

\`\`\`bash
npm run test:file -- test/blocks/<name>/<name>.test.js
\`\`\`
`;

export const MILO_UTILS_RULE = `---
paths:
  - "libs/utils/**"
---

# Milo Utils Safety Rules

\`libs/utils/utils.js\` is the most critical file in the repo — 2700+ lines, imported
everywhere. Changes here have the highest blast radius of any file in the codebase.

## Search All Callers Before Modifying Any Function

Before changing any function's signature, behavior, or return value:

\`\`\`bash
# Find all callers across the codebase
grep -r "functionName" libs/ test/ --include="*.js" -l
\`\`\`

A function that looks unused at the call site may be called indirectly or
from external repos that consume milo as a library.

## Never Remove or Rename Exports Without Checking Dependents

Removing an export from utils.js is a breaking change. Before removing anything:
1. Search the full monorepo for imports of that export
2. Search consumer repos (milo is imported by many Adobe sites)
3. Check if the export is documented in any migration guides

When in doubt, deprecate (leave the export, add a comment) rather than remove.

## Run the Full Test Suite

After any change to utils.js, run the full test suite — not just the utils tests:

\`\`\`bash
npm test
\`\`\`

Single-file test runs (\`npm run test:file\`) are not sufficient here. Utils is
imported by almost every block and feature — a change can break tests anywhere.

## Extra Caution on These Functions

The following are called on every page load. Profile before optimizing:
- \`loadBlock()\`, \`loadBlocks()\` — block loading pipeline
- \`getConfig()\` — called thousands of times per session
- \`getMetadata()\` — used by blocks and features for page config
- \`createTag()\` — DOM creation utility used everywhere
`;

// ── EDS hooks config ──────────────────────────────────────────────────────
// Hook commands use `jq` (standard on macOS via Homebrew, and per guide convention).
// Hooks receive JSON on stdin; jq extracts the relevant field.

export interface HookEntry {
  matcher: string;
  command: string;
}

export const EDS_POST_TOOL_HOOKS: HookEntry[] = [
  {
    matcher: "Edit|Write",
    command: `file=$(cat | jq -r '.tool_input.path // .tool_input.file_path // empty'); if [[ "$file" == *.js ]]; then npx eslint --fix "$file" 2>/dev/null || true; fi`,
  },
  {
    matcher: "Edit|Write",
    command: `file=$(cat | jq -r '.tool_input.path // .tool_input.file_path // empty'); if [[ "$file" == *.css ]]; then npx stylelint --fix "$file" 2>/dev/null || true; fi`,
  },
];

export const EDS_PRE_TOOL_HOOKS: HookEntry[] = [
  {
    // Warn before editing utils.js (highest blast-radius file)
    matcher: "Edit|Write",
    command: `file=$(cat | jq -r '.tool_input.path // .tool_input.file_path // empty'); if echo "$file" | grep -q "libs/utils/utils.js"; then echo "WARNING: utils.js is the most critical file in the repo (2700+ lines, imported everywhere). Search all callers before modifying any function. Run the full test suite (npm test) after changes." >&2; fi`,
  },
  {
    // Pre-commit lint gate: block commit if lint fails
    matcher: "Bash",
    command: `cmd=$(cat | jq -r '.tool_input.command // empty'); if echo "$cmd" | grep -qE "^git commit"; then if ! npm run lint --silent 2>/dev/null; then echo "BLOCKED: Lint failed. Fix lint errors before committing." >&2; exit 2; fi; fi`,
  },
  {
    // Token file protection: prevent Claude from reading ~/.claude-tokens
    matcher: "Read|Grep",
    command: `path=$(cat | jq -r '.tool_input.file_path // .tool_input.path // empty'); if echo "$path" | grep -q 'claude-tokens'; then echo "BLOCKED: ~/.claude-tokens contains API secrets. To verify a token is set, use: [ -n \"\$TOKEN_VAR\" ] && echo set || echo unset" >&2; exit 2; fi`,
  },
];

// ── EDS permissions ───────────────────────────────────────────────────────

export const EDS_ALLOW_PERMISSIONS: string[] = [
  // Read operations (no prompting needed)
  "Read",
  "Glob",
  "Grep",
  // Web search (read-only)
  "WebFetch",
  "WebSearch",
  // Tests and lint
  "Bash(npm test)",
  "Bash(npm run test*)",
  "Bash(npm run lint*)",
  "Bash(npx eslint*)",
  "Bash(npx stylelint*)",
  // Jira integration scripts (read + append-only; require jira-integration skill)
  "Bash(python3 *jira_query.py*)",
  "Bash(python3 *jira_activity.py*)",
  "Bash(python3 *jira_sprint.py*)",
  "Bash(python3 *jira_comment.py*)",
  "Bash(python3 *jira_link.py*)",
  // Read-only git
  "Bash(git status)",
  "Bash(git diff*)",
  "Bash(git log*)",
  "Bash(git branch*)",
  "Bash(git show*)",
  "Bash(git fetch*)",
  "Bash(git stash list*)",
  // GitHub CLI read
  "Bash(gh pr*)",
  "Bash(gh api*)",
  // Directory listing
  "Bash(ls*)",
  "Bash(which*)",
];

export const EDS_DENY_PERMISSIONS: string[] = [
  // Force push variants
  "Bash(git push --force *)",
  "Bash(git push * --force)",
  "Bash(git push -f *)",
  "Bash(git push * -f)",
  "Bash(git push --force-with-lease *)",
  "Bash(git push * --force-with-lease)",
  // Hard reset
  "Bash(git reset --hard *)",
  // Recursive delete
  "Bash(rm -rf *)",
  "Bash(rm -fr *)",
  // Push directly to main/master
  "Bash(git push origin main)",
  "Bash(git push origin master)",
];
