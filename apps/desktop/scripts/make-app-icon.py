from PIL import Image
from pathlib import Path

src = Path(r"c:\Project YX\apps\desktop\public\logo.png")
out = Path(r"c:\Project YX\apps\desktop\src-tauri\app-icon-source.png")

im = Image.open(src).convert("RGBA")
w, h = im.size
size = max(w, h, 1024)
scale = (size * 0.88) / max(w, h)
nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
im = im.resize((nw, nh), Image.Resampling.LANCZOS)

canvas = Image.new("RGBA", (size, size), (0, 0, 0, 255))
canvas.paste(im, ((size - nw) // 2, (size - nh) // 2), im)
canvas.save(out)
print(f"wrote {out} {size}x{size} from {w}x{h}")
