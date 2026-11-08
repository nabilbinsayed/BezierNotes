"""Write inkwell/fixtures/forms/all_fields.pdf: one AcroForm field of every
kind BezierNotes fills (Plan 096). Raw PDF, then normalised by qpdf so the
xref is exact. Run: python3 tools/gen_form_fixture.py"""
import pathlib, subprocess, tempfile

OUT = pathlib.Path(__file__).resolve().parent.parent / "inkwell/fixtures/forms/all_fields.pdf"

objs = {}
def obj(n, body):
    objs[n] = body

def ap(n, w, h, content):
    data = content.encode()
    obj(n, f"<< /Type /XObject /Subtype /Form /BBox [0 0 {w} {h}] /Length {len(data)} >>\nstream\n".encode() + data + b"\nendstream")

obj(1, b"<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R >>")
obj(2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
annots = "10 0 R 11 0 R 12 0 R 13 0 R 15 0 R 16 0 R 17 0 R 18 0 R 19 0 R 20 0 R"
obj(3, f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [{annots}] /Contents 30 0 R /Resources << /Font << /F1 31 0 R >> >> >>".encode())
fields = "10 0 R 11 0 R 12 0 R 13 0 R 14 0 R 17 0 R 18 0 R 19 0 R 20 0 R"
obj(4, f"<< /Fields [{fields}] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 31 0 R >> >> >>".encode())
w = "/Type /Annot /Subtype /Widget /F 4 /P 3 0 R"
obj(10, f"<< {w} /FT /Tx /T (name) /Rect [100 700 400 724] /DA (/Helv 12 Tf 0 g) /V (Ada Lovelace) >>".encode())
obj(11, f"<< {w} /FT /Tx /T (notes) /Ff 4096 /Rect [100 600 400 680] /DA (/Helv 10 Tf 0 0 0.6 rg) >>".encode())
obj(12, f"<< {w} /FT /Tx /T (zip) /Ff 16777216 /MaxLen 5 /Rect [100 560 200 580] /DA (/Helv 12 Tf 0 g) >>".encode())
obj(13, f"<< {w} /FT /Btn /T (agree) /Rect [100 520 116 536] /V /Off /AS /Off /DA (/ZaDb 0 Tf 0 g) /AP << /N << /Yes 40 0 R /Off 41 0 R >> >> >>".encode())
# radio group: parent 14 with two widget kids
obj(14, b"<< /FT /Btn /T (size) /Ff 49152 /V /Off /Kids [15 0 R 16 0 R] >>")
obj(15, f"<< {w} /Parent 14 0 R /Rect [100 480 116 496] /AS /Off /AP << /N << /Small 42 0 R /Off 41 0 R >> >> >>".encode())
obj(16, f"<< {w} /Parent 14 0 R /Rect [140 480 156 496] /AS /Off /AP << /N << /Large 43 0 R /Off 41 0 R >> >> >>".encode())
obj(17, f"<< {w} /FT /Ch /T (country) /Ff 131072 /Opt [[(bd) (Bangladesh)] [(de) (Germany)] [(jp) (Japan)]] /V (de) /Rect [100 440 300 460] /DA (/Helv 11 Tf 0 g) >>".encode())
obj(18, f"<< {w} /FT /Ch /T (colour) /Opt [(Red) (Green) (Blue)] /Rect [100 360 200 420] /DA (/Helv 10 Tf 0 g) >>".encode())
obj(19, f"<< {w} /FT /Tx /T (id) /Ff 1 /V (fixed-123) /Rect [100 320 300 340] /DA (/Helv 10 Tf 0 g) >>".encode())
obj(20, f"<< {w} /FT /Tx /T (city) /Q 1 /Rect [320 320 520 340] /DA (/Helv 10 Tf 0 g) >>".encode())
content = b"BT /F1 10 Tf 20 760 Td (BezierNotes form fixture: every field kind) Tj ET"
obj(30, f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream")
obj(31, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
ap(40, 16, 16, "q 0 g 1.5 w 3 8 m 7 4 l 13 13 l S Q")
ap(41, 16, 16, "")
ap(42, 16, 16, "q 0 g 8 8 m 8 10 6 12 4 12 c 4 12 4 4 8 8 c f Q")
ap(43, 16, 16, "q 0 g 4 4 8 8 re f Q")

out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
offsets = {}
for n in sorted(objs):
    offsets[n] = len(out)
    out += f"{n} 0 obj\n".encode() + objs[n] + b"\nendobj\n"
xref = len(out)
size = max(objs) + 1
out += f"xref\n0 {size}\n0000000000 65535 f \n".encode()
for n in range(1, size):
    out += (f"{offsets[n]:010d} 00000 n \n" if n in offsets else "0000000000 65535 f \n").encode()
out += f"trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
with tempfile.NamedTemporaryFile(suffix=".pdf") as t:
    t.write(out); t.flush()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["qpdf", "--object-streams=disable", t.name, str(OUT)], check=True)
print("wrote", OUT)
