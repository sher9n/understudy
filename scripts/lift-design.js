/* The app's stylesheet and its homepage come out of the finalised design board, so the
   two cannot drift. Run this after changing design/final/Main.dc.html. */

import fs from 'node:fs';
import path from 'node:path';

const board = path.resolve('design/final/Main.dc.html');
const src = fs.readFileSync(board, 'utf8');

/* The stylesheet ------------------------------------------------------------- */
const css = src.slice(src.indexOf('<style>') + 7, src.indexOf('</style>'));
if (css.includes('var(--fg)')) throw new Error('the board still uses the undefined --fg token');
fs.writeFileSync('web/src/app.css',
  `/* Lifted from ${path.relative(process.cwd(), board)} by scripts/lift-design.js.\n   Do not edit here: change the design board and run \`node scripts/lift-design.js\`. */\n${css}`);

/* The homepage --------------------------------------------------------------- */
const start = src.indexOf('{{is_home}}');
const end = src.indexOf('<sc-if value="{{is_signin}}');
if (start < 0 || end < 0) throw new Error('could not find the home screen on the board');
let home = src.slice(src.indexOf('>', src.indexOf('hint-placeholder-val', start)) + 1, end);

// the artboard's fixed frame height is not how a real page behaves
home = home.replace(/min-height:\s*\d+px;\s*/g, '');
// close the wrapper the sc-if used to close
home = home.replace(/<\/sc-if>\s*$/, '');

// handlers become data attributes the React shell delegates on
const GO = { go_signup: 'signup', go_signin: 'signin', toggleTheme: 'theme' };
home = home.replace(/\s*onClick="\{\{([a-zA-Z_]+)\}\}"/g, (_m, name) =>
  (GO[name] ? ` data-go="${GO[name]}"` : ''));
home = home.replace(/\s*aria-label="\{\{switchLabel\}\}"/g, ' aria-label="Switch the theme"');
home = home.replace(/\s*data-clickable="1"/g, '');

// the theme icons: keep both, and let CSS show the one that belongs to the current mode
home = home.replace(/<sc-if value="\{\{dark\}\}"[^>]*>/g, '<span data-when="dark">')
  .replace(/<sc-if value="\{\{light\}\}"[^>]*>/g, '<span data-when="light">');
let depth = 0;
home = home.replace(/<sc-if[^>]*>|<\/sc-if>/g, (m) => {
  if (m.startsWith('</')) return depth-- > 0 ? '</span>' : '';
  depth += 1;
  return '<span>';
});

const left = home.match(/\{\{[a-zA-Z_]+\}\}/g);
if (left) throw new Error(`unresolved template holes in the homepage: ${[...new Set(left)].join(', ')}`);
if (home.includes('<sc-if')) throw new Error('an sc-if survived the conversion');

fs.writeFileSync('web/src/home.html', home.trim());
console.log(`app.css   ${css.length} chars`);
console.log(`home.html ${home.trim().length} chars, ${(home.match(/data-go="/g) || []).length} wired links`);
