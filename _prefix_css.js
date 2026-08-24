const fs = require('fs');

const css = fs.readFileSync('D:\\Desktop\\GOD-main\\server god\\disign god list\\sheet.css', 'utf-8');

function prefixCss(cssText) {
  const result = [];
  let depth = 0;
  const buf = [];
  for (const ch of cssText) {
    if (ch === '{') {
      depth++;
      if (depth === 1) {
        const selector = buf.join('').trim();
        if (selector.startsWith('@')) {
          result.push(selector);
          buf.length = 0;
          result.push(ch);
          continue;
        }
        if (!selector || selector.startsWith('/*')) {
          result.push(selector);
          buf.length = 0;
          result.push(ch);
          continue;
        }
        const selectors = selector.split(',').map(s => s.trim());
        const prefixed = selectors.map(sel => {
          if (sel.startsWith(':root')) return '.god-tactical';
          if (sel.startsWith('html, body')) return '.god-tactical.sheet.actor.character .window-content';
          if (sel.startsWith('[data-theme="light"] body')) return '.god-tactical.sheet.actor.character[data-theme="light"] .window-content';
          if (sel === '*') return '.god-tactical *';
          return '.god-tactical ' + sel;
        });
        result.push(prefixed.join(', '));
        buf.length = 0;
        result.push(ch);
        continue;
      }
    } else if (ch === '}') {
      depth--;
      result.push(ch);
      buf.length = 0;
      continue;
    }
    result.push(ch);
    if (depth === 0) {
      buf.push(ch);
    }
  }
  return result.join('');
}

const prefixed = prefixCss(css);
const header = "@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap');\n\n";
fs.writeFileSync('D:\\Desktop\\GOD-main\\server god\\god-tactical\\styles\\god-tactical.css', header + prefixed, 'utf-8');
console.log('Done, wrote', (header + prefixed).length, 'chars');
