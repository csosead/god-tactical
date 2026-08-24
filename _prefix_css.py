import re

with open(r'D:\Desktop\GOD-main\server god\disign god list\sheet.css', 'r', encoding='utf-8') as f:
    css = f.read()

def prefix_css(css_text):
    result = []
    depth = 0
    buf = []
    for ch in css_text:
        if ch == '{':
            depth += 1
            if depth == 1:
                selector = ''.join(buf).strip()
                if selector.startswith('@'):
                    result.append(selector)
                    buf = []
                    result.append(ch)
                    continue
                if not selector or selector.startswith('/*'):
                    result.append(selector)
                    buf = []
                    result.append(ch)
                    continue
                selectors = [s.strip() for s in selector.split(',')]
                prefixed = []
                for sel in selectors:
                    if sel.startswith(':root'):
                        prefixed.append('.god-tactical')
                    elif sel.startswith('html, body'):
                        prefixed.append('.god-tactical.sheet.actor.character .window-content')
                    elif sel.startswith('[data-theme="light"] body'):
                        prefixed.append('.god-tactical.sheet.actor.character[data-theme="light"] .window-content')
                    elif sel == '*':
                        prefixed.append('.god-tactical *')
                    else:
                        prefixed.append('.god-tactical ' + sel)
                result.append(', '.join(prefixed))
                buf = []
                result.append(ch)
                continue
        elif ch == '}':
            depth -= 1
            result.append(ch)
            buf = []
            continue
        result.append(ch)
        if depth == 0:
            buf.append(ch)
    return ''.join(result)

prefixed = prefix_css(css)

header = """@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap');

"""

with open(r'D:\Desktop\GOD-main\server god\god-tactical\styles\god-tactical.css', 'w', encoding='utf-8') as f:
    f.write(header + prefixed)

print('Done, wrote', len(header + prefixed), 'chars')
