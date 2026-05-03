/**
 * MCP Connector guide — how to add this site to Claude.ai as a connector
 * so the assistant can read and edit Kanban boards on your behalf.
 *
 * Linked from the footer alongside Kanban 101. Same visual structure as
 * the Kanban 101 page (sticky TOC, hero, sections, tip callouts) so the
 * two guides feel like a series rather than one-offs.
 */

import type { FC } from 'hono/jsx';
import { raw } from 'hono/html';
import { Layout } from './Layout';
import type { AuthUser } from '../env';

interface GuideMcpPageProps {
  user: AuthUser;
}

export const GuideMcpPage: FC<GuideMcpPageProps> = ({ user }) => {
  return (
    <Layout title="MCP Connector · Guide" user={user}>
      <style>{css}</style>
      <div class="guide-wrap">
        <aside class="guide-toc" aria-label="On this page">
          <p class="guide-toc-eyebrow">On this page</p>
          <ol class="guide-toc-list">
            <li><a href="#what" data-toc="what">What it is</a></li>
            <li><a href="#install" data-toc="install">Install in Claude</a></li>
            <li><a href="#use" data-toc="use">Using it</a></li>
            <li><a href="#tools" data-toc="tools">Available tools</a></li>
            <li><a href="#permissions" data-toc="permissions">Permissions &amp; safety</a></li>
            <li><a href="#troubleshooting" data-toc="troubleshooting">Troubleshooting</a></li>
          </ol>
          <p class="guide-toc-foot muted">
            ~7-minute read. New to the site? Start with{' '}
            <a href="/guide">Kanban 101</a>.
          </p>
        </aside>

        <article class="guide-article">
          <header class="guide-hero">
            <p class="guide-eyebrow">Guide</p>
            <h1>MCP Connector</h1>
            <p class="guide-lede">
              The internal site exposes its Kanban boards as a{' '}
              <strong>Model Context Protocol</strong> (MCP) connector,
              so Claude can read your boards and create or edit cards on
              your behalf — entirely through natural-language requests in
              Claude.ai. This guide walks through adding the connector,
              what it can do, and the safety boundaries.
            </p>
          </header>

          <section id="what" class="guide-section">
            <h2>What it is</h2>
            <p>
              MCP is an open standard that lets external tools plug into
              Claude as <em>connectors</em>. Once installed, Claude can call
              the connector's tools the same way it calls its own —
              "create a card", "list my boards", "move all the blocked
              cards to In Progress" — and the work happens against the
              live production database.
            </p>
            <p>
              You only ever sign in once: when you add the connector,
              Claude.ai sends you through the usual Okta sign-in flow. The
              tokens it gets back are <strong>scoped to your user</strong>,
              and every action Claude takes is recorded in the audit log
              with your name on it. Other people viewing the same board
              see your edits appear in real time, just as if you'd made
              them in the browser.
            </p>
            <aside class="guide-tip">
              <strong>Pro tip:</strong> the connector is best for bulk or
              repetitive work — importing a list of tasks, triaging a
              backlog, generating cards from meeting notes. For one-off
              edits the browser is still faster.
            </aside>
          </section>

          <section id="install" class="guide-section">
            <h2>Install in Claude</h2>
            <p>
              Adding the connector takes about a minute. You'll need a
              Claude.ai account on a plan that supports custom connectors
              (Pro, Team, or Enterprise as of writing).
            </p>
            <ol class="guide-steps">
              <li>
                Open Claude at{' '}
                <a href="https://claude.ai" rel="noreferrer noopener" target="_blank">
                  claude.ai
                </a>{' '}
                and go to <strong>Settings → Connectors</strong>.
              </li>
              <li>
                Click <strong>Add custom connector</strong> (or "Browse
                connectors" → "Add custom" depending on your plan's UI).
              </li>
              <li>
                Fill in the form:
                <ul>
                  <li>
                    <strong>Name:</strong> <code>APRS Kanban</code> (or
                    whatever you want — this is just a label).
                  </li>
                  <li>
                    <strong>URL:</strong>{' '}
                    <code>https://internal.aprsfoundation.org/mcp</code>
                  </li>
                </ul>
              </li>
              <li>
                Click <strong>Connect</strong>. Claude opens a new tab and
                redirects you through Okta. Sign in with your normal
                APRS Foundation account.
              </li>
              <li>
                Okta sends you back to Claude.ai with an OAuth grant. The
                connector now shows as <strong>Connected</strong>.
              </li>
            </ol>
            <p>
              Start a new chat and you'll see the connector listed in the
              tools panel. From any chat you can toggle it on or off per
              conversation.
            </p>
            <aside class="guide-tip">
              <strong>Pro tip:</strong> the OAuth grant lasts until you
              revoke it. To revoke, remove the connector from
              Claude.ai's settings — that drops Claude's tokens. To revoke
              from the server side as well, ask an admin to delete the
              grant from the OAuth KV store.
            </aside>
          </section>

          <section id="use" class="guide-section">
            <h2>Using it</h2>
            <p>
              Talk to Claude normally; it'll reach for the connector when
              your request matches one of its tools. A few starting
              points that work well:
            </p>
            <ul>
              <li>
                <em>"List my Kanban boards on the internal site."</em>
              </li>
              <li>
                <em>"Create a board called Q3 Planning, then add cards
                  from this list to its Not Started column: …"</em>
              </li>
              <li>
                <em>"On the marketing board, move every card whose title
                  starts with [DRAFT] into Approval."</em>
              </li>
              <li>
                <em>"Take the meeting notes I just pasted and create one
                  card per action item, assigned to the named person, on
                  the engineering board."</em>
              </li>
              <li>
                <em>"Add a checklist to card 412 with these items: … and
                  mark the first three done."</em>
              </li>
            </ul>
            <p>
              Claude will usually narrate what it's about to do before
              making changes — and for anything destructive (delete,
              archive in bulk) it'll typically ask first. You can also be
              explicit: <em>"…but show me the plan before you create
              anything."</em>
            </p>
            <aside class="guide-tip">
              <strong>Pro tip:</strong> for bulk imports of more than
              ~20 cards, ask Claude to use the <code>bulk_import_cards</code>{' '}
              tool with a CSV — it's a single round-trip instead of one
              tool call per card, much faster.
            </aside>
          </section>

          <section id="tools" class="guide-section">
            <h2>Available tools</h2>
            <p>
              You don't have to memorise the tool list — Claude knows what
              each one does and picks the right one. This is just for
              reference if you're curious or troubleshooting.
            </p>

            <h3 class="guide-h3">Read</h3>
            <ul class="guide-tools">
              <li><code>whoami</code> — confirm which user the connector is signed in as</li>
              <li><code>list_boards</code> — every board you can see</li>
              <li><code>get_board</code> — full snapshot of one board (columns, labels, active cards)</li>
            </ul>

            <h3 class="guide-h3">Boards (staff only)</h3>
            <ul class="guide-tools">
              <li><code>create_board</code> — new board with the canonical 6-column layout</li>
              <li><code>bulk_import_cards</code> — drop up to 500 cards into a column from CSV</li>
            </ul>

            <h3 class="guide-h3">Cards</h3>
            <ul class="guide-tools">
              <li><code>create_card</code> — new card with title, notes, labels, assignees, dates</li>
              <li><code>update_card</code> — edit any card field (uses optimistic-concurrency versions)</li>
              <li><code>move_card</code> — to a different column or position</li>
              <li><code>archive_card</code> · <code>unarchive_card</code> · <code>delete_card</code></li>
              <li><code>add_comment</code> — including <code>@mention</code> notifications</li>
              <li><code>add_checklist_item</code> · <code>set_checklist_item</code> · <code>delete_checklist_item</code></li>
            </ul>

            <h3 class="guide-h3">Columns (staff only)</h3>
            <ul class="guide-tools">
              <li><code>add_column</code> · <code>rename_column</code> · <code>delete_column</code></li>
              <li><code>move_column</code> — reorder by passing the full key list left-to-right</li>
              <li><code>set_column_color</code></li>
            </ul>

            <h3 class="guide-h3">Labels (staff only)</h3>
            <ul class="guide-tools">
              <li><code>create_label</code> · <code>rename_label</code> · <code>delete_label</code></li>
              <li><code>set_label_color</code></li>
            </ul>
          </section>

          <section id="permissions" class="guide-section">
            <h2>Permissions &amp; safety</h2>
            <p>
              The connector acts <strong>as you</strong>. It can do
              everything you can do in the browser, and nothing you
              can't:
            </p>
            <ul>
              <li>
                Anyone signed in can <strong>read</strong> any board and
                <strong> create or edit cards</strong>.
              </li>
              <li>
                Only <strong>staff</strong> can create boards, do bulk
                CSV imports, manage columns, or manage labels. If a
                non-staff user asks Claude to do one of those, the tool
                returns <code>forbidden</code> and Claude reports it.
              </li>
              <li>
                Every change is written to the same audit log as
                browser-driven edits, with your user ID. Look for
                <code> login.okta.mcp</code> rows in the audit log to see
                connector sign-ins.
              </li>
              <li>
                Live broadcast still works: anyone with the board open
                in a browser sees Claude's edits arrive in real time.
              </li>
            </ul>
            <aside class="guide-tip">
              <strong>Pro tip:</strong> if you'd rather Claude not be
              able to make a particular kind of change, just tell it so
              in the chat ("you can read but please don't delete
              anything") — it will respect the instruction. For a hard
              guarantee, remove the connector when you're not actively
              using it.
            </aside>
          </section>

          <section id="troubleshooting" class="guide-section">
            <h2>Troubleshooting</h2>
            <dl class="guide-faq">
              <dt>The OAuth flow fails or hangs at Okta.</dt>
              <dd>
                Make sure you're signing in with the same APRS Foundation
                Okta account you use for the website. Cross-organisation
                accounts won't work. Clear cookies for both
                <code> internal.aprsfoundation.org</code> and
                <code> claude.ai</code> and try again.
              </dd>
              <dt>Claude says "forbidden: this action requires staff role".</dt>
              <dd>
                You're signed in as a viewer. Ask an admin to grant you
                staff, then disconnect and reconnect the connector so the
                new role flows through to Claude's token.
              </dd>
              <dt>"version_conflict" when updating a card.</dt>
              <dd>
                Someone else edited the card after you (or Claude) last
                read it. Ask Claude to <em>"re-fetch the card and try
                again"</em> — it'll grab the new version number and retry.
              </dd>
              <dt>"unknown_column" or a label name that should exist.</dt>
              <dd>
                Names are case-sensitive for column keys but
                case-insensitive for label names. If Claude gets it
                wrong, tell it the exact name; it's not psychic.
              </dd>
              <dt>Changes aren't appearing in my open browser tab.</dt>
              <dd>
                The board only listens for live updates while the WebSocket
                is connected. If your tab has been backgrounded for a
                while, it may have dropped the socket — refresh and the
                MCP-driven changes will be there.
              </dd>
              <dt>I want to revoke Claude's access right now.</dt>
              <dd>
                Remove the connector in Claude.ai's settings. For a
                belt-and-suspenders revocation, ask an admin to delete
                the corresponding grant from the OAuth KV namespace —
                that invalidates the token even if a copy escaped.
              </dd>
            </dl>
          </section>

          <footer class="guide-end">
            <p class="muted">
              That's the connector. Head back to{' '}
              <a href="/kanban">Boards</a> or pop open Claude and try a
              <em> "list my boards"</em> to confirm everything is wired up.
            </p>
          </footer>
        </article>
      </div>
      <script>{raw(tocClientJs)}</script>
    </Layout>
  );
};

const css = `
  /* Reuses Kanban 101's visual conventions; selectors are namespaced
     to .guide-* so both pages can carry their own copy without clashing. */
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
  .guide-h3 {
    margin: 24px 0 6px;
    font-size: 1.05em;
    opacity: 0.75;
    letter-spacing: 0.02em;
  }
  .guide-section p { line-height: 1.6; max-width: 65ch; }
  .guide-section ul, .guide-section ol { line-height: 1.7; padding-left: 20px; max-width: 65ch; }
  .guide-section li { margin: 4px 0; }
  .guide-section code {
    background: rgba(128,128,128,0.15);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.9em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .guide-section a {
    color: var(--brand);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }

  .guide-steps { counter-reset: step; }
  .guide-steps li { margin: 8px 0; }
  .guide-steps ul { margin: 6px 0; }

  .guide-tools {
    line-height: 1.8;
    max-width: 70ch;
  }
  .guide-tools code {
    /* Slightly stronger contrast on the tool list since each line leads
       with code — readers scan tool names first, descriptions second. */
    background: rgba(128,128,128,0.18);
    font-weight: 500;
  }

  .guide-faq dt {
    margin-top: 14px;
    font-weight: 600;
  }
  .guide-faq dd {
    margin: 4px 0 0;
    padding-left: 0;
    line-height: 1.6;
    max-width: 65ch;
    opacity: 0.9;
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

  .guide-end { margin-top: 64px; padding-top: 24px; border-top: 1px solid rgba(128,128,128,0.2); }
`;

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
    entries.forEach(function(e) {
      if (e.isIntersecting) current = e.target.id;
    });
    if (current) setActive(current);
  }, { rootMargin: '-25% 0px -65% 0px', threshold: 0 });
  sections.forEach(function(s) { observer.observe(s); });
})();
`;
