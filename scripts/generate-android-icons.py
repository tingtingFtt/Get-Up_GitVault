"""Regenerate committed Android icons from the outlined header mark (Inkscape required)."""
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / 'android/app/src/main/res'
SOURCE = ROOT / 'assets/gitvault-icon.svg'
SVG = '{http://www.w3.org/2000/svg}'
paths = ET.parse(SOURCE).getroot().find(f'{SVG}g').findall(f'{SVG}path')
letters = '\n'.join(f'    <path android:fillColor="#FFFFFF" android:pathData="{path.attrib["d"]}" />' for path in paths)
foreground = f'''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
{letters}
</vector>
'''
(RES / 'drawable/gitvault_launcher_foreground.xml').write_text(foreground)
(RES / 'drawable/gitvault_launcher_background.xml').write_text('''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" xmlns:aapt="http://schemas.android.com/aapt" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
    <path android:pathData="M0,0H108V108H0Z">
        <aapt:attr name="android:fillColor">
            <gradient android:startX="0" android:startY="108" android:endX="108" android:endY="0" android:type="linear">
                <item android:color="#8E9F8B" android:offset="0" />
                <item android:color="#A3B4A0" android:offset="0.5" />
                <item android:color="#C7A39B" android:offset="1" />
            </gradient>
        </aapt:attr>
    </path>
</vector>
''')
adaptive = '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/gitvault_launcher_background" />
    <foreground android:drawable="@drawable/gitvault_launcher_foreground" />
</adaptive-icon>
'''
for name in ['ic_launcher', 'ic_launcher_round']:
    (RES / f'mipmap-anydpi-v26/{name}.xml').write_text(adaptive)
for density, size in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
    for name in ['ic_launcher', 'ic_launcher_round']:
        subprocess.run(['inkscape', str(SOURCE), '--export-type=png', f'--export-width={size}', f'--export-filename={RES / f"mipmap-{density}/{name}.png"}'], check=True)
