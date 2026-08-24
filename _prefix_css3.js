const fs = require('fs');

let css = fs.readFileSync('D:\\Desktop\\GOD-main\\server god\\disign god list\\sheet.css', 'utf-8');

// Step 1: Remove CSS comments
const comments = [];
css = css.replace(/\/\*[\s\S]*?\*\//g, (match) => {
  comments.push(match);
  return '';
});

// Step 2: Extract @keyframes and @media blocks
const atRules = [];
const atRegex = /@(?:keyframes|media|supports)\s+[^{]+\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
let atMatch;
while ((atMatch = atRegex.exec(css)) !== null) {
  atRules.push(atMatch[0]);
}
css = css.replace(atRegex, '');

// Step 3: Extract :root block
const rootMatch = css.match(/:root\s*\{[^{}]*\}/);
const rootBlock = rootMatch ? rootMatch[0].replace(':root', '.god-tactical') : '.god-tactical {}';
css = css.replace(/:root\s*\{[^{}]*\}/, '');

// Step 4: Extract [data-theme="light"] block
const lightMatch = css.match(/\[data-theme="light"\]\s*\{[^{}]*\}/);
const lightBlock = lightMatch ? lightMatch[0].replace('[data-theme="light"]', '.god-tactical[data-theme="light"]') : '';
css = css.replace(/\[data-theme="light"\]\s*\{[^{}]*\}/, '');

// Step 5: Remove body/html/* blocks
css = css.replace(/html,\s*body\s*\{[^{}]*\}/, '');
css = css.replace(/\*\s*\{\s*box-sizing:\s*border-box;\s*\}/, '');
css = css.replace(/body\s*\{[^{}]*\}/, '');
css = css.replace(/\[data-theme="light"\]\s*body\s*\{[^{}]*\}/, '');

// Step 6: Parse remaining top-level blocks
const blocks = [];
const blockRegex = /([^{]+)\{([^{}]*)\}/g;
let m;
while ((m = blockRegex.exec(css)) !== null) {
  const selector = m[1].trim();
  const body = m[2];
  if (!selector) continue;
  const prefixedSelectors = selector.split(',').map(s => '.god-tactical ' + s.trim()).join(', ');
  blocks.push(`${prefixedSelectors} {${body}}`);
}

// Step 7: Assemble
const header = `@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap');\n\n`;

let output = header + rootBlock + '\n\n';
if (lightBlock) output += lightBlock + '\n\n';
output += blocks.join('\n\n') + '\n\n';
output += atRules.join('\n\n') + '\n';

// Add back compatibility styles for old components (roll dialog, chat, dice tray)
// We'll append these later manually or keep them in a separate section

fs.writeFileSync('D:\\Desktop\\GOD-main\\server god\\god-tactical\\styles\\god-tactical.css', output, 'utf-8');
console.log('Done, wrote', output.length, 'chars,', blocks.length, 'blocks,', atRules.length, 'at-rules');
