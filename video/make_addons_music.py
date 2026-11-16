"""Musique générée pour la bande-annonce des add-ons médiévaux (90 s).

Usage : python3 video/make_addons_music.py <sortie.wav>

Ré mineur, pincées de luth sur une mélodie simple, nappe grave, frappes de marteau
aux coups de la forge (video/addons-trailer.html, HITS) et sifflement de vapeur
à la trempe (STEAM_T). Ce n'est pas un orchestre : les sons sont synthétisés.
"""
import math
import random
import struct
import sys
import wave

SR = 44100
DUR = 90.0
N = int(SR * DUR)
BEAT = 60.0 / 96
HITS = [20.0, 20.6, 21.2, 21.8, 22.4, 23.0, 23.6, 24.2]
STEAM_T = [26.0, 26.5, 27.0, 27.5, 28.0]

D3, F3, A3, C4, D4, E4, F4, G4, A4, C5, D5 = 146.83, 174.61, 220.0, 261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 523.25, 587.33
# Ré mineur : Dm – Bb – F – C
CHORDS = [(D3, F3, A3), (116.54, D4 / 2 * 1.0, F4 / 2 * 1.0), (F3, A3, C4), (130.81, E4 / 2, G4 / 2)]
MELODY = [D4, F4, A4, G4, F4, D4, E4, C4, D4, A3, C4, D4]

random.seed(5)
buf = [0.0] * N


def add(start, dur, fn):
    i0 = int(start * SR)
    for k in range(int(dur * SR)):
        i = i0 + k
        if 0 <= i < N:
            buf[i] += fn(k / SR)


def pluck(freq, vol):
    def f(t):
        s = math.sin(2 * math.pi * freq * t) + 0.3 * math.sin(4 * math.pi * freq * t)
        return s * math.exp(-t / 0.35) * vol
    return f


def pad(chord, vol):
    def f(t):
        env = min(1.0, t / 0.8) * max(0.0, 1 - max(0.0, t - 3.0) / 1.0)
        s = sum(math.sin(2 * math.pi * fr * t) for fr in chord) / len(chord)
        return s * env * vol
    return f


def hammer_hit():
    def f(t):
        return (random.uniform(-1, 1) * math.exp(-t / 0.02) * 0.5
                + math.sin(2 * math.pi * 180 * t) * math.exp(-t / 0.05) * 0.4)
    return f


def steam():
    def f(t):
        return random.uniform(-1, 1) * math.exp(-t / 0.5) * 0.06
    return f


# Nappe de fond et accords (une mesure = 4 temps, 4 mesures = 1 cycle)
t = 0.0
i = 0
while t < DUR - 1:
    add(t, 4 * BEAT + 0.5, pad(CHORDS[i % 4], 0.07))
    i += 1
    t += 4 * BEAT

# Pincées de luth : une note par temps, à partir de 5 s
t = 5.0
k = 0
while t < DUR - 2:
    add(t, 0.9, pluck(MELODY[k % len(MELODY)] / 2, 0.22))
    k += 1
    t += BEAT

# Frappes de marteau et vapeur
for h in HITS:
    add(h, 0.1, hammer_hit())
for s in STEAM_T:
    add(s, 1.2, steam())

# Fondus d'entrée et de sortie
for i in range(N):
    tt = i / SR
    g = min(1.0, tt / 1.5)
    if tt > DUR - 3:
        g *= max(0.0, (DUR - tt) / 3)
    buf[i] *= g

peak = max(1e-9, max(abs(x) for x in buf))
scale = 0.8 / peak
out = sys.argv[1] if len(sys.argv) > 1 else "addons-music.wav"
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    frames = bytearray()
    for x in buf:
        v = int(max(-1.0, min(1.0, x * scale)) * 32767)
        frames += struct.pack("<hh", v, v)
    w.writeframes(bytes(frames))
print("WAV écrit :", out)
