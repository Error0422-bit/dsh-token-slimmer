/**
 * A stored session log must stay loadable by any harness — including one that
 * has never heard of this plugin.
 *
 * The reader refuses to interpret a stored log holding an event type outside its
 * first-party catalog unless the row itself carries `ignorable: true`
 * (`dsh-session-persistence/lib/index.js:184`), and that catalog cannot be
 * extended by a plugin. `Session.append` therefore has to carry the member
 * through to the envelope; it did not, and the row written without it did not
 * throw the way the `surfaceOp: "replace"` route did — it poisoned the log.
 * Measured on a real store: a session carrying four `token-slimmer/
 * reasoning-bounded` rows came back from the reader as
 *
 *   contains event type "token-slimmer/reasoning-bounded" (seq 7973) unknown to
 *   this harness and not marked ignorable; refusing to interpret the log — it
 *   was likely written by a newer harness
 *
 * which made the whole session unopenable, by this harness exactly as much as by
 * any other. The rule these tests pin: every durable event this plugin appends
 * is either a type the catalog already knows, or it says `ignorable: true`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = ['index.js', 'slim.js', 'reasoning.js', 'policy.js', 'importance.js', 'metrics.js', 'recovery-store.js'];

/** Every `session.append(<type>, …)` call in the shipped plugin source. */
function appendCallSites() {
  const sites = [];
  for (const file of SOURCES) {
    const lines = readFileSync(join(PLUGIN_DIR, file), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const match = /session\.append\(\s*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")/.exec(lines[i]);
      if (match !== null) sites.push({ file, line: i + 1, type: match[1], text: lines[i] });
    }
  }
  return sites;
}

test('every namespaced plugin event is appended with the ignorable marker', () => {
  const sites = appendCallSites();
  const namespaced = sites.filter((site) => site.type === 'REASONING_BOUNDED_EVENT' || /['"]token-slimmer\//.test(site.type));
  for (const site of namespaced) {
    assert.match(
      site.text,
      /ignorable:\s*true/,
      `${site.file}:${site.line} appends ${site.type} without ignorable: true — the harness refuses any stored log carrying an unknown type that is not marked ignorable, which makes the whole session unopenable`,
    );
  }
});

test('the plugin declares its own event type and keeps the write gated', () => {
  const index = readFileSync(join(PLUGIN_DIR, 'index.js'), 'utf8');
  const reasoning = readFileSync(join(PLUGIN_DIR, 'reasoning.js'), 'utf8');
  assert.match(index, /ignorable:\s*true/, 'the append carries the marker the envelope declares');
  assert.match(
    reasoning,
    /export const REASONING_WRITES_VERIFIED = false;/,
    'a harness whose append drops the option would write unreadable rows, so writes stay behind this flag',
  );
  assert.match(index, /REASONING_WRITES_VERIFIED/, 'and the write path consults it');
});
