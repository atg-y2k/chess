#!/usr/bin/env node
/**
 * Lists what still has to be filled in on the legal pages before an App Store release: the
 * placeholders of the drafts ([YOUR LEGAL NAME], [YOUR POSTAL ADDRESS], [GOVERNING LAW], the
 * example.com support address) and the terms page's "Draft" notice. HTML comments are skipped
 * (they may name the placeholders). deploy.yml publishes public/ with the web app, so these pages
 * go live as they are; the release workflow runs this before every App Store build.
 *
 *   node scripts/check-legal-pages.mjs            prints what is left (exit code 0)
 *   node scripts/check-legal-pages.mjs --strict   exit code 1 if anything is left
 *
 * In GitHub Actions the findings are also annotations (errors with --strict, else warnings).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The pages the app and App Store Connect link to (LEGAL_URLS in src/native/platform.ts). */
export const LEGAL_PAGES = ['public/privacy.html', 'public/terms.html', 'public/support.html'];

/** What must not be left in them. */
export const PLACEHOLDERS = [/\[YOUR [A-Z ]+\]/, /\[GOVERNING LAW\]/, /@example\.com/, /class="draft-notice"/];

/** The lines of `html` (outside comments) that still hold a placeholder, 1-based. */
export function findPlaceholders(html) {
  // Blank out comments but keep their line breaks, so line numbers stay right.
  const text = html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const found = [];
  text.split('\n').forEach((line, i) => {
    if (PLACEHOLDERS.some((re) => re.test(line))) found.push({ line: i + 1, text: line.trim() });
  });
  return found;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const strict = process.argv.includes('--strict');
  const annotate = process.env.GITHUB_ACTIONS === 'true';
  let count = 0;
  for (const page of LEGAL_PAGES) {
    for (const { line, text } of findPlaceholders(readFileSync(join(root, page), 'utf8'))) {
      count++;
      console.log(`${page}:${line}: ${text}`);
      if (annotate) console.log(`::${strict ? 'error' : 'warning'} file=${page},line=${line}::Not filled in yet: ${text}`);
    }
  }
  if (count === 0) return;
  console.log(
    `\n${count} line(s) on the legal pages still need the owner's details (see docs/APP_STORE.md, section 18).`,
  );
  if (strict) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
