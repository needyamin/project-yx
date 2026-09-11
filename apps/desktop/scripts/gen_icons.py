import struct
import zlib
from pathlib import Path


def write_png(path: Path, w: int, h: int, rgb=(61, 214, 198)) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            f = (x + y) / (w + h)
            row.extend(
                [
                    min(255, int(rgb[0] * (0.7 + 0.3 * f))),
                    min(255, int(rgb[1] * (0.7 + 0.3 * f))),
                    min(255, int(rgb[2] * (0.7 + 0.3 * f))),
                ]
            )
        rows.append(bytes(row))
    raw = b"".join(rows)
    data = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(data)


def bmp_dib(w: int, h: int, rgb=(61, 214, 198)) -> bytes:
    pixels = bytearray()
    for _y in range(h - 1, -1, -1):
        for _x in range(w):
            pixels.extend([rgb[2], rgb[1], rgb[0], 255])
    mask_row = ((w + 31) // 32) * 4
    mask = bytes(mask_row * h)
    header = struct.pack("<IIIHHIIIIII", 40, w, h * 2, 1, 32, 0, len(pixels), 0, 0, 0, 0)
    return header + pixels + mask


def write_ico(path: Path, size: int = 32, rgb=(61, 214, 198)) -> None:
    dib = bmp_dib(size, size, rgb)
    data = struct.pack("<HHH", 0, 1, 1)
    data += struct.pack(
        "<BBBBHHII",
        size if size < 256 else 0,
        size if size < 256 else 0,
        0,
        0,
        1,
        32,
        len(dib),
        22,
    )
    data += dib
    path.write_bytes(data)


def main() -> None:
    root = Path(r"c:\Project YX\apps\desktop\src-tauri\icons")
    root.mkdir(parents=True, exist_ok=True)
    write_png(root / "32x32.png", 32, 32)
    write_png(root / "128x128.png", 128, 128)
    write_png(root / "128x128@2x.png", 256, 256)
    write_png(root / "icon.png", 512, 512)
    write_ico(root / "icon.ico", 32)
    # Minimal placeholder; macOS bundling can regenerate later.
    (root / "icon.icns").write_bytes(b"icns" + struct.pack(">I", 8))
    print("ok", (root / "icon.png").stat().st_size, (root / "icon.ico").stat().st_size)


if __name__ == "__main__":
    main()
