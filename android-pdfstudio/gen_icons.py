# Re-creates the launcher icons from pdfstudio/build/icon.png (needs Pillow). Run from android-pdfstudio/.
import math, os
from PIL import Image, ImageDraw
res = 'app/src/main/res'
src = Image.open('../pdfstudio/build/icon.png').convert('RGBA')
for d, px in [('mdpi',48),('hdpi',72),('xhdpi',96),('xxhdpi',144),('xxxhdpi',192)]:
    os.makedirs(f'{res}/mipmap-{d}', exist_ok=True)
    src.resize((px,px), Image.LANCZOS).save(f'{res}/mipmap-{d}/ic_launcher.png')
    src.resize((px,px), Image.LANCZOS).save(f'{res}/mipmap-{d}/ic_launcher_round.png')
# adaptive foreground: white page + purple P, drawn from icon.svg, inside the 66dp safe zone of 108dp
S = 432*4; k = 66/108*S/64; c = S/2
def P(x,y): return (c+(x-32)*k, c+(y-32)*k)
im = Image.new('RGBA',(S,S),(0,0,0,0)); d = ImageDraw.Draw(im)
d.polygon([P(19,12),P(36,12),P(47,23),P(47,52),P(44,55),P(19,55),P(16,52),P(16,15)], fill=(255,255,255,242))
d.polygon([P(36,12),P(47,23),P(39,23),P(36,20)], fill=(201,191,255,255))
pts=[P(24,46),P(24,29),P(32.5,29)]
for i in range(0,181,10):
    a=math.radians(-90+i); pts.append(P(32.5+5.2*math.sin(math.radians(i)), 34.2-5.2*math.cos(math.radians(i))))
pts += [P(24,39.4)]
w=int(3.6*k)
d.line(pts, fill=(91,61,240,255), width=w, joint='curve')
for p in (pts[0],pts[-1]):
    d.ellipse([p[0]-w/2,p[1]-w/2,p[0]+w/2,p[1]+w/2], fill=(91,61,240,255))
im.resize((432,432), Image.LANCZOS).save(f'{res}/drawable-nodpi/ic_launcher_foreground.png')
