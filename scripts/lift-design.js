/* The app's stylesheet and its designed screens come out of the finalised design board,
   so the two cannot drift. Run this after changing design/final/Main.dc.html.

   A board screen is template markup. This turns each hole into a data attribute the React
   <Board> component fills in at runtime:

     onClick="{{go_signup}}"   -> data-go="go_signup"      a click handler
     class="{{s1Cls}}"         -> data-cls="s1Cls"         a class name from state
     <sc-if value="{{x}}">     -> <span data-if="x">       shown only when x is true
     {{keyState}}              -> <span data-text="keyState"></span>

   Nothing about the markup itself is retyped, so the app renders what was signed off. */

import fs from 'node:fs';
import path from 'node:path';

const board = path.resolve('design/final/Main.dc.html');
const src = fs.readFileSync(board, 'utf8');

/* The stylesheet ------------------------------------------------------------- */
const css = src.slice(src.indexOf('<style>') + 7, src.indexOf('</style>'));
if (css.includes('var(--fg)')) throw new Error('the board still uses the undefined --fg token');
fs.writeFileSync('web/src/app.css',
  `/* Lifted from ${path.relative(process.cwd(), board)} by scripts/lift-design.js.\n   Do not edit here: change the design board and run \`node scripts/lift-design.js\`. */\n${css}`);
console.log(`app.css      ${css.length} chars`);

/* The screens ---------------------------------------------------------------- */
const SCREENS = ['home', 'signin', 'signup', 'connect'];
// where each screen ends: the next sc-if on the board, not the end of the file
const ENDS = { home: 'signin', signin: 'signup', signup: 'connect', connect: 'dash' };

const blockFor = (name, next) => {
  const start = src.indexOf(`{{is_${name}}}`);
  const end = next ? src.indexOf(`<sc-if value="{{is_${next}}}`) : src.length;
  if (start < 0 || end < 0) throw new Error(`could not find the ${name} screen on the board`);
  return src.slice(src.indexOf('>', src.indexOf('hint-placeholder-val', start)) + 1, end);
};

const convert = (raw) => {
  let h = raw;
  h = h.replace(/min-height:\s*\d+px;\s*/g, '');       // the artboard frame is not a real page
  h = h.replace(/<\/sc-if>\s*$/, '');                  // the wrapper the screen's own sc-if closed
  h = h.replace(/\s*data-clickable="1"/g, '');

  h = h.replace(/\s*onClick="\{\{([a-zA-Z_0-9]+)\}\}"/g, ' data-go="$1"');
  h = h.replace(/\s*aria-label="\{\{switchLabel\}\}"/g, ' aria-label="Switch the theme"');
  h = h.replace(/\s*aria-label="\{\{[a-zA-Z_0-9]+\}\}"/g, '');

  // a class that is entirely a hole, and one that mixes fixed classes with a hole
  h = h.replace(/class="\{\{([a-zA-Z_0-9]+)\}\}"/g, 'data-cls="$1"');
  h = h.replace(/class="([^"{]*)\{\{([a-zA-Z_0-9]+)\}\}([^"]*)"/g,
    (_m, a, name, b) => `class="${(a + b).trim()}" data-cls="${name}"`);

  h = h.replace(/<sc-if value="\{\{([a-zA-Z_0-9]+)\}\}"[^>]*>/g, '<span data-if="$1">');
  h = h.replace(/<\/sc-if>/g, '</span>');

  h = h.replace(/\{\{([a-zA-Z_0-9]+)\}\}/g, '<span data-text="$1"></span>');

  // a real form needs named fields; the board only needed ids to label them
  h = h.replace(/<input\b(?![^>]*\bname=)([^>]*?)\bid="([^"]+)"([^>]*)>/g,
    (m, a2, fid, b2) => `<input${a2}id="${fid}" name="${fid}"${b2}>`);

  if (h.includes('<sc-if')) throw new Error('an sc-if survived the conversion');
  if (/\{\{/.test(h)) throw new Error(`unresolved holes: ${(h.match(/\{\{[^}]*\}\}/g) || []).join(', ')}`);
  return h.trim();
};

/* The two places the app has to do more than the board drew:
   the sign in and sign up buttons must actually submit, and a form needs somewhere to
   put the reason it was refused. */
const asForm = (h) => h
  .replace(/<button type="button" class="btn full" data-go="[^"]+">/,
    '<div class="errbox" data-if="error" data-text="error"></div><button type="submit" class="btn full">')
  .replace(/<button class="btn full" data-go="[^"]+">/,
    '<div class="errbox" data-if="error" data-text="error"></div><button type="submit" class="btn full">');

SCREENS.forEach((name, i) => {
  let html = convert(blockFor(name, ENDS[name]));
  if (name === 'signin' || name === 'signup') {
    html = asForm(html);
    if (!html.includes('type="submit"')) throw new Error(`${name} has no submit button`);
    if (!html.includes('data-if="error"')) throw new Error(`${name} has nowhere to show an error`);
  }
  fs.writeFileSync(`web/src/screens/${name}.html`, html);
  const holes = (s, re) => [...new Set([...s.matchAll(re)].map((m) => m[1]))];
  console.log(`${name.padEnd(12)} ${String(html.length).padStart(6)} chars`
    + `  go=${holes(html, /data-go="([^"]+)"/g).length}`
    + ` if=${holes(html, /data-if="([^"]+)"/g).length}`
    + ` cls=${holes(html, /data-cls="([^"]+)"/g).length}`
    + ` text=${holes(html, /data-text="([^"]+)"/g).length}`);
});
