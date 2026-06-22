export type CrossSoundName = "hop" | "splat" | "splash" | "win" | "room-join" | "click";

const FILES: Record<CrossSoundName, string> = {
  hop: "/sounds/hop.mp3",
  splat: "/sounds/splat.mp3",
  splash: "/sounds/splash.mp3",
  win: "/sounds/win.mp3",
  "room-join": "/sounds/room-join.mp3",
  click: "/sounds/click.mp3",
};

/** Plays the ported game sounds. Silent on missing files, blocked autoplay, or non-browser env. */
export class CrossSounds {
  private cache = new Map<CrossSoundName, HTMLAudioElement>();
  private muted = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  play(name: CrossSoundName): void {
    if (this.muted || typeof Audio === "undefined") return;
    try {
      let audio = this.cache.get(name);
      if (!audio) {
        audio = new Audio(FILES[name]);
        this.cache.set(name, audio);
      }
      audio.currentTime = 0;
      void audio.play().catch(() => {});
    } catch {
      /* silent — sound is non-essential */
    }
  }
}
