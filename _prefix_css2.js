const fs = require('fs');

let css = fs.readFileSync('D:\\Desktop\\GOD-main\\server god\\disign god list\\sheet.css', 'utf-8');

// Step 1: Remove CSS comments
while (true) {
  const start = css.indexOf('/*');
  if (start === -1) break;
  const end = css.indexOf('*/', start);
  if (end === -1) break;
  css = css.slice(0, start) + css.slice(end + 2);
}

// Step 2: Remove specific blocks entirely
function removeBlock(selectorPattern) {
  const regex = new RegExp(selectorPattern + '\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}', 'g');
  css = css.replace(regex, '');
}

// Remove html,body and body and * box-sizing blocks
// We do this by finding the block start and tracking brace depth
function removeBlockBySelector(selector) {
  let idx = css.indexOf(selector);
  while (idx !== -1) {
    // Make sure it's actually a selector start (preceded by whitespace or start)
    const before = idx > 0 ? css[idx - 1] : '';
    if (!/\s/.test(before) && before !== '') {
      idx = css.indexOf(selector, idx + 1);
      continue;
    }
    const start = css.indexOf('{', idx);
    if (start === -1) break;
    let depth = 1;
    let end = start + 1;
    while (end < css.length && depth > 0) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}') depth--;
      end++;
    }
    css = css.slice(0, idx) + css.slice(end);
    idx = css.indexOf(selector);
  }
}

removeBlockBySelector('html, body');
removeBlockBySelector('body');
removeBlockBySelector('* { box-sizing');
removeBlockBySelector('[data-theme="light"] body');

// Step 3: Replace :root with .god-tactical
css = css.replace(/:root\s*\{/g, '.god-tactical {');

// Step 4: Prefix all top-level selectors using brace-depth parser
function prefixTopLevel(cssText) {
  const result = [];
  let depth = 0;
  let buf = [];
  for (let i = 0; i < cssText.length; i++) {
    const ch = cssText[i];
    if (ch === '{') {
      depth++;
      if (depth === 1) {
        const selector = buf.join('').trim();
        if (selector.startsWith('@')) {
          result.push(selector);
          buf = [];
          result.push(ch);
          continue;
        }
        if (!selector) {
          result.push(ch);
          buf = [];
          continue;
        }
        const selectors = selector.split(',').map(s => s.trim());
        const prefixed = selectors.map(sel => '.god-tactical ' + sel);
        result.push(prefixed.join(', '));
        buf = [];
        result.push(ch);
        continue;
      }
    } else if (ch === '}') {
      depth--;
      result.push(ch);
      buf = [];
      continue;
    }
    result.push(ch);
    if (depth === 0) {
      buf.push(ch);
    }
  }
  return result.join('');
}

let prefixed = prefixTopLevel(css);

// Step 5: Clean up multiple blank lines
prefixed = prefixed.replace(/\n\s*\n\s*\n/g, '\n\n');

const header = `@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap');\n\n`;

fs.writeFileSync('D:\\Desktop\\GOD-main\\server god\\god-tactical\\styles\\god-tactical.css', header + prefixed, 'utf-8');
console.log('Done, wrote', (header + prefixed).length, 'chars');
