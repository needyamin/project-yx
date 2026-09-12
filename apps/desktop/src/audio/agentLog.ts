/** Voice helpers shared by Advanced Audio. */

export type VoicePreset = "male" | "female" | "child" | "custom";

export const VOICE_PRESETS: {
  id: VoicePreset;
  label: string;
  semitones: number;
}[] = [
  { id: "male", label: "Male", semitones: -4 },
  { id: "female", label: "Female", semitones: 4 },
  { id: "child", label: "Child", semitones: 7 },
  { id: "custom", label: "Custom", semitones: 0 },
];

export function presetFromSemitones(st: number): VoicePreset {
  const hit = VOICE_PRESETS.find(
    (p) => p.id !== "custom" && Math.abs(p.semitones - st) < 0.05,
  );
  return hit?.id ?? "custom";
}

export function pitchRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}
