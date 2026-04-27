/**
 * Kanban 101 — onboarding guide for new team members. Modeled on Trello's
 * /guide/trello-101: four sections (Boards → Columns → Cards → Board
 * controls), one illustration per section, sticky table of contents on
 * the left at desktop widths, ~5-minute read.
 *
 * Linked from the top nav, footer, the keyboard-shortcut overlay, and
 * the empty-board state on /kanban/<slug>.
 */

import type { FC } from 'hono/jsx';
import { raw } from 'hono/html';
import { Layout } from './Layout';
import type { AuthUser } from '../env';
import {
  BoardsIllustration,
  CardIllustration,
  ColumnsIllustration,
  ControlsIllustration,
} from './illustrations/kanban101';

interface GuideKanban101PageProps {
  user: AuthUser;
}

export const GuideKanban101Page: FC<GuideKanban101PageProps> = ({ user }) => {
  return (
    <Layout title="Kanban 101 · Guide" user={user}>
      <style>{css}</style>
      <div class="guide-wrap">
        <aside class="guide-toc" aria-label="On this page">
          <p class="guide-toc-eyebrow">On this page</p>
          <ol class="guide-toc-list">
            <li><a href="#boards" data-toc="boards">Boards</a></li>
            <li><a href="#columns" data-toc="columns">Columns</a></li>
            <li><a href="#cards" data-toc="cards">Cards</a></li>
            <li><a href="#controls" data-toc="controls">Controls &amp; views</a></li>
          </ol>
          <p class="guide-toc-foot muted">
            ~5-minute read. Press <kbd>?</kbd> anywhere for keyboard shortcuts.
          </p>
        </aside>

        <article class="guide-article">
          <header class="guide-hero">
            <p class="guide-eyebrow">Guide</p>
            <h1>Kanban 101</h1>
            <p class="guide-lede">
              A short tour of how this board works — boards, columns, cards,
              and the controls that tie them together. If you've used Trello,
              most of this will feel familiar; the rest is what makes ours
              different.
            </p>
          </header>

          <section id="boards" class="guide-section">
            <h2>Boards</h2>
            <figure class="guide-figure">
              <BoardsIllustration />
              <figcaption>
                A board is the home for one project, team, or workflow.
              </figcaption>
            </figure>
            <p>
              Each board is a self-contained workspace: its own columns, its
              own cards, its own history. Switch between boards from
              <a href="/kanban"> Boards</a> in the top nav. The board's
              short name lives in the URL — <code>/kanban/marketing</code>,
              <code>/kanban/engineering</code>, and so on — so you can
              bookmark or share a direct link.
            </p>
            <ul>
              <li>Anyone signed in can <strong>view</strong> any board.</li>
              <li>Anyone can <strong>create or edit cards</strong>.</li>
              <li>
                <strong>Staff</strong> can add, rename, recolor, reorder, and
                delete the columns themselves.
              </li>
            </ul>
            <aside class="guide-tip">
              <strong>Pro tip:</strong> every change is broadcast in real
              time to everyone viewing the board — no refresh needed. If a
              teammate moves a card while you're looking, you'll see it slide.
            </aside>
          </section>

          <section id="columns" class="guide-section">
            <h2>Columns</h2>
            <figure class="guide-figure">
              <ColumnsIllustration />
              <figcaption>
                Columns are the workflow stages a card moves through.
              </figcaption>
            </figure>
            <p>
              Columns run left-to-right across the board. Most teams use
              something like <em>Backlog → In Progress → Review → Done</em>,
              but every board sets its own. Click a column's title to rename
              it, the colored swatch to recolor it, and the <code>×</code> to
              delete it (only when it's empty).
            </p>
            <ul>
              <li>
                <strong>Reorder</strong> a column by grabbing its header strip
                and dragging it left or right. Other columns slide aside to
                show where it'll land.
              </li>
              <li>
                <strong>Add</strong> a new column with the
                <code> + Add column</code> tile at the right edge.
              </li>
              <li>
                <strong>WIP limit</strong>: click the count badge in a column
                header to set a maximum. The badge turns red when the
                column is over the limit — useful for catching pile-ups.
              </li>
            </ul>
            <aside class="guide-tip">
              <strong>Pro tip:</strong> WIP limits aren't enforced — they're
              a nudge. The board still lets you exceed them; the red badge
              is the conversation starter.
            </aside>
          </section>

          <section id="cards" class="guide-section">
            <h2>Cards</h2>
            <figure class="guide-figure">
              <CardIllustration />
              <figcaption>
                A card is one task — and everything that goes with it.
              </figcaption>
            </figure>
            <p>
              Click <code>+</code> in any column to create a card, or press
              <kbd>n</kbd> from anywhere on the board to add one to the
              leftmost column. Click an existing card to open it. A card can
              hold:
            </p>
            <ul>
              <li><strong>Title</strong> and notes (Markdown is supported in notes).</li>
              <li><strong>Assignees</strong> — one or more team members.</li>
              <li><strong>Start &amp; due dates</strong>, with optional due time.</li>
              <li><strong>Labels</strong> — short colored tags shared across the board.</li>
              <li><strong>Cover color</strong> for at-a-glance scanning.</li>
              <li><strong>Checklists</strong>, <strong>attachments</strong>, and threaded <strong>comments</strong>.</li>
            </ul>
            <p>
              Drag a card between columns to move it. Drag inside a column
              to reorder it. To get rid of a card, archive it from the card
              modal — the archive drawer keeps it around in case you change
              your mind.
            </p>
            <aside class="guide-tip">
              <strong>Pro tip:</strong> <code>@mention</code> a teammate in
              a comment to send them a notification. The bell icon in the
              top nav shows your unread mentions and assignments.
            </aside>
          </section>

          <section id="controls" class="guide-section">
            <h2>Controls &amp; views</h2>
            <figure class="guide-figure">
              <ControlsIllustration />
              <figcaption>
                Search, filter, and switch how you look at the same data.
              </figcaption>
            </figure>
            <p>
              The filter row at the top of any board narrows the visible
              cards. Type plain words to search, or use operators for
              precise filters:
            </p>
            <ul class="guide-ops">
              <li><code>assigned:lion</code> — cards assigned to a teammate</li>
              <li><code>label:urgent</code> — cards with a specific label</li>
              <li><code>column:done</code> — cards in a named column</li>
              <li><code>has:due</code>, <code>has:cover</code>, <code>has:notes</code> — cards with that field set</li>
              <li><code>is:overdue</code>, <code>is:mine</code>, <code>is:archived</code></li>
            </ul>
            <p>
              The same data can be viewed four different ways from the top
              nav: <a href="/kanban">Boards</a> (kanban),
              <a href="/table"> Table</a>, <a href="/calendar"> Calendar</a>,
              and <a href="/timeline"> Timeline</a>. Use the table view when
              you want to sort by due date or scan a long list; use the
              calendar to see what's due this week.
            </p>
            <aside class="guide-tip">
              <strong>Pro tip:</strong> press <kbd>?</kbd> from anywhere to
              see every keyboard shortcut, including the <kbd>g</kbd>-then-
              letter chord shortcuts for fast navigation between views.
            </aside>
          </section>

          <footer class="guide-end">
            <p class="muted">
              That's the whole tour. Head to <a href="/kanban">Boards</a> to
              jump in, or press <kbd>?</kbd> for keyboard shortcuts.
            </p>
          </footer>
        </article>
      </div>
      <script>{raw(tocClientJs)}</script>
    </Layout>
  );
};

const css = `
  /* Page-level layout — sticky TOC on the left, prose on the right at
     desktop widths; collapses to a single column on mobile. */
  .guide-wrap {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    gap: 40px;
    max-width: 920px;
    margin: 0 auto;
  }
  @media (max-width: 760px) {
    .guide-wrap { grid-template-columns: 1fr; gap: 16px; }
    .guide-toc { position: static; }
  }

  .guide-toc {
    position: sticky;
    top: 24px;
    align-self: start;
    font-size: 0.92em;
  }
  .guide-toc-eyebrow {
    margin: 0 0 8px;
    font-size: 0.75em;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    opacity: 0.55;
    font-weight: 600;
  }
  .guide-toc-list {
    list-style: none;
    margin: 0; padding: 0;
    border-left: 2px solid rgba(128,128,128,0.2);
  }
  .guide-toc-list li { margin: 0; }
  .guide-toc-list a {
    display: block;
    padding: 6px 12px;
    margin-left: -2px;
    color: inherit;
    text-decoration: none;
    border-left: 2px solid transparent;
    opacity: 0.75;
  }
  .guide-toc-list a:hover { opacity: 1; }
  .guide-toc-list a.is-active {
    opacity: 1;
    font-weight: 600;
    border-left-color: var(--brand);
  }
  .guide-toc a:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
    border-radius: 3px;
  }
  .guide-toc-foot { margin-top: 16px; font-size: 0.85em; }

  .guide-hero { margin: 0 0 32px; }
  .guide-eyebrow {
    margin: 0 0 4px;
    font-size: 0.78em;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    opacity: 0.6;
    font-weight: 600;
  }
  .guide-hero h1 {
    margin: 0 0 12px;
    font-size: 2em;
    line-height: 1.15;
  }
  .guide-lede {
    font-size: 1.05em;
    line-height: 1.55;
    opacity: 0.85;
    max-width: 60ch;
  }

  .guide-section { margin: 48px 0; scroll-margin-top: 24px; }
  .guide-section h2 {
    margin: 0 0 12px;
    font-size: 1.45em;
    line-height: 1.2;
  }
  .guide-section p { line-height: 1.6; max-width: 65ch; }
  .guide-section ul { line-height: 1.7; padding-left: 20px; max-width: 65ch; }
  .guide-section li { margin: 4px 0; }
  .guide-section code {
    background: rgba(128,128,128,0.15);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.9em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .guide-section kbd {
    display: inline-block;
    min-width: 16px;
    padding: 1px 6px;
    border: 1px solid rgba(128,128,128,0.45);
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
    line-height: 1.2;
    text-align: center;
    background: rgba(128,128,128,0.08);
  }
  .guide-section a {
    color: var(--brand);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }

  .guide-figure {
    margin: 16px 0 20px;
    padding: 16px;
    border: 1px solid rgba(128,128,128,0.2);
    border-radius: 10px;
    background: rgba(128,128,128,0.04);
  }
  .guide-figure figcaption {
    margin-top: 10px;
    font-size: 0.88em;
    opacity: 0.65;
    text-align: center;
  }
  .guide-illus {
    display: block;
    width: 100%;
    height: auto;
    max-width: 100%;
  }

  .guide-tip {
    margin: 16px 0 0;
    padding: 12px 16px;
    border-radius: 8px;
    background: rgba(37, 99, 235, 0.08);
    border-left: 3px solid var(--brand);
    font-size: 0.95em;
    line-height: 1.5;
  }
  .guide-tip strong { color: var(--brand); }

  .guide-ops { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }

  .guide-end { margin-top: 64px; padding-top: 24px; border-top: 1px solid rgba(128,128,128,0.2); }
`;

// Scroll-spy for the sticky TOC: highlight the section currently visible
// in the viewport. IntersectionObserver-based; no scroll event spam.
const tocClientJs = `
(function() {
  'use strict';
  var sections = document.querySelectorAll('.guide-section');
  if (!sections.length || !('IntersectionObserver' in window)) return;
  var links = {};
  document.querySelectorAll('.guide-toc-list a[data-toc]').forEach(function(a) {
    links[a.getAttribute('data-toc')] = a;
  });
  function setActive(id) {
    Object.keys(links).forEach(function(k) {
      links[k].classList.toggle('is-active', k === id);
    });
  }
  var current = null;
  var observer = new IntersectionObserver(function(entries) {
    // Pick the topmost section that is past the 25% mark from the top.
    entries.forEach(function(e) {
      if (e.isIntersecting) current = e.target.id;
    });
    if (current) setActive(current);
  }, { rootMargin: '-25% 0px -65% 0px', threshold: 0 });
  sections.forEach(function(s) { observer.observe(s); });
})();
`;
