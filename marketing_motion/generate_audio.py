import wave, struct, math, random

SAMPLE_RATE = 44100
DURATION = 34.0
TOTAL_SAMPLES = int(SAMPLE_RATE * DURATION)

# Audio buffers (left, right)
buffer_l = [0.0] * TOTAL_SAMPLES
buffer_r = [0.0] * TOTAL_SAMPLES

def add_tone(freq, start_t, dur, amp, decay=0.0, pan=0.0):
    start_idx = int(start_t * SAMPLE_RATE)
    num_samples = int(dur * SAMPLE_RATE)
    for i in range(num_samples):
        idx = start_idx + i
        if idx >= TOTAL_SAMPLES:
            break
        t = i / SAMPLE_RATE
        env = math.exp(-decay * t) if decay > 0 else 1.0
        # Gentle attack
        if t < 0.02:
            env *= (t / 0.02)
        val = amp * env * math.sin(2 * math.pi * freq * t)
        l_pan = 0.5 * (1.0 - pan)
        r_pan = 0.5 * (1.0 + pan)
        buffer_l[idx] += val * l_pan
        buffer_r[idx] += val * r_pan

def add_chord(freqs, start_t, dur, amp, pan_spread=0.3):
    n = len(freqs)
    for idx, f in enumerate(freqs):
        pan = -pan_spread + (2 * pan_spread * idx / max(1, n - 1))
        add_tone(f, start_t, dur, amp / n, decay=0.3, pan=pan)

def add_impact(start_t, amp=0.9):
    start_idx = int(start_t * SAMPLE_RATE)
    num_samples = int(0.9 * SAMPLE_RATE)
    for i in range(num_samples):
        idx = start_idx + i
        if idx >= TOTAL_SAMPLES:
            break
        t = i / SAMPLE_RATE
        freq = 35.0 + 130.0 * math.exp(-22.0 * t)
        env = amp * math.exp(-6.5 * t)
        val = env * math.sin(2 * math.pi * freq * t)
        buffer_l[idx] += val * 0.7
        buffer_r[idx] += val * 0.7

def add_riser(start_t, dur=1.2, amp=0.4):
    start_idx = int(start_t * SAMPLE_RATE)
    num_samples = int(dur * SAMPLE_RATE)
    phase = 0.0
    for i in range(num_samples):
        idx = start_idx + i
        if idx >= TOTAL_SAMPLES:
            break
        t = i / SAMPLE_RATE
        progress = t / dur
        freq = 250.0 + 1800.0 * (progress ** 2.2)
        phase += 2 * math.pi * freq / SAMPLE_RATE
        env = amp * (progress ** 1.8)
        # Noise swirl + sine
        noise = (random.random() * 2 - 1) * 0.3
        val = env * (math.sin(phase) + noise)
        buffer_l[idx] += val * 0.6
        buffer_r[idx] += val * 0.6

def add_click(start_t, freq=1400, amp=0.35):
    add_tone(freq, start_t, 0.05, amp, decay=60.0)

# 1. Rhythmic Sub-Bass Pulse (120 BPM => beat every 0.5s)
for beat in range(int(DURATION * 2)):
    t = beat * 0.5
    f = 55.0 if (beat % 8) < 6 else 48.99  # A1 to G1 chord changes
    decay = 12.0
    amp = 0.38 if (beat % 2 == 0) else 0.22
    add_tone(f, t, 0.45, amp, decay=decay, pan=0.0)
    # Add octave harmonic
    add_tone(f * 2, t, 0.3, amp * 0.3, decay=18.0, pan=0.0)

# 2. Ambient Cyber Pad Progression
# Chords: Am -> F -> C -> G
chords = [
    ([220.0, 261.63, 329.63, 440.0], 0.0, 4.5),     # Am
    ([174.61, 220.0, 261.63, 349.23], 4.5, 4.5),   # F
    ([261.63, 329.63, 392.0, 523.25], 9.0, 5.5),   # C
    ([196.0, 246.94, 293.66, 392.0], 14.5, 6.0),   # G
    ([220.0, 261.63, 329.63, 523.25], 20.5, 5.0),  # Am9
    ([174.61, 220.0, 261.63, 349.23], 25.5, 4.0),  # F
    ([220.0, 277.18, 329.63, 440.0, 554.37], 29.5, 4.5), # A maj victory
]
for chord, st, dur in chords:
    add_chord(chord, st, dur, amp=0.28)

# 3. Cinematic Scene Impacts & Drops
scene_moments = [0.0, 4.5, 9.0, 14.5, 20.5, 25.5, 29.5]
for sm in scene_moments:
    add_impact(sm, amp=0.75 if sm > 0 else 0.5)

# 4. Risers leading into transitions
for sm in scene_moments[1:]:
    add_riser(sm - 1.1, dur=1.1, amp=0.25)

# 5. UI Clicks & High-Tech Chimes
ui_clicks = [4.5, 4.65, 9.0, 9.15, 14.5, 15.2, 16.0, 17.0, 18.2, 20.5, 21.0, 25.5, 25.75, 26.0, 29.5]
for uc in ui_clicks:
    add_click(uc, freq=random.choice([1200, 1500, 1800]), amp=0.25)

# 6. Stylus Friction texture (14.6s to 19.8s)
st_idx = int(14.6 * SAMPLE_RATE)
end_idx = int(19.8 * SAMPLE_RATE)
for i in range(st_idx, end_idx):
    if i < TOTAL_SAMPLES:
        t = i / SAMPLE_RATE
        scribble = (random.random() * 2 - 1) * 0.04 * (0.6 + 0.4 * math.sin(2 * math.pi * 14 * t))
        buffer_l[i] += scribble
        buffer_r[i] += scribble

# 7. Final Grand Finale Chime Arpeggio (29.5s to 33.5s)
final_notes = [523.25, 659.25, 783.99, 1046.5, 1318.5]
for idx, fn in enumerate(final_notes):
    add_tone(fn, 29.5 + idx * 0.15, 3.5, 0.22, decay=1.2, pan=(idx - 2) * 0.2)

# Master Normalization & Fade Out
max_peak = max(max(abs(x) for x in buffer_l), max(abs(x) for x in buffer_r), 0.001)
target_peak = 0.92
scale = target_peak / max_peak

out_wav = wave.open("marketing_motion/soundtrack.wav", "wb")
out_wav.setnchannels(2)
out_wav.setsampwidth(2)
out_wav.setframerate(SAMPLE_RATE)

frames = bytearray()
for i in range(TOTAL_SAMPLES):
    t = i / SAMPLE_RATE
    # Fade out at the end
    fade = 1.0
    if t > 32.5:
        fade = max(0.0, (34.0 - t) / 1.5)
    
    sl = int(max(-1.0, min(1.0, buffer_l[i] * scale * fade)) * 32767)
    sr = int(max(-1.0, min(1.0, buffer_r[i] * scale * fade)) * 32767)
    frames += struct.pack('<hh', sl, sr)

out_wav.writeframes(frames)
out_wav.close()
print(f"Generated soundtrack ({DURATION}s, 44.1kHz stereo): marketing_motion/soundtrack.wav")
