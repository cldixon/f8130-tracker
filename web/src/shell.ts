/**
 * The application shell.
 *
 * A rail on the left holding identity and navigation, a column in the middle
 * holding whatever you are reading, and a composer that opens over the top of
 * it. The arrangement is borrowed from a social client on purpose, and not
 * only because it is familiar: the borrowing works because the data model
 * underneath already matches one. A release certificate is a signed record in
 * its issuer's own repository, a verdict is a signed record in the verifier's
 * carrying a reference to it, and an AppView assembles the two into a view
 * neither party controls. That is a post and a reply, exactly.
 *
 * What replaced what: this used to be a row of tabs, each a separate errand —
 * verify a document here, browse releases there, issue one somewhere else. The
 * tabs told a visitor there were four unrelated tools. There is one world.
 */

import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'

import { composer } from './compose.js'
import type { Actor } from './writer.js'

const STYLES = `

:root {
  --bg: #fbfbfa; --fg: #1a1a19; --muted: #6b6b68; --line: #e2e2df;
  --card: #ffffff; --pass: #1a7f47; --fail: #b3261e; --warn: #8a6100;
  --skip: #8a8a86; --accent: #2c5aa0;
  --pass-bg: #eaf5ee; --fail-bg: #fdecea; --warn-bg: #fdf5e3; --skip-bg: #f4f4f2;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16161a; --fg: #e8e8e6; --muted: #9a9a96; --line: #2e2e34;
    --card: #1e1e23; --pass: #6cc48d; --fail: #f2857c; --warn: #e0b354;
    --skip: #7a7a78; --accent: #86aae8;
    --pass-bg: #17301f; --fail-bg: #351b19; --warn-bg: #33290f; --skip-bg: #232328;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
a { color: var(--accent); }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; letter-spacing: -0.01em; }
h2 { font-size: 1.05rem; margin: 2rem 0 .75rem; letter-spacing: -0.01em; }
.sub { color: var(--muted); margin: 0 0 1.75rem; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; }

/* The one standing admonition, in the chrome rather than on every page.
   There used to be three or four before any content; a warning repeated that
   often is read as furniture and stops working. */
.marker {
  background: var(--warn-bg); border-bottom: 1px solid var(--line);
  font-size: .78rem; color: var(--muted); text-align: center;
  padding: .35rem 1.25rem;
}
.marker strong { color: var(--fg); }

/* feed */
.feed { display: flex; flex-direction: column; gap: .6rem; }
.event {
  background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  padding: .8rem .95rem;
}
.event .who { font-size: .92rem; display: flex; align-items: baseline; gap: .4rem; flex-wrap: wrap; }
.event .who .when { margin-left: auto; color: var(--muted); font-size: .76rem; white-space: nowrap; }
.event .dot { width: .5rem; height: .5rem; border-radius: 50%; background: var(--accent); flex: 0 0 auto; align-self: center; }
.event .mine {
  font-size: .64rem; text-transform: uppercase; letter-spacing: .06em;
  color: var(--accent); border: 1px solid var(--accent); border-radius: 3px;
  padding: 0 .25rem; margin-left: .15rem; vertical-align: .05em;
}
.event .note {
  margin-top: .4rem; padding: .4rem .6rem; border-radius: 4px;
  background: var(--skip-bg); font-size: .85rem; color: var(--fg);
}
.event .meta { margin-top: .35rem; font-size: .74rem; color: var(--muted); }
@keyframes arrive { from { opacity: 0; transform: translateY(-.4rem); } to { opacity: 1; transform: none; } }
.event.fresh { animation: arrive .35s ease-out; }
.pulse {
  display: inline-block; margin-left: .5rem; font-size: .68rem;
  text-transform: uppercase; letter-spacing: .07em; color: var(--pass);
  border: 1px solid var(--pass); border-radius: 3px; padding: 0 .3rem;
}
.pulse.beat { background: var(--pass-bg); }
/* Paused or idle: the stream is closed, so the generator has no viewer and
   is writing nothing. Saying which is honest — a still feed with no
   explanation reads as broken. */
.pulse.idle { color: var(--muted); border-color: var(--line); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
.demo {
  background: var(--skip-bg); border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  padding: .6rem .8rem; border-radius: 4px; font-size: .85rem;
  margin-bottom: 1.5rem;
}

/* verification stages */
.verdict { padding: 1rem 1.15rem; border-radius: 8px; margin-bottom: 1.25rem; border: 1px solid var(--line); }
.verdict.ok { background: var(--pass-bg); border-left: 3px solid var(--pass); }
.verdict.no { background: var(--fail-bg); border-left: 3px solid var(--fail); }
.verdict h2 { margin: 0 0 .2rem; font-size: 1.15rem; }
.verdict p { margin: 0; color: var(--muted); font-size: .92rem; }

.stage { display: flex; gap: .9rem; padding: .85rem 1.15rem; border-bottom: 1px solid var(--line); }
.stage:last-child { border-bottom: 0; }
.stage .badge {
  flex: 0 0 auto; width: 4.4rem; text-align: center; align-self: flex-start;
  font-size: .68rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  padding: .2rem 0; border-radius: 3px;
}
.badge.pass { color: var(--pass); background: var(--pass-bg); }
.badge.fail { color: var(--fail); background: var(--fail-bg); }
.badge.warn { color: var(--warn); background: var(--warn-bg); }
.badge.skipped { color: var(--skip); background: var(--skip-bg); }
.stage .body { min-width: 0; }
.stage .title { font-weight: 600; font-size: .93rem; }
.stage .detail { color: var(--muted); font-size: .88rem; margin-top: .12rem; }
.stage .evidence { margin-top: .4rem; font-size: .78rem; color: var(--muted); word-break: break-all; }

/* the lesson: a real signature over a document that has since changed */
.contrast {
  margin-top: 1.25rem; padding: .85rem 1.15rem; border-radius: 6px;
  background: var(--fail-bg); border: 1px dashed var(--fail); font-size: .89rem;
}
.contrast strong { color: var(--fail); }

/* timeline */
.link { display: flex; gap: 1rem; padding: 1rem 1.15rem; border-bottom: 1px solid var(--line); }
.link:last-child { border-bottom: 0; }
.link .rail { flex: 0 0 auto; width: .6rem; display: flex; flex-direction: column; align-items: center; }
.link .dot { width: .6rem; height: .6rem; border-radius: 50%; background: var(--accent); margin-top: .45rem; }
.link .line { flex: 1; width: 1px; background: var(--line); }
.times { display: flex; gap: 1.75rem; margin-top: .5rem; flex-wrap: wrap; }
.times div { font-size: .78rem; }
.times .label { color: var(--muted); text-transform: uppercase; letter-spacing: .05em; font-size: .68rem; }
.gap { background: var(--fail-bg); border: 1px dashed var(--fail); border-radius: 6px; padding: .85rem 1.15rem; margin-top: 1rem; font-size: .89rem; }

table { width: 100%; border-collapse: collapse; font-size: .89rem; }
th { text-align: left; font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); padding: .6rem 1.15rem; border-bottom: 1px solid var(--line); font-weight: 600; }
td { padding: .65rem 1.15rem; border-bottom: 1px solid var(--line); }
tr:last-child td { border-bottom: 0; }
.scroll { overflow-x: auto; }

textarea { width: 100%; min-height: 11rem; font-family: ui-monospace, monospace; font-size: .82rem;
  padding: .75rem; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); }
input[type=text] { padding: .5rem .65rem; border: 1px solid var(--line); border-radius: 6px;
  background: var(--card); color: var(--fg); font-size: .9rem; width: 100%; max-width: 22rem; }
label { display: block; font-size: .8rem; color: var(--muted); margin: 1rem 0 .3rem; }
button { margin-top: 1.15rem; padding: .55rem 1.1rem; font-size: .92rem; font-weight: 600;
  border: 0; border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
button:disabled { background: var(--line); color: var(--muted); cursor: not-allowed; }
.empty { padding: 1.5rem 1.15rem; color: var(--muted); font-size: .9rem; }
.checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: .3rem .8rem; margin-top: .4rem; }
.check { display: flex; align-items: center; gap: .4rem; margin: 0; font-size: .85rem; color: var(--fg); }
.check input { margin: 0; }
select { padding: .5rem .65rem; border: 1px solid var(--line); border-radius: 6px;
  background: var(--card); color: var(--fg); font-size: .9rem; max-width: 22rem; width: 100%; }
.hint { font-size: .68rem; text-transform: uppercase; letter-spacing: .05em;
  color: var(--accent); border: 1px solid var(--line); border-radius: 3px; padding: 0 .3rem; }
.signing { font-size: .88rem; color: var(--muted); margin: 0 0 1.25rem; }
.signing strong { color: var(--fg); }
.needs-actor {
  border: 1px solid var(--line); border-left: 3px solid var(--accent);
  border-radius: 4px; padding: .7rem .85rem; font-size: .88rem;
  margin-bottom: 1.25rem; color: var(--muted);
}

/* ---------------------------------------------------------------- form view */

/* The rendered 8130-3.
   The watermark is a pseudo-element over the whole sheet rather than a corner
   badge, because a corner badge crops out of a screenshot and this is the one
   artifact in the project that must never travel without saying what it is. */
.sheet {
  position: relative; background: var(--card); border: 1px solid var(--fg);
  border-radius: 2px; overflow: hidden;
}
.sheet::after {
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 2;
  background-image: repeating-linear-gradient(
    -30deg, transparent 0 38px,
    color-mix(in srgb, var(--fail) 7%, transparent) 38px 76px);
}
.sheet .stamp {
  position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; pointer-events: none; z-index: 3;
}
.sheet .stamp span {
  transform: rotate(-24deg); font-weight: 800; letter-spacing: .18em;
  font-size: clamp(1rem, 3.4vw, 2rem); text-align: center; line-height: 1.35;
  color: color-mix(in srgb, var(--fail) 26%, transparent);
  border: 3px solid color-mix(in srgb, var(--fail) 20%, transparent);
  padding: .5rem 1.1rem; border-radius: 6px;
}
.sheet .head {
  border-bottom: 1px solid var(--fg); padding: .55rem .7rem; text-align: center;
}
.sheet .head .t1 { font-size: .78rem; letter-spacing: .04em; }
.sheet .head .t2 { font-weight: 700; font-size: .95rem; letter-spacing: .02em; }
.grid { display: grid; grid-template-columns: repeat(4, 1fr); }
.blk {
  border-right: 1px solid var(--line); border-bottom: 1px solid var(--line);
  padding: .4rem .55rem .5rem; min-height: 3.5rem; position: relative;
  cursor: pointer; background: transparent; text-align: left; width: 100%;
  color: inherit; font: inherit; display: block;
}
.blk:last-child { border-right: 0; }
.blk .n {
  font-size: .6rem; color: var(--muted); text-transform: uppercase;
  letter-spacing: .07em; display: block; margin-bottom: .18rem;
}
.blk .v { font-size: .87rem; word-break: break-word; }
.blk .v.wide { font-size: .8rem; }
.blk.sel { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.blk:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
.blk.span2 { grid-column: span 2; }
.blk.span4 { grid-column: span 4; }
.blk.withheld .v { color: var(--muted); font-style: italic; }
.blk .leafhash {
  display: block; margin-top: .2rem; font-size: .64rem; color: var(--muted);
  font-family: ui-monospace, monospace; word-break: break-all;
}
.cert { display: grid; grid-template-columns: 1fr 1fr; }
.cert > div { border-right: 1px solid var(--line); }
.cert > div:last-child { border-right: 0; }
.cert .capt {
  font-size: .66rem; padding: .35rem .55rem; border-bottom: 1px solid var(--line);
  color: var(--muted); text-transform: uppercase; letter-spacing: .06em;
}
.cert .unused { opacity: .38; }
.cert .stmt { padding: .45rem .55rem; font-size: .74rem; }
.cert .stmt.on { font-weight: 600; }

/* The same sheet with its blocks open for typing.
   Deliberately not styled as a stack of form controls. A visitor editing the
   document is meant to feel like somebody amending a form, not like somebody
   completing seventeen labelled inputs — which is the version nobody finished.
   The stamp shrinks because at full size it sits across the fields you are
   trying to read while you type in them. */
.sheet.draft .stamp span { font-size: clamp(.75rem, 2vw, 1.15rem); opacity: .6; }
.blk.edit { cursor: default; }
.blk.edit:hover { background: transparent; }
.blk.edit input, .blk.edit select, .blk.edit textarea {
  width: 100%; margin: 0; padding: .1rem .1rem .15rem; font: inherit;
  font-size: .87rem; color: inherit; background: transparent;
  border: 0; border-bottom: 1px dashed var(--line); border-radius: 0;
}
.blk.edit textarea { resize: vertical; min-height: 2.4rem; }
.blk.edit input:focus, .blk.edit select:focus, .blk.edit textarea:focus {
  outline: none; border-bottom-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 9%, transparent);
}
form.draftform button[type=submit] { margin-top: 1rem; }

/* What the network kept, and what it did not.
   Two tones and nothing else: the argument is which lines went dark, and a
   legend or a badge per row would bury it under decoration. */
.reveal {
  display: grid; gap: 1px; background: var(--line);
  border: 1px solid var(--line); border-radius: 4px; overflow: hidden;
}
.rev { display: flex; gap: .8rem; align-items: baseline; padding: .45rem .65rem; background: var(--card); }
.rev .n {
  flex: 0 0 40%; font-size: .62rem; text-transform: uppercase;
  letter-spacing: .06em; color: var(--muted);
}
.rev .v { font-size: .85rem; word-break: break-word; }
.rev.priv { background: color-mix(in srgb, var(--muted) 12%, var(--card)); }
.rev.priv .v { color: var(--muted); font-style: italic; }
@media (max-width: 34rem) {
  .rev { display: block; }
  .rev .n { display: block; margin-bottom: .15rem; }
}

/* The action on a goods-in card. The explanation sits beside the button
   rather than under it, so a card stays one glance tall. */
.checkrow { display: flex; align-items: center; gap: .7rem; flex-wrap: wrap; margin-top: .6rem; }
.checkrow button { margin: 0; flex: 0 0 auto; }
.checkrow .meta { margin: 0; flex: 1 1 14rem; min-width: 0; }

/* A link that behaves as the action it is. */
a.button {
  display: inline-block; text-decoration: none; text-align: center;
  background: var(--accent); color: var(--bg); border: 0; border-radius: 6px;
  padding: .5rem .9rem; font-size: .9rem; font-weight: 600;
}
a.button:hover { filter: brightness(1.08); }

/* What is being done while it is being done. Named, not timed: the server
   answers when all seven are finished, and animating them in sequence would
   be inventing progress the page cannot observe. */
.checks-running {
  list-style: none; margin: .9rem 0 0; padding: 0; text-align: left;
  display: grid; gap: .3rem;
}
.checks-running li {
  font-size: .82rem; color: var(--muted); padding-left: 1.1rem; position: relative;
}
.checks-running li::before {
  content: "·"; position: absolute; left: .3rem; color: var(--accent);
  font-weight: 700;
}
.working .detail { width: 100%; }

.scanhead {
  display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap;
  margin: 1.1rem 0 .5rem; font-size: .9rem; font-weight: 600;
}
.scanhead .meta { margin: 0; font-weight: 400; }
.startcheck { margin-top: 1.1rem; }
.startcheck button { margin: 0; }
.startcheck .meta { margin-top: .5rem; }

.backlink { margin: 0 0 .6rem; font-size: .85rem; }
.backlink a { text-decoration: none; }

/* The paper, read-only: the composer's sheet without the inputs. */
.sheet.paper { margin-top: 1rem; }
.sheet.paper .stamp span { font-size: clamp(.75rem, 2vw, 1.15rem); opacity: .55; }
.sheet.paper .blk { cursor: default; }
.sheet.paper .blk:hover { background: transparent; }

/* The outcome carries its state in the heading rather than in a banner
   underneath one — a page that says "Form does not match" does not also need
   a box saying not verified. */
/* Sections, all built the same way.
   They used to be a mixture — a heading with a card under it, a summary
   nobody would notice, a coloured heading with nothing to fold — so the page
   read as a pile of unrelated things rather than a sequence of steps with
   states. The condition lives in the summary so it survives being closed: a
   section somebody folded away can still tell them it passed. */
.panel {
  background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  margin-top: .8rem; overflow: hidden;
}
.panel > summary {
  display: flex; align-items: center; gap: .6rem;
  padding: .8rem 1rem; cursor: pointer; list-style: none;
  font-size: .95rem; user-select: none;
}
.panel > summary::-webkit-details-marker { display: none; }
.panel > summary:hover { background: color-mix(in srgb, var(--accent) 5%, transparent); }
.panel .pmark { flex: 0 0 auto; display: flex; color: var(--muted); }
.panel .ico-svg { width: 1.15rem; height: 1.15rem; display: block; }
.panel .ptitle { font-weight: 600; }
.panel .pstate {
  margin-left: auto; color: var(--muted); font-size: .8rem;
  text-align: right; min-width: 0;
}
.panel .pchev {
  flex: 0 0 auto; display: flex; color: var(--muted);
  transition: transform .18s ease-out;
}
.panel .pchev svg { width: 1.05rem; height: 1.05rem; display: block; }
.panel[open] > summary .pchev { transform: rotate(180deg); }
.panel .pbody { padding: 0 1rem 1rem; }
.panel .pbody > .sub:first-child { margin-top: 0; }

/* The condition, carried by the icon and the border rather than by colouring
   a whole block — a section that passed should read as calm. */
.panel.ok { border-left: 3px solid var(--pass); }
.panel.ok .pmark { color: var(--pass); }
.panel.no { border-left: 3px solid var(--fail); }
.panel.no .pmark { color: var(--fail); }
/* Publishing is not a third verdict. The check already passed and said so in
   green; this is the separate act of telling everyone. */
.panel.told { border-left: 3px solid var(--accent); }
.panel.told .pmark { color: var(--accent); }

/* Stage rows sit flush inside a panel rather than in a card of their own. */
.panel .stages {
  border: 1px solid var(--line); border-radius: 6px; overflow: hidden;
}
.panel .stages .stage { padding: .7rem .9rem; }

.withheld-list {
  margin: .2rem 0 .8rem; padding-left: 1.1rem; font-size: .87rem;
  color: var(--muted); columns: 2; column-gap: 1.5rem;
}
@media (max-width: 34rem) { .withheld-list { columns: 1; } }

/* The document, folded once it has been read and the decision is below it. */
.sheetfold > summary { font-weight: 600; color: var(--fg); }
.sheetfold[open] > summary { margin-bottom: .3rem; }
.outcome { margin-top: 1.25rem; }
.outcome .ref {
  word-break: break-all; font-size: .78rem; color: var(--muted);
  background: var(--skip-bg); border-radius: 4px; padding: .5rem .7rem;
}
.outcome .sect:first-child { margin-top: 0; }

/* A section heading inside a page, quieter than an h2 between sections. */
.sect {
  font-size: .72rem; text-transform: uppercase; letter-spacing: .08em;
  color: var(--muted); margin: 1.6rem 0 .5rem; font-weight: 600;
}

/* The checks, while they run. The names and their order are the pipeline's;
   the pace is ours, because the client cannot see which one the server is on.
   What replaces this is the real report. */
.checking { margin-top: 1.2rem; }
.steps {
  list-style: none; margin: 0; padding: 0;
  background: var(--card); border: 1px solid var(--line); border-radius: 8px;
}
.steps li {
  display: flex; align-items: center; gap: .7rem;
  padding: .7rem 1.15rem; border-bottom: 1px solid var(--line);
  font-size: .9rem; color: var(--muted);
  transition: color .2s ease-out;
}
.steps li:last-child { border-bottom: 0; }
.steps li.done { color: var(--fg); }
.steps .tick {
  flex: 0 0 auto; width: 1.05rem; height: 1.05rem; border-radius: 50%;
  border: 2px solid var(--line); position: relative;
}
.steps li.done .tick { border-color: var(--pass); background: var(--pass); }
.steps li.done .tick::after {
  content: ""; position: absolute; left: .28rem; top: .1rem;
  width: .22rem; height: .45rem; border: solid var(--card);
  border-width: 0 2px 2px 0; transform: rotate(45deg);
}
/* The one still being waited on, so the list does not look stalled. */
.steps li:not(.done):first-of-type .tick,
.steps li.done + li:not(.done) .tick {
  border-color: var(--accent);
  animation: pulsering 1.1s ease-in-out infinite;
}
@keyframes pulsering {
  0%, 100% { opacity: 1; }
  50% { opacity: .35; }
}
@media (prefers-reduced-motion: reduce) {
  .steps li .tick { animation: none; }
}

/* The scanned document, folded away once a result is on screen. */
.scan { margin-top: 1rem; }
.scan > summary {
  cursor: pointer; font-size: .9rem; padding: .5rem .2rem;
  color: var(--accent);
}
.scan .sub { margin: .3rem 0 .7rem; font-size: .85rem; }

/* What differed, when the record carries the block in the clear. */
.mismatch {
  margin-top: 1rem; padding: 1rem 1.15rem; border-radius: 8px;
  background: var(--fail-bg); border: 1px solid var(--line);
  border-left: 3px solid var(--fail);
}
.mismatch h2 { margin: 0 0 .5rem; font-size: 1.05rem; }
.mismatch p { margin: 0 0 .7rem; font-size: .92rem; }
.diff { margin: 0 0 .8rem; display: grid; gap: .5rem; }
.diff > div {
  background: var(--card); border: 1px solid var(--line); border-radius: 6px;
  padding: .5rem .7rem;
}
.diff dt {
  font-size: .62rem; text-transform: uppercase; letter-spacing: .06em;
  color: var(--muted); margin-bottom: .2rem;
}
.diff dd { margin: 0; display: flex; align-items: baseline; gap: .5rem; font-size: .88rem; }
.diff dd .was { text-decoration: line-through; color: var(--muted); }
.diff dd .is { font-weight: 600; }
.diff dd .sep { font-size: .68rem; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }

/* Publish or do not, side by side: neither is the safe default. */
.choose { display: flex; gap: .6rem; flex-wrap: wrap; align-items: center; }
.choose form { margin: 0; }
.choose button { margin: 0; }

/* The line that stops a green tick being read as more than it is. */
.caveat {
  margin-top: .5rem !important; font-size: .85rem; color: var(--muted);
  border-top: 1px solid var(--line); padding-top: .5rem;
}

/* Waiting on a generated form. It is a call to a model, so it takes a second
   or two, and a blank dialog for that long reads as broken rather than busy. */
.working {
  display: flex; flex-direction: column; align-items: center; gap: .9rem;
  padding: 3.5rem 1rem; color: var(--muted); text-align: center;
}
.working p { margin: 0; font-size: .9rem; }
.spinner {
  width: 1.5rem; height: 1.5rem; border-radius: 50%;
  border: 2px solid var(--line); border-top-color: var(--accent);
  animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }

/* panes */
.panes { display: grid; gap: 1rem; grid-template-columns: 1fr; }
@media (min-width: 60rem) { .panes { grid-template-columns: 1fr 1fr; } }
.pane { border: 1px solid var(--line); border-radius: 8px; background: var(--card); overflow: hidden; }
.pane > h3 {
  margin: 0; padding: .55rem .8rem; font-size: .74rem; text-transform: uppercase;
  letter-spacing: .07em; color: var(--muted); border-bottom: 1px solid var(--line);
  font-weight: 600;
}
.pane .body { padding: .7rem .8rem; }
pre.rec {
  margin: 0; padding: .7rem .8rem; font-family: ui-monospace, monospace;
  font-size: .74rem; line-height: 1.5;
  white-space: pre-wrap; word-break: break-all;
}
pre.rec .k { color: var(--accent); }
pre.rec mark { background: color-mix(in srgb, var(--accent) 22%, transparent); color: inherit; border-radius: 2px; }

/* the leaf strip */
.leaves { display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; }
.leaf {
  font-family: ui-monospace, monospace; font-size: .58rem; text-align: center;
  padding: .28rem .1rem; border-radius: 2px; background: var(--skip-bg);
  border: 1px solid transparent; overflow: hidden;
}
.leaf.pad { opacity: .4; }
.leaf.sel { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 18%, transparent); }
.leaf .bn { display: block; font-size: .55rem; color: var(--muted); }
.fold { margin-top: .7rem; font-family: ui-monospace, monospace; font-size: .72rem; }
.fold div { padding: .18rem 0; word-break: break-all; }
.fold .op { color: var(--muted); }
.fold .root { border-top: 1px solid var(--line); margin-top: .25rem; padding-top: .3rem; }
.inert {
  padding: .8rem; font-size: .85rem; color: var(--muted);
  background: var(--skip-bg); border-radius: 6px;
}

/* ------------------------------------------------------------------ shell */

.app {
  display: grid; grid-template-columns: 15rem minmax(0, 40rem);
  gap: 1.5rem; max-width: 58rem; margin: 0 auto; padding: 0 1.25rem;
  align-items: start;
}
main { padding: 1.25rem 0 5rem; min-width: 0; }

.rail {
  position: sticky; top: 0; padding: 1rem 0;
  display: flex; flex-direction: column; gap: .35rem;
}
.rail .brand { display: block; text-decoration: none; color: inherit; }
.brand {
  font-weight: 700; letter-spacing: -0.03em; font-size: 1.15rem;
  padding: .3rem .6rem .7rem;
}
.rail .brand span { font-weight: 400; font-size: .7rem; color: var(--muted); }
.rail nav { display: flex; flex-direction: column; gap: .1rem; }
.rail nav a {
  text-decoration: none; color: var(--fg); font-size: .95rem;
  padding: .5rem .6rem; border-radius: 7px; display: flex;
  align-items: center; gap: .55rem;
}
.rail nav a:hover { background: var(--skip-bg); }
.rail nav a.on { font-weight: 700; }
.rail nav a .ico { width: 1.05rem; text-align: center; opacity: .75; }
.rail .newpost {
  margin: .8rem .6rem 0; padding: .55rem; text-align: center;
  background: var(--accent); color: #fff; border-radius: 999px;
  text-decoration: none; font-size: .9rem; font-weight: 600;
}
.rail .newpost.off { background: var(--line); color: var(--muted); }

/* Identity under the rail rather than pinned to the foot of it. Pinning
   wants a full-height rail, and a full-height rail under a banner of unknown
   height overflows the viewport by exactly the banner. */
.me { margin-top: 1.25rem; }
.me > summary {
  list-style: none; cursor: pointer; padding: .5rem .6rem; border-radius: 8px;
  display: flex; align-items: center; gap: .55rem;
}
.me > summary::-webkit-details-marker { display: none; }
.me > summary:hover { background: var(--skip-bg); }
.me .who { min-width: 0; }
.me .who b { display: block; font-size: .85rem; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.me .who em { font-style: normal; font-size: .72rem; color: var(--muted); }
.me .caret { margin-left: auto; color: var(--muted); font-size: .7rem; }

.switcher {
  max-height: 22rem; overflow-y: auto; margin: .3rem 0 0;
  border: 1px solid var(--line); border-radius: 10px; background: var(--card);
  padding: .3rem;
}
.switcher h4 {
  margin: .5rem .5rem .2rem; font-size: .64rem; text-transform: uppercase;
  letter-spacing: .07em; color: var(--muted); font-weight: 600;
}
.switcher button {
  margin: 0; width: 100%; text-align: left; background: none; color: var(--fg);
  border-radius: 7px; padding: .4rem .5rem; font-size: .85rem; font-weight: 400;
  display: flex; align-items: center; gap: .5rem;
}
.switcher button:hover { background: var(--skip-bg); }
.switcher button.on { font-weight: 700; }

.av {
  flex: 0 0 auto; width: 2rem; height: 2rem; border-radius: 999px;
  display: inline-flex; align-items: center; justify-content: center;
  color: #fff; font-size: .72rem; font-weight: 700; letter-spacing: .02em;
}
.av.sm { width: 1.5rem; height: 1.5rem; font-size: .58rem; }
.av.public { background: var(--skip) !important; }

/* thread */
.post {
  background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: 1rem 1.1rem;
}
.post .who { display: flex; align-items: center; gap: .6rem; }
.post .ident strong { display: block; font-size: .95rem; }
.post .ident .hnd { font-size: .78rem; color: var(--muted); }
.post .pt { font-size: 1.25rem; margin: .8rem 0 .35rem; }
.post .pmeta { font-size: .88rem; margin-bottom: .7rem; }
.post .ptimes { display: flex; gap: 1.75rem; flex-wrap: wrap; padding: .7rem 0;
  border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.post .ptimes div { font-size: .82rem; }
.post .ptimes .label { display: block; color: var(--muted);
  text-transform: uppercase; letter-spacing: .05em; font-size: .64rem; }
.post .pactions { display: flex; gap: .5rem; flex-wrap: wrap; padding: .8rem 0 .2rem; }
.act {
  font-size: .84rem; text-decoration: none; color: var(--accent);
  border: 1px solid var(--line); border-radius: 999px; padding: .3rem .8rem;
}
.act:hover { background: var(--skip-bg); }
.post .meta { margin-top: .6rem; font-size: .78rem; color: var(--muted); }

.replies { margin-top: .6rem; display: flex; flex-direction: column; gap: .5rem; }
/* Indented, and joined to the post above by a rail, because the nesting is
   the argument: everything below the first card lives in somebody else's
   repository and cannot be removed from up here. */
.replies .reply { margin-left: 1.25rem; position: relative; }
.replies .reply::before {
  content: ''; position: absolute; left: -.8rem; top: -.55rem; bottom: 50%;
  width: 1px; background: var(--line);
}
.event.answer {
  margin: .6rem 0 0 1.25rem; background: var(--skip-bg); position: relative;
}
.event.answer::before {
  content: ''; position: absolute; left: -.8rem; top: -.6rem; bottom: 50%;
  width: 1px; background: var(--line);
}
/* A quoted release, inside the verdict that judges it. The border is what
   says "this is somebody else's record" — the same thing a quote-post does. */
.quoted {
  display: block; margin-top: .55rem; padding: .5rem .65rem;
  border: 1px solid var(--line); border-radius: 8px;
  text-decoration: none; color: inherit; background: var(--bg);
}
.quoted:hover { border-color: var(--accent); }
.quoted .qwho {
  display: flex; align-items: center; gap: .4rem; font-size: .85rem;
}
.quoted .qwho .when {
  margin-left: auto; color: var(--muted); font-size: .72rem; white-space: nowrap;
}
.quoted .unseen { font-style: italic; font-size: .78rem; color: var(--muted); margin-top: .3rem; }

/* The dataplate.
   A component carries a stamped plate with its nomenclature and two labelled
   numbers, and every document about it repeats that shape. Rendering it as a
   run-on line of punctuation-separated strings threw away a convention the
   reader already knows. The labels are two characters and buy recognition. */
.plate { margin-top: .45rem; }
.plate .nomen { font-size: .95rem; font-weight: 600; line-height: 1.3; }
.plate .nomen a { color: inherit; text-decoration: none; }
.plate .nomen a:hover { text-decoration: underline; }
.ids {
  display: flex; flex-wrap: wrap; gap: .2rem .9rem; margin: .25rem 0 0;
}
.ids > div { display: flex; align-items: baseline; gap: .35rem; }
.ids dt {
  font-size: .62rem; font-weight: 700; letter-spacing: .08em;
  color: var(--muted); text-transform: uppercase;
}
.ids dd { margin: 0; font-size: .85rem; }
.ids dd a { color: inherit; text-decoration: none; border-bottom: 1px dotted var(--line); }
.ids dd a:hover { color: var(--accent); border-bottom-color: var(--accent); }
/* Inside a quote the plate is the whole content, so it sheds its top margin. */
.plate.sm { margin-top: .3rem; }
.plate.sm .nomen { font-size: .86rem; font-weight: 500; }
.plate.sm .ids dd { font-size: .78rem; }
/* On a part page the two numbers are the subject of the page, not a caption. */
.ids.big { gap: .3rem 1.4rem; margin-top: .4rem; }
.ids.big dd { font-size: 1rem; }
.event .who .ico, .event .av { align-self: center; }
/* The DID beside a name. Present because it is the thing that is actually
   cryptographically meaningful, quiet because it is not what anyone reads. */
.did {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .68rem; color: var(--muted); margin-left: .3rem;
  cursor: help; white-space: nowrap;
}
a.tag { text-decoration: none; border-bottom: 1px dotted var(--line); }
a.tag:hover { border-bottom-color: var(--accent); }
.event .when a { color: inherit; text-decoration: none; }
.event .when a:hover { text-decoration: underline; }

/* inbox */
.seam {
  border: 1px solid var(--line); border-left: 3px solid var(--accent);
  border-radius: 6px; padding: .75rem .9rem; font-size: .85rem;
  color: var(--muted); margin-bottom: 1.1rem;
}
.seam strong { color: var(--fg); }
.seam .v2 {
  display: block; margin-top: .45rem; padding-top: .45rem;
  border-top: 1px dashed var(--line); font-style: italic;
}

.rail nav a .badge {
  margin-left: auto; font-size: .68rem; font-weight: 700;
  background: var(--accent); color: #fff; border-radius: 999px;
  padding: 0 .35rem; min-width: 1.15rem; text-align: center;
}

/* a part, as a topic */
.topic { padding: .5rem 0 1.25rem; }
.topic .tname { font-size: 1.6rem; font-weight: 700; letter-spacing: -0.02em; }
.topic .tnote {
  font-size: .82rem; color: var(--muted); margin: .7rem 0 0; max-width: 34rem;
}

/* the two histories, side by side */
.compare {
  display: grid; grid-template-columns: 1fr 1fr; gap: .9rem;
  background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: .9rem 1rem; font-size: .88rem;
}
.compare.differ { border-color: var(--fail); background: var(--fail-bg); }
.compare .label {
  display: block; font-size: .64rem; text-transform: uppercase;
  letter-spacing: .06em; color: var(--muted); margin-bottom: .15rem;
}
.compare .cnote {
  grid-column: 1 / -1; margin: .2rem 0 0; font-size: .82rem; color: var(--muted);
  border-top: 1px solid var(--line); padding-top: .6rem;
}
.compare.differ .cnote strong { color: var(--fail); }
@media (max-width: 40rem) { .compare { grid-template-columns: 1fr; } }

.link .title { display: flex; align-items: center; gap: .45rem; }

/* composer */
dialog#composer {
  width: min(48rem, calc(100vw - 2rem)); max-height: 86vh; padding: 0;
  border: 1px solid var(--line); border-radius: 12px;
  background: var(--card); color: var(--fg); overflow: hidden;
}
dialog#composer::backdrop { background: rgba(0,0,0,.45); }
dialog#composer .chead {
  display: flex; align-items: center; gap: .5rem;
  padding: .8rem 1rem; border-bottom: 1px solid var(--line);
}
dialog#composer .chead form { margin-left: auto; }
dialog#composer .cbody { padding: 1rem; overflow-y: auto; max-height: calc(86vh - 3.5rem); }
button.ghost {
  margin: 0; background: none; color: var(--accent); border: 1px solid var(--line);
  font-size: .85rem; padding: .35rem .7rem;
}
button.ghost:hover { background: var(--skip-bg); }

/* the compose row at the top of the feed */
.compose-row {
  display: flex; align-items: center; gap: .65rem; width: 100%;
  background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: .7rem .8rem; margin-bottom: .8rem; cursor: pointer;
  color: var(--muted); font-size: .95rem; text-decoration: none;
}
.compose-row:hover { border-color: var(--accent); }

/* Desktop shows the long label; the tab bar's short one stays out of the way. */
.rail nav a .tab, .rail .newpost .tab { display: none; }

/*
 * Phones get a different shape, not a squeezed version of this one.
 *
 * Five links in a row measured 527px against a 390px viewport, so the page
 * scrolled sideways and every link wrapped its own text onto two lines — which
 * is also why the banner stopped short of the right edge. A rail is a desktop
 * idea. On a phone the navigation goes where a thumb is, which is the bottom.
 */
@media (max-width: 60rem) {
  .app { grid-template-columns: minmax(0, 1fr); gap: 0; }

  /* The rail becomes a top bar holding only identity. */
  .rail {
    position: static; height: auto; flex-direction: row; align-items: center;
    gap: .5rem; padding: .55rem 0; border-bottom: 1px solid var(--line);
  }
  .rail .brand { display: block; text-decoration: none; color: inherit; }
.brand { padding: 0; font-size: 1.05rem; }
  .rail .brand br, .rail .brand span { display: none; }

  /* And the links become a tab bar pinned to the bottom of the viewport. */
  .rail nav {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
    flex-direction: row; justify-content: space-around; gap: 0;
    background: var(--card); border-top: 1px solid var(--line);
    padding: .3rem .2rem calc(.3rem + env(safe-area-inset-bottom, 0px));
  }
  .rail nav a {
    flex: 1 1 0; min-width: 0; flex-direction: column; align-items: center;
    gap: .1rem; padding: .3rem .15rem; border-radius: 0;
    font-size: .62rem; line-height: 1.2; text-align: center;
  }
  .rail nav a:hover { background: none; }
  .rail nav a.on { color: var(--accent); }
  .rail nav a .ico { font-size: 1.05rem; opacity: 1; width: auto; }
  .rail nav a .full { display: none; }
  .rail nav a .tab { display: block; }

  /* The count rides on the icon rather than pushing the label sideways. */
  .rail nav a { position: relative; }
  .rail nav a .badge {
    position: absolute; top: .05rem; left: 50%; margin-left: .25rem;
    padding: 0 .3rem; font-size: .6rem;
  }

  /* Compose floats clear of the tab bar, the way a social client does it. */
  .rail .newpost {
    position: fixed; right: 1rem; z-index: 21; margin: 0; padding: 0;
    bottom: calc(4.1rem + env(safe-area-inset-bottom, 0px));
    width: 3.4rem; height: 3.4rem; border-radius: 999px;
    display: grid; place-items: center; font-size: 1.6rem; font-weight: 400;
    box-shadow: 0 2px 12px rgba(0, 0, 0, .28);
  }
  .rail .newpost .full { display: none; }
  .rail .newpost .tab { display: block; line-height: 1; }
  .rail .newpost.off { box-shadow: none; }

  /* Identity sits at the top right, and its menu drops from there. */
  .me { margin: 0 0 0 auto; position: relative; }
  .me > summary { padding: .25rem .3rem; }
  .me .who b { max-width: 8.5rem; }
  .switcher {
    position: absolute; right: 0; z-index: 22; width: 15rem;
    max-height: 60vh; box-shadow: 0 4px 16px rgba(0, 0, 0, .18);
  }

  /* Clear the tab bar and the floating button. */
  main { padding-bottom: 7rem; }
}
`

export type Mode = 'demo' | 'live'

/** Which rail entry is lit. */
export type NavKey = 'home' | 'inbox' | 'issuers' | 'docs' | null

/**
 * The one piece of per-request state every page shares: who the visitor is
 * looking as, and where they are.
 *
 * Identity lives in the shell rather than on the pages that write records
 * because the alternative — a picker on the issue page and another on the
 * verdict page — is what shipped first, and it was wrong in a way that took a
 * user to find: changing the in-page dropdown without pressing its button left
 * the cookie alone, so the very next request went back to whoever happened to
 * be first in the roster. One control, one place, takes effect immediately.
 */
export type Chrome = {
  actors?: Actor[]
  /** Handle in play, or undefined for the public. */
  current?: string
  active?: NavKey
  /** Parts waiting on the acting organization, for the rail's badge. */
  waiting?: number
  /**
   * Whether to hang the composer off this page. Off for `/issue`, where the
   * page already *is* the composer — two copies of a seventeen-block form in
   * one document means duplicate element ids and a second set of inputs for
   * anything reading the markup to trip over.
   */
  composer?: boolean
}

/** The value the switcher submits to mean "sign out and watch as a stranger". */
export const PUBLIC_HANDLE = '~public'

/**
 * A monogram, coloured from the name.
 *
 * Deterministic so an organization looks the same everywhere, and computed
 * rather than stored because a demonstration should not ship thirty avatars.
 */
export function avatar(name: string, small = false) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
  return html`<span class="av ${small ? 'sm' : ''}"
    style="background:hsl(${h % 360} 42% 40%)">${initials}</span>`
}

const KIND_LABEL: Record<string, string> = {
  oem: 'Manufacturer',
  mro: 'Repair station',
  operator: 'Operator',
  broker: 'Parts broker',
  lessor: 'Lessor',
}

const KIND_ORDER = ['mro', 'oem', 'operator', 'lessor', 'broker']

/**
 * The account control.
 *
 * A demonstration where everyone can be anyone, which every page says. Real
 * issuance would authenticate the individual who holds the certificate; this
 * authenticates nobody, and the point of the switcher is to let one visitor
 * walk through a transaction from both ends.
 */
function identity(chrome: Chrome) {
  const actors = chrome.actors ?? []
  const me = actors.find((a) => a.handle === chrome.current)

  return html`<details class="me">
    <summary>
      ${me ? avatar(me.displayName) : html`<span class="av public">··</span>`}
      <span class="who">
        <b>${me ? me.displayName : 'The public'}</b>
        <em>${me ? (KIND_LABEL[me.kind] ?? me.kind) : 'signed out'}</em>
      </span>
      <span class="caret">▾</span>
    </summary>
    <form method="post" action="/act-as" class="switcher">
      <h4>Watch without an account</h4>
      <button name="handle" value="${PUBLIC_HANDLE}" class="${me ? '' : 'on'}">
        <span class="av sm public">··</span> The public
      </button>
      ${KIND_ORDER.map((kind) => {
        const group = actors.filter((a) => a.kind === kind)
        if (group.length === 0) return ''
        return html`<h4>${KIND_LABEL[kind] ?? kind}</h4>
          ${group.map(
            (a) => html`<button name="handle" value="${a.handle}"
              class="${a.handle === chrome.current ? 'on' : ''}">
              ${avatar(a.displayName, true)} ${a.displayName}
            </button>`,
          )}`
      })}
    </form>
  </details>`
}

/**
 * Wiring for the composer.
 *
 * Every entry point into it is an ordinary link to `/issue`, upgraded here to
 * open the dialog in place. With scripting off the links still work and the
 * page they land on is the same markup, so the composer is an improvement on
 * the application rather than a requirement of it.
 *
 * Nothing here builds a form. The dialog fetches `/issue?fragment` and drops
 * in whatever comes back — a generated draft, the confirmation after it is
 * signed, or the draft again with an error on it. That keeps the modal and
 * the page rendering one template instead of two, which is the arrangement
 * the old generate-example button did not have: it filled inputs in the
 * client, and the client's idea of the field set drifted from the schema's
 * twice before anybody noticed.
 */
const COMPOSER_SCRIPT = `
(function () {
  var dlg = document.getElementById('composer')
  if (!dlg || !dlg.showModal) return
  var body = dlg.querySelector('.cbody')
  if (!body) return
  var RESTING = body.innerHTML

  function working(message) {
    body.innerHTML = RESTING
    var p = body.querySelector('.working p')
    if (p) p.textContent = message
  }

  function failed(message) {
    body.innerHTML = ''
    var box = document.createElement('div')
    box.className = 'empty'
    box.textContent = message
    var link = document.createElement('p')
    link.innerHTML = '<a href="/issue">Open the full page instead</a>'
    body.appendChild(box)
    body.appendChild(link)
  }

  // Whatever came back is live markup now: the draft's form has to submit
  // into the dialog rather than navigate, and a confirmation carries a bundle
  // that has to reach the browser's store before the visitor closes the box.
  function settle() {
    body.scrollTop = 0
    var out = body.querySelector('#out')
    if (out && window.f8130Keep) window.f8130Keep(out)
    var form = body.querySelector('form.draftform')
    if (!form) return
    form.addEventListener('submit', function (e) {
      e.preventDefault()
      working('Signing and publishing\u2026')
      send(fetch('/issue?fragment', { method: 'POST', body: new FormData(form) }),
           'Could not publish that certificate.')
    })
  }

  function send(pending, whenBroken) {
    pending.then(function (r) {
      // A 400 is the server handing back the draft with what went wrong on
      // it, which is a page worth showing. Anything else is not.
      if (!r.ok && r.status !== 400) throw new Error('bad status')
      return r.text()
    }).then(function (markup) {
      body.innerHTML = markup
      settle()
    }).catch(function () { failed(whenBroken) })
  }

  document.querySelectorAll('[data-compose]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault()
      dlg.showModal()
      working('Generating a synthetic 8130-3\u2026')
      // no-store: the URL never varies and every answer is a new certificate,
      // so a cached one is the last document handed back as if it were new.
      send(fetch('/issue?fragment', { cache: 'no-store' }),
           'Could not generate a certificate just now.')
    })
  })

  // Back to the loader on the way out, so the next open does not flash the
  // last visitor's certificate before its replacement arrives.
  dlg.addEventListener('close', function () { body.innerHTML = RESTING })
})()
`

/**
 * The filing cabinet, which is the visitor's browser and not this server.
 *
 * A bundle carries every nonce, so it opens every withheld block on the
 * record it belongs to. This service must therefore never store one — not to
 * be helpful, not for a moment. The rule holds here: bundles are written to
 * localStorage by the browser that was handed them, read back by the same
 * browser, and never sent anywhere except transiently to the /form endpoint
 * that folds the tree and returns the page.
 *
 * That is also a more honest demonstration than a server-side store would be.
 * An issuer can reopen a form they issued because *they hold the nonces*, not
 * because they are signed in. Nobody can grant that, and nobody can revoke it.
 */
/**
 * Dismissing the account switcher.
 *
 * It is a `details` element, which is the right markup — it works with
 * scripting off, it is a disclosure, and the browser handles the toggle. What
 * `details` does not do is close when you click away from it, because nothing
 * in the element's contract says it should. Every menu a visitor has ever used
 * does, so the absence reads as a bug rather than as a difference.
 *
 * Two ways out, matching what a menu normally offers: a click anywhere outside
 * and the Escape key. Escape returns focus to the summary, because a keyboard
 * user who dismisses a menu has otherwise lost their place in the page.
 */
const SWITCHER_SCRIPT = `
(function () {
  var me = document.querySelector('details.me')
  if (!me) return
  document.addEventListener('click', function (e) {
    if (me.open && !me.contains(e.target)) me.open = false
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && me.open) {
      me.open = false
      var s = me.querySelector('summary')
      if (s) s.focus()
    }
  })
})()
`

const CABINET_SCRIPT = `
(function () {
  // Not renamed with the app. This key addresses documents already sitting in
  // people's browsers, and a bundle cannot be reissued — the nonces are not
  // recoverable from the commitment — so changing it would silently orphan
  // every document anyone is holding.
  var KEY = 'f8130.bundles' 
  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch (e) { return {} }
  }
  function write(all) {
    try { localStorage.setItem(KEY, JSON.stringify(all)) } catch (e) {}
  }

  // Keep a bundle the moment it is handed over. It cannot be reconstructed.
  //
  // Exported rather than run once at load, because the composer is handed its
  // bundle after this script has finished: the confirmation arrives as markup
  // fetched into a dialog, and a document that is only stored on a full page
  // load is a document lost every time somebody uses the modal.
  window.f8130Keep = function (out) {
    if (!out || !out.dataset.uri) return
    var all = read()
    all[out.dataset.uri] = out.value
    write(all)
  }
  window.f8130Keep(document.getElementById('out'))

  // On a record page, open it if this browser happens to hold its bundle.
  var opener = document.getElementById('opener')
  if (opener && !opener.dataset.open) {
    var held = read()[opener.dataset.uri]
    if (held) {
      var f = document.getElementById('openWith')
      if (f) { f.elements['bundle'].value = held; f.submit() }
    }
  }

  var list = document.getElementById('cabinet')
  if (list) {
    var all2 = read()
    var uris = Object.keys(all2)
    if (uris.length === 0) { list.innerHTML = '<div class="empty">This browser is holding no documents.</div>'; return }
    list.innerHTML = uris.map(function (uri) {
      var parts = uri.split('/')
      var href = '/form?uri=' + encodeURIComponent(uri)
      return '<div class="link"><div class="body" style="flex:1">' +
        '<div class="title"><a href="' + href + '">' + parts[4] + '</a></div>' +
        '<div class="detail mono" style="word-break:break-all">' + uri + '</div>' +
        '</div></div>'
    }).join('')
  }
})()
`

export function layout(
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
  mode: Mode = 'live',
  chrome?: Chrome,
) {
  const actors = chrome?.actors ?? []
  const me = actors.find((a) => a.handle === chrome?.current)
  const on = (key: NavKey) => (chrome?.active === key ? 'on' : '')
  const withComposer = actors.length > 0 && chrome?.composer !== false

  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · OffWing</title>
<style>${raw(STYLES)}</style>
</head>
<body>
<div class="marker">
  <strong>Note:</strong> This is a prototype for demonstration purposes only
  and is built with synthetic data.${mode === 'demo'
    ? html` <strong>Demo instance</strong> —
        <a href="/demo/bundles.json">sample documents</a>.`
    : ''}
</div>
<div class="app">
  <aside class="rail">
    <a class="brand" href="/">OffWing<br><span>FAA 8130-3 certificates on atproto</span></a>
    <!-- Four destinations, and each answers a different question. Feed: what
         is happening. Receiving: what is waiting on me. Issuers: who is
         publishing, and how much of it anybody has vouched for. Documents: what
         I am holding, and the things I can do with it.

         Checking a document and proving one field used to be nav entries of
         their own. Both are operations on a bundle you hold, so they belong
         where the bundles are rather than beside them — and one of the two was
         not in the nav at all, which is how an entire page went unreachable.

         Two labels per entry, because a rail and a tab bar want different
         words. Both are in the markup rather than one derived from the other,
         so a screen reader gets a real label either way. -->
    <nav>
      <a href="/" class="${on('home')}"><span class="ico">◎</span>
        <span class="full">Feed</span><span class="tab">Feed</span></a>
      ${me
        ? html`<a href="/inbox" class="${on('inbox')}"><span class="ico">⤓</span>
            <span class="full">Receiving</span><span class="tab">Receiving</span>
            <!-- Always in the markup, hidden at zero, so the live stream has
                 something to write into rather than a node it has to create in
                 the right place in the rail. -->
            <span class="badge" id="waiting" ${chrome?.waiting ? '' : 'hidden'}
              >${chrome?.waiting ?? 0}</span>
          </a>`
        : ''}
      <a href="/parts" class="${on('issuers')}"><span class="ico">▤</span>
        <span class="full">Issuers</span><span class="tab">Issuers</span></a>
      <a href="/cabinet" class="${on('docs')}"><span class="ico">▣</span>
        <span class="full">Documents</span><span class="tab">Docs</span></a>
    </nav>
    ${actors.length > 0
      ? me
        ? html`<a href="/issue" class="newpost" ${withComposer ? 'data-compose' : ''}
            aria-label="New release"><span class="full">New release</span
            ><span class="tab">+</span></a>`
        : html`<span class="newpost off" title="The public cannot sign"
            ><span class="full">New release</span><span class="tab">+</span></span>`
      : ''}
    ${actors.length > 0 ? identity(chrome!) : ''}
  </aside>
  <main>
    ${body}
  </main>
</div>
${withComposer ? composer() : ''}
${withComposer ? html`${raw(`<script>${COMPOSER_SCRIPT}</script>`)}` : ''}
${raw(`<script>${CABINET_SCRIPT}</script>`)}
${actors.length > 0 ? html`${raw(`<script>${SWITCHER_SCRIPT}</script>`)}` : ''}
</body>
</html>`
}
