#!/usr/bin/env node
// Refresh the prices built into index.html from her live `packages` list.
//
// The page renders prices and the inquiry dropdown from `packages` at load
// (cms/prices.js). The copies baked into index.html are only what a visitor
// sees if that read fails, so being a little behind is harmless — but run this
// with ./bin/sync-fallback.py before any release so the backup stays honest.
//
//   ./bin/sync-prices.mjs            # show what would change
//   ./bin/sync-prices.mjs --write    # actually change it
//
// Uses functions/lib/price-display.js, the same wording rules the live page
// uses, so the backup can never phrase a price differently from the real one.
// Refuses to write if the data-cms-id marker count or contact-form ids change.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  usablePackages, sitePriceText, inquiryOptionText
} from '../functions/lib/price-display.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(ROOT, 'index.html');
const URL = 'https://firestore.googleapis.com/v1/projects/capturewithki-69dd3/databases/(default)/documents/packages?pageSize=100';
const FORM_IDS = ['n1', 'n2', 'em', 'ph', 'dt', 'cl', 'fv', 'ms', 'send', 'sent'];

function value(v) {
  if (!v || typeof v !== 'object') return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('mapValue' in v) return fields(v.mapValue.fields || {});
  return undefined;
}
function fields(f) {
  const out = {};
  for (const k of Object.keys(f)) out[k] = value(f[k]);
  return out;
}
function counts(html) {
  return {
    markers: (html.match(/data-cms-id/g) || []).length,
    ids: FORM_IDS.filter((i) => html.includes(`id="${i}"`)).length
  };
}
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const decode = (s) => s.replace(/&mdash;/g, '—').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function main() {
  const write = process.argv.includes('--write');
  const html = readFileSync(INDEX, 'utf8');
  const before = counts(html);

  let docs;
  try {
    const res = await fetch(URL);
    if (!res.ok) throw new Error('HTTP ' + res.status + (res.status === 403 ? ' — is the public-read rule for packages deployed?' : ''));
    docs = (await res.json()).documents || [];
  } catch (e) {
    console.error('could not read her packages:', e.message);
    return 1;
  }
  const byId = {};
  for (const d of docs) byId[d.name.split('/').pop()] = fields(d.fields || {});

  const changes = [];
  let out = html;

  // Price lines under each package.
  out = out.replace(/(<(\w+)[^>]*\bdata-price-pkg="([^"]+)"[^>]*>)([\s\S]*?)(<\/\2>)/g,
    (all, open, tag, id, inner, close) => {
      const text = sitePriceText(byId[id]);
      if (!text || decode(inner) === text) return all;
      changes.push(`${id}: "${decode(inner)}" -> "${text}"`);
      return open + escapeHtml(text) + close;
    });

  // The inquiry dropdown: keep its first option ("Not sure yet"), rebuild the rest.
  const list = usablePackages(Object.values(byId));
  out = out.replace(/(<select[^>]*\bdata-price-options\b[^>]*>)([\s\S]*?)(\s*<\/select>)/,
    (all, open, inner, close) => {
      const opts = [...inner.matchAll(/<option[^>]*>([\s\S]*?)<\/option>/g)];
      if (!opts.length || !list.length) return all;
      const indent = (inner.match(/\n([ \t]*)<option/) || [, '            '])[1];
      const wanted = [decode(opts[0][1])].concat(list.map(inquiryOptionText));
      const current = opts.map((m) => decode(m[1]));
      if (JSON.stringify(current) === JSON.stringify(wanted)) return all;
      changes.push('inquiry dropdown:\n      was: ' + current.slice(1).join(' | ') + '\n      now: ' + wanted.slice(1).join(' | '));
      return open + wanted.map((t) => `\n${indent}<option>${escapeHtml(t)}</option>`).join('') + close;
    });

  const after = counts(out);
  if (after.markers !== before.markers || after.ids !== FORM_IDS.length) {
    console.error(`REFUSING TO WRITE — the edit would damage index.html (${after.markers} markers, ${after.ids}/${FORM_IDS.length} form ids)`);
    return 1;
  }
  if (!changes.length) {
    console.log('built-in prices already match her package list. Nothing to do.');
    return 0;
  }
  console.log(`${changes.length} change(s):\n\n  ` + changes.join('\n  ') + '\n');
  if (!write) {
    console.log('Nothing written. Re-run with --write to apply.');
    return 0;
  }
  writeFileSync(INDEX, out);
  console.log(`index.html updated. ${after.markers} markers and ${after.ids}/${FORM_IDS.length} form ids intact.\nRun ./bin/stamp-version.sh before committing.`);
  return 0;
}

process.exitCode = await main();
