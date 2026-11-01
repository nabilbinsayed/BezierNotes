import json

with open('inkwell-capture.json') as f:
    data = json.load(f)

# Extract stroke 0 and stroke 4, downsampling to ~800 smooth points
extracted = []
for stroke_idx in [0, 4]:
    s = data['strokes'][stroke_idx]
    raw_samples = s['samples']
    # Step by 3 or 4 to get smooth points
    step = 4
    sub = []
    for pt in raw_samples[::step]:
        sub.append({
            'x': round(pt[0], 1),
            'y': round(pt[1], 1),
            'p': round(pt[2], 3)
        })
    extracted.append({
        'kind': s.get('kind', 'pen'),
        'color': '#24c8d8' if stroke_idx == 0 else '#818cf8',
        'points': sub
    })

with open('marketing_motion/strokes.json', 'w') as f:
    json.dump(extracted, f)

print(f"Extracted {len(extracted)} strokes with {[len(s['points']) for s in extracted]} points.")
