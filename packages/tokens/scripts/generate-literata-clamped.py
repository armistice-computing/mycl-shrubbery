"""Generate packages/tokens/css/literata-clamped.css.

Cloud-1's Literata comes from Google Fonts with weights 400/500/600 requested,
so the served face declares `font-weight: 400 600` and every `font-weight: 700`
in the app silently renders at 600. Reproducing that by editing call sites would
mean touching 87 uses of 700, 107 of 650 and 15 of 800 — and would wrongly drag
Source Sans 3 down with it, which in cloud-1 keeps a real 700. Clamping the FACE
does it in one place and keeps working for call sites nobody has written yet.

Regenerate after bumping @fontsource-variable/literata:

    python3 packages/tokens/scripts/generate-literata-clamped.py

and update PKG's version directory + `version` below to match. The generated
file is committed so a build never depends on this script running.
"""
import re, pathlib

REPO = pathlib.Path(__file__).resolve().parents[3]
PKG = (REPO / 'node_modules/.pnpm/'
       '@fontsource-variable+literata@5.2.8/node_modules/@fontsource-variable/literata')
OUT = REPO / 'packages/tokens/css/literata-clamped.css'

header = """/* literata-clamped.css — GENERATED. Do not hand-edit; see the note below.
 *
 * Literata, declared `font-weight: 400 600` instead of fontsource's `200 900`.
 *
 * WHY. A variable font is clamped to the range its @font-face declares. Cloud-1
 * loads Literata from Google Fonts having asked for weights 400, 500 and 600, so
 * the served face declares `400 600` and every `font-weight: 700` in that app
 * renders at 600 — nobody chose that, it fell out of the fonts URL. Eschaton
 * compared the two apps side by side and preferred it: "I like the slightly
 * lighter bold, it's cleaner for a notes app." Measured difference at a true
 * 700 vs a clamped 600, same file, same size: +14% ink and ~13px wider per line
 * at 32px. Weights 400-600 are identical to the pixel, which is why only bold
 * looked wrong. (apps/organism/scripts/type-weight-parity-probe.mts)
 *
 * WHY HERE AND NOT AT THE CALL SITES. The app has 87 uses of `font-weight: 700`,
 * 107 of 650 and 15 of 800. Rewriting them would be a large mechanical edit that
 * misses every call site written after it — and it would drag Source Sans 3 down
 * too, which in cloud-1 keeps a real 700 because its own fonts URL asked for one.
 * Clamping the face puts the rule where the fact lives: THIS FAMILY stops at 600.
 *
 * The `src` files are fontsource's own, untouched — only the declared range
 * differs. Regenerated from @fontsource-variable/literata@VERSION by the script in
 * the commit that introduced this file.
 */

"""

version = '5.2.8'
blocks = []
for name in ('standard.css', 'standard-italic.css'):
    css = (PKG / name).read_text()
    css = css.replace('./files/', '@fontsource-variable/literata/files/')
    css = re.sub(r'font-weight:\s*200\s+900;', 'font-weight: 400 600;', css)
    assert 'font-weight: 400 600;' in css, f'{name}: range not rewritten'
    assert '200 900' not in css, f'{name}: a 200 900 survived'
    blocks.append(f'/* --- from {name} --- */\n{css.strip()}\n')

OUT.write_text(header.replace('VERSION', version) + '\n'.join(blocks))
print(f'wrote {OUT} ({OUT.read_text().count("@font-face")} faces)')
