/**
 * Musical scale key signatures for pitch snap feature.
 * Each entry: [keyName, localizedLabelKey]
 */
export const SCALE_KEYS = [
    "C",
    "Db",
    "D",
    "Eb",
    "E",
    "F",
    "Gb",
    "G",
    "Ab",
    "A",
    "Bb",
    "B",
] as const;

export type ScaleKey = (typeof SCALE_KEYS)[number];

/**
 * i18n label keys for each scale (major/minor pair).
 * e.g. "C" => "C / Am"
 */
export const SCALE_LABELS: Record<ScaleKey, string> = {
    C: "C / Am",
    Db: "D\u266D / B\u266Dm",
    D: "D / Bm",
    Eb: "E\u266D / Cm",
    E: "E / C\u266Fm",
    F: "F / Dm",
    Gb: "G\u266D / E\u266Dm",
    G: "G / Em",
    Ab: "A\u266D / Fm",
    A: "A / F\u266Fm",
    Bb: "B\u266D / Gm",
    B: "B / G\u266Fm",
};

/**
 * MIDI note numbers in one octave that belong to each major scale.
 * 0 = C, 1 = C#/Db, ... 11 = B
 */
export const SCALE_NOTES: Record<ScaleKey, number[]> = {
    C:  [0, 2, 4, 5, 7, 9, 11],
    Db: [1, 3, 5, 6, 8, 10, 0],
    D:  [2, 4, 6, 7, 9, 11, 1],
    Eb: [3, 5, 7, 8, 10, 0, 2],
    E:  [4, 6, 8, 9, 11, 1, 3],
    F:  [5, 7, 9, 10, 0, 2, 4],
    Gb: [6, 8, 10, 11, 1, 3, 5],
    G:  [7, 9, 11, 0, 2, 4, 6],
    Ab: [8, 10, 0, 1, 3, 5, 7],
    A:  [9, 11, 1, 2, 4, 6, 8],
    Bb: [10, 0, 2, 3, 5, 7, 9],
    B:  [11, 1, 3, 4, 6, 8, 10],
};

/**
 * Snap a MIDI note number to the nearest note in the given scale.
 */
export function snapToScale(midiNote: number, scale: ScaleKey): number {
    const notes = SCALE_NOTES[scale];
    // const pitchClass = ((midiNote % 12) + 12) % 12; // 已删除未使用变量
    const octave = Math.floor(midiNote / 12);

    let bestDist = Infinity;
    let bestNote = midiNote;
    for (const n of notes) {
        // Check same octave and adjacent octaves
        for (const oct of [octave - 1, octave, octave + 1]) {
            const candidate = oct * 12 + n;
            const dist = Math.abs(candidate - midiNote);
            if (dist < bestDist) {
                bestDist = dist;
                bestNote = candidate;
            }
        }
    }
    return bestNote;
}

/**
 * Snap a MIDI note to the nearest semitone (round to integer).
 */
export function snapToSemitone(midiNote: number): number {
    return Math.round(midiNote);
}
