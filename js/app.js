// Air DJ: play songs with your hands in front of the camera, with live effects, visuals and recording.
//
// This file is the app. It runs top to bottom in these sections (search for "// ----"):
//   settings        every tunable constant (pinch ranges, effect levels, timings)
//   terminal        the log strip drawn under the camera
//   audio           the Web Audio graph: song -> filter -> bass -> crusher -> volume -> master
//   drum pads ... beat roll    the effects, one section each
//   subtitles       lyrics on screen (transcription and translation live in subtitles.js)
//   song library    the playlist and the library list in the panel, the intro screen before Start
//   hands           hand tracking (MediaPipe), pinch / pad / pistol / fist detection, smoothing
//   drawing, visuals, main loop, spectrum panel    everything drawn each frame
//   camera, controls    camera start, keyboard and buttons
//   recording       takes: WebCodecs video + raw sound stems, the sync preview, MP4 export
// Other files: subtitles.js (Whisper + translation), library.js (songs kept in the browser), demo.js (the demo
// song), media.js (your own pictures and sounds), util.js (shared helpers), gun3d.js (the 3D pistol), worklets/
// (audio processors).

import { FilesetResolver, HandLandmarker, FaceDetector } from "../vendor/vision_bundle.mjs";
import { Muxer, StreamTarget } from "../vendor/mp4-muxer.mjs";
import { openaiKey, loadSubs, cachedSubs, lineAt, wrap } from "./subtitles.js";
import { store, fmtTime } from "./util.js";
import { library, songId } from "./library.js";
import { localMedia } from "./media.js";
import { makeDemoSong, DEMO_ID } from "./demo.js";
import { initGun3D, renderGun } from "./gun3d.js";

// ---------------------------------------------------------------- settings
let W = 1080, H = 1920, CAM_H = 1060;           // set by applyLayout()
const WIDE_W = 1920, TERM_H = 400;               // wide layout: full camera frame at 1920 px wide, terminal strip below
// Wide layout: a vertical spectrum panel to the right of the camera + terminal. One thin yellow line per band grows
// right from a baseline: bass at the top, treble at the bottom. Silence draws nothing; hits (kick, snare, hats) shoot
// out of the bands they land in and fall back, so the panel pulses with the beat.
const BAR_W = 520, BAR_PITCH = 5, BAR_LINE = 3;   // panel width; px per row and line thickness (the gap = the stripes)
const BAR_HZ = [25, 16000], BAR_SPREAD = 2;        // frequency span top -> bottom; row spacing 2 = squared (bass on top)
const BAR_GATE_DB = -66;                           // a band quieter than this draws nothing (no hiss on quiet parts)
const BAR_FULL_DB = -24;                           // a band this loud reaches full length; a hotter song turns the scale
const BAR_PEAK_RELEASE = 3;                        // down to fit (s to come back) but a quiet one is never turned up
const BAR_TILT = 2.5;                              // dB per octave lift above 200 Hz: hats and snares still show
const BAR_BODY = 0.55, BAR_BODY_CURVE = 2;         // steady sound: weight and curve (>1 = ordinary bands stay short)
const BAR_PUNCH = 1.8, BAR_AVG = 0.35;             // hits: gain on a jump above the band's own BAR_AVG s average
const BAR_RELEASE = 0.12;                          // s for a line to fall back (rises instantly)
const BAR_KICK_HZ = 150, BAR_KICK_PUNCH = 2.6;     // bands below this hit harder on a jump (kick + bass drive the beat)
const BAR_HIGH_HZ = 5000, BAR_HIGH_PUNCH = 0.8;    // bands above this jump gently: hats flick, they don't take over
const BAR_GLOW = [8, 34], BAR_GLOW_FALL = 0.18;    // glow blur px: resting / on a kick; s to settle after a kick
const BAR_COLOR = "#f3c614";
// Speed mode, record style (pitch follows): 0.75x, 1x, 1.25x (steps of exactly 0.25), with 1x in the middle so a
// half-open pinch is the original. Pure musical ratios (4th down, major 3rd up), so they stay in tune.
const SPEED_MIN = 0.75, SPEED_MAX = 1.25, SPEED_STEP = 0.25;
const SPEED_STEPS = Array.from({ length: Math.round((SPEED_MAX - SPEED_MIN) / SPEED_STEP) + 1 }, (_, i) => SPEED_MIN + i * SPEED_STEP);   // 0.75, 1, 1.25
const SPEED_NAMES = ["4TH DOWN", "", "MAJ 3RD UP"];
const NEUTRAL_SPEED = SPEED_STEPS.indexOf(1);   // the step where the song plays as it is
// Octave voices (pitch-shifter.js) with 4096-sample frames: chord notes stay apart, so big shifts come out clean.
// A shifter delays its input by one frame minus one audio block plus its lookahead hops; the song waits as long, so
// the voices land with it.
const OCT_FRAME = 4096, OCT_LOOK = 1;
const OCT_LATENCY = OCT_FRAME - 128 + OCT_LOOK * OCT_FRAME / 4;   // 4992 samples (~104 ms)
let songDelay = 0;                               // s the song is held back for the octave voices (0 without them)
const STEP_HYST = 0.04;                        // pinch must cross a step boundary by this much to switch (no flicker)
const SPEED_GLIDE = 0.12;                      // s time constant for sliding between steps
// Right-hand filter, stepped like speed: each step is one octave of cutoff, so every step sounds equally big:
// muffled 400 Hz up to OPEN (the song untouched).
const LOWPASS_STEPS = [400, 800, 1600, 3200, 6400, 16000];   // last = wide open
const FILTER_OPEN = LOWPASS_STEPS.length - 1;
const FILTER_GLIDE = 0.06;                                    // s time constant for sliding between filter steps
const VOL_MAX = 7, VOL_DEFAULT = 5;                             // above ~7 the soft clipper starts to distort
const PINCH_CLOSED = 0.3, PINCH_OPEN = 1.4;    // 3D thumb-index gap / 3D palm length (wrist -> middle knuckle)
const PINCH_CURVE = 1.3;                       // >1: values fall off faster as fingers close (1 = linear)
const R_PINCH_OPEN = 1.1;                      // right hand (filter): fully open sooner, steps evenly spread (no curve)
const R_STEP_HYST = 0.15;                      // right hand: fraction of a step past its edge to switch (less sticky)
const PINCH_SMOOTH = [0.6, 0.8];               // pinch smoothing (both hands): OneEuro minCutoff, beta (lower = calmer, slower)
const FREEZE_TIME = 0.15;                      // s the pinch values hold still after a gesture that moves the fingers
const DEADBAND = 0.025;                        // ignore pinch wobble smaller than this (fraction of full range)
const LOST_GRACE = 0.25;                       // s to keep a hand alive through missed detections
const HANDS_NEAR = 0.12, HANDS_FAR = 0.80;     // hand distance / frame width
const ECHO_LOW = 0.5, ECHO_HIGH = 0.12;        // hand height (fraction of camera area): no echo below LOW, full at HIGH
const PAD_ON = 0.28, PAD_OFF = 0.45;           // thumb-to-fingertip gap / palm length to hit / release a pad
// ring + pinky are harder to touch tip-to-tip (and the thumb hides their tips from the camera): looser per finger
const PAD_ON_F = { 12: PAD_ON, 16: 0.36, 20: 0.36 }, PAD_OFF_F = { 12: PAD_OFF, 16: 0.52, 20: 0.52 };
const PAD_CLEAR = 0.75;                        // a pad fires only when the thumb is clearly nearer it than the others
const PAD_SWITCH = 0.2;                        // s after a hold pad starts in which a clearly nearer finger takes over
// pistol: a shot, then the gun being cocked right after it (your recordings from assets/local, else a synth shot)
const PISTOL_COCK_AT = 0.25;                    // s after the shot that the cock starts (its click lands ~0.15 s later)
const PISTOL_SHOT_LEVEL = 1.0, PISTOL_COCK_LEVEL = 0.9;
const PADS = { L: { 12: "BASS", 16: "CRUSH", 20: "HI-HAT" }, R: { 12: "ROLL", 16: "OCTAVES", 20: "SIREN" } };
const HOLD_PADS = new Set(["BASS", "CRUSH", "ROLL", "OCTAVES", "SIREN"]);
// Bass boost (left thumb held on the middle finger): a low shelf for weight, a punch around the kick's fundamental,
// a cut in the low mids so the bass stands apart instead of turning to mud, and GRIT: the bass band alone driven into
// saturation and mixed back in. Its overtones (100-900 Hz) are what laptop and phone speakers can actually play, so the
// boost is clearly heard there too, not only on a subwoofer. The song is trimmed a little while it's on, so the boost
// adds bass instead of just pushing the whole mix into the soft clipper.
const BASS_SHELF_HZ = 120, BASS_SHELF_DB = 10, BASS_PUNCH_HZ = 55, BASS_PUNCH_DB = 6;
const BASS_MUD_HZ = 280, BASS_MUD_DB = -4, BASS_MUD_Q = 1.6;   // low-mid cut while boosted (narrow: vocals stay)
const BASS_GRIT = 0.55, BASS_GRIT_DRIVE = 5;       // level of the saturated bass layer; how hard it's driven
const BASS_TRIM = 0.78, BASS_IN = 0.08, BASS_OUT = 0.15;   // song level while boosted; s to swell in / ease out
// Ring-finger holds (left = crush, right = octaves) read the hand's height: LOW (fraction of the camera) = first
// step, HIGH = last; HYST = fraction of a step the hand must pass an edge by to switch.
const HOLD_LOW = 0.85, HOLD_HIGH = 0.15, HOLD_HYST = 0.3;
// Octaves (right thumb held on the ring finger): the song's melody + chords (drums left out) an octave or two away.
// Octaves are the one interval that fits every chord of every song (same notes, higher / lower), so it never clashes.
// Each voice is EQ'd to stay clean (no mud from shifted bass); the top step adds a short tempo-synced ping-pong echo.
// Hand height picks the step, low -> high. Levels are per voice; duck = how far the dry song steps back.
const OCT_STEPS = [
  { name: "OCTAVE DOWN", down: 1.1, up: 0, up2: 0, echo: 0, duck: 0.9 },
  { name: "OCTAVE UP", down: 0, up: 1, up2: 0, echo: 0, duck: 0.9 },
  { name: "UP + DOWN", down: 0.9, up: 0.9, up2: 0, echo: 0, duck: 0.8 },
  { name: "2 OCTAVES UP", down: 0, up: 0.6, up2: 0.75, echo: 0.45, duck: 0.85 } ];
const OCT_FADE = 0.04;                             // s in / out
const OCT_ECHO_BEATS = 0.75, OCT_ECHO_FB = 0.38;   // dotted 1/8 ping-pong, feedback (~4 audible repeats)
// Jungle break (key 6 = on, again = off): your own recorded drum loop (assets/local, with its tempo and length in
// beats), looped beat-exact and played at the song's tempo: the nearest of half / same / double time, so an
// 87 BPM song gets a 138 BPM loop at 174 and a 128 BPM one at 128. Like a record, faster = higher. Starts on its
// downbeat on the tap.
let jungleOwn = { bpm: 138, beats: 16 };          // the loop's own tempo and length (set from media.json)
const jungleLoopLen = () => jungleOwn.beats * 60 / jungleOwn.bpm;   // s of the loop at its own tempo
const JUNGLE_LEVEL = 0.8, JUNGLE_FADE = 0.015;     // output level; s fade in / out (no clicks)
// Air-raid siren (right thumb held on the pinky; or hold S, mouse height = pitch): your recording from assets/local,
// or a synthesized one laid out the same way. Holding plays its wind-up, then loops its steady wail (crossfaded at the
// loop point, so no click) for as long as you hold; letting go plays the recording's own wind-down. Hand height bends
// its pitch: middle = as recorded, low = deeper, high = higher. It also runs into a light tempo-synced dub echo.
// A recording of your own needs the same layout: wind-up until SIREN_LOOP[0], steady to past SIREN_LOOP[1],
// wind-down from SIREN_TAIL_AT.
const SIREN_LOOP = [3.0, 7.0];                     // s: the steady part of the recording that loops while held
const SIREN_LOOP_XF = 0.4;                         // s crossfade at the loop point
const SIREN_TAIL_AT = 7.5, SIREN_TAIL = 4;         // s where the wind-down starts in the file; s it plays after release
const SIREN_RATE_LOW = 0.8, SIREN_RATE_HIGH = 1.25;   // playback rate at the bottom / top of the hand range (about -4 / +4 semitones)
const SIREN_LEVEL = 0.9, SIREN_IN = 0.01, SIREN_SWAP = 0.25;   // level; s fade in; s crossfade into the wind-down
const SIREN_ECHO_BEATS = 0.75, SIREN_ECHO_FB = 0.35, SIREN_ECHO_WET = 0.3;   // dotted 1/8 echo, feedback, level
// Throw it away (after a record stop): while two fists hold the song stopped, swing both hands fast in any direction.
// The window between your hands flies off that way, spinning and falling, with a trail, a whoosh and a crash, and the
// song stays stopped. Two fists again then open (or Space / ▶) spin it back up where it stopped; N plays the next song.
const THROW_SPEED = 5;                             // hand sizes per second the hands must swing (over THROW_WINDOW)
const THROW_WINDOW = 0.12;                         // s of hand movement the speed is measured over
const THROW_BOOST = 1.5, THROW_MIN = 1800;         // the window leaves faster than the hands moved; px/s at least
const THROW_GRAVITY = 2600, THROW_SPIN = 10;       // px/s² pulling it down; most rad/s of spin
// Record stop (both hands in fists, held): the song slows to a stop like a turntable, pitch falling with it, stays
// stopped while held, and spins back up when the hands open. A fist = all four fingertips curled back to the palm.
const BRAKE_TIME = 0.9, SPINUP_TIME = 0.3, FIST_FRAMES = 4;   // s to stop; s to get back to speed; frames to confirm
// Beat roll (right thumb held on the middle fingertip): the song repeats a slice of itself, and the slice gets
// shorter every ROLL_BEATS_PER_STEP beats you keep holding, so the repeats speed up into a build. Let go: the song
// drops back in exactly where it would have been (it kept playing silently underneath).
const ROLL_STEPS = [1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 32];    // beats per repeat
const ROLL_NAMES = ["1/2", "1/4", "1/8", "1/16", "1/32"];
const ROLL_BEATS_PER_STEP = 4;                 // one bar per step
const ROLL_FADE = 0.006;                       // s crossfade in/out of the roll (no clicks)
// Crush (left thumb held on the ring finger): bitcrusher. Hand height picks how hard: low = 8-BIT, up = 6-BIT,
// high = 4-BIT; letting go turns it off.
const CRUSH_STEPS = [{ name: "OFF", bits: 16, rate: 192000 }, { name: "8-BIT", bits: 8, rate: 16000 },
                     { name: "6-BIT", bits: 6, rate: 8000 }, { name: "4-BIT", bits: 4, rate: 5000 }];
// Finger pistol (right hand; or whichever hand is alone on screen): make a finger gun (index out, the other fingers folded), then pull the trigger:
// bend the index down, or snap it onto the folded middle finger. Measured against the palm, so distance to the camera
// doesn't matter. The grip is forgiving: the middle finger must be folded and one of ring / pinky too, the other only
// loosely, and the thumb can be up or resting on the middle finger. The trigger has to stay pulled for PISTOL_FRAMES
// frames, and the index has to straighten again before the next shot. PISTOL_COOLDOWN covers the cock.
const PISTOL_ON = 0.38, PISTOL_OFF = 0.55;         // index-tip-to-middle-finger gap (/ palm) that fires / re-arms
const PISTOL_BENT = 1.3;                           // index tip-to-wrist / knuckle-to-wrist below this = trigger pulled
const PISTOL_OUT = 1.4;                            // ... above this = index pointing out (straight is ~1.9)
const PISTOL_CURL = 1.05, PISTOL_CURL_LOOSE = 1.25;   // folded = tip nearer the wrist than its middle joint (x slack)
const PISTOL_FRAMES = 2, PISTOL_COOLDOWN = 0.75;
const PISTOL_PAD_CLEAR = 0.38;                   // thumb this far from the ring / pinky tips: not a pad touch, so it can be a gun
const PISTOL_ARM = 0.9;                          // s the gun stays armed after the pose was last seen (the shot bends the index)

const $ = id => document.getElementById(id);
const canvas = $("c"), g = canvas.getContext("2d"), video = $("v");
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const norm = (x, lo, hi) => clamp((x - lo) / (hi - lo), 0, 1);
const status = s => { $("status").textContent = s; };

// ---------------------------------------------------------------- terminal
const lines = [];
function log(s = "") {                          // the terminal strip; also console.debug, for debugging and the tests
  for (const l of String(s).split("\n")) { lines.push(l); console.debug(l); }
  if (lines.length > 200) lines.splice(0, lines.length - 200);
}
function drawTerminal() {
  g.fillStyle = "#121216"; g.fillRect(0, CAM_H, W, H - CAM_H);
  g.font = '22px Menlo, Monaco, "DejaVu Sans Mono", monospace';
  g.fillStyle = "#e1e1e6"; g.textAlign = "left"; g.textBaseline = "top";
  const lh = 28, rows = Math.floor((H - CAM_H - 30) / lh);
  let y = CAM_H + 12;
  for (const l of lines.slice(-rows)) { g.fillText(l, 24, y); y += lh; }
  g.strokeStyle = "#c8c8c8"; g.lineWidth = 1; g.strokeRect(24.5, y + 2.5, 11, lh - 6);
}

// ---------------------------------------------------------------- audio
let ctx, source, filter, gain, analyser, dest, master;
let echoSend, echoDelay, echoFb, padBus, noise, gunshotBuf, crusher, songGain, songIn, oct, bassShelf, bassPunch, bassTrim;
let bassMud, bassGrit, sirenBus, sirenEcho, jungleBus, recStemIn, cockBuf, sirenBuf, sirenLoopBuf;
// a tanh soft-clip curve for a WaveShaper (its input spans -1..1)
function softClip(drive, scale = 1) {
  const c = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) c[i] = Math.tanh((i / 511.5 - 1) * drive) * scale;
  return c;
}
// The master stage: input level -> soft clip (loud settings don't crackle) -> 12 Hz DC blocker (a stopped record holds
// its last sample, a silent offset speakers shouldn't sit on). Built the same way for the speakers, the take preview
// and saving a take, so all three sound the same.
const MASTER_LEVEL = 0.4, MASTER_CURVE = softClip(2.5);
function masterStage(c) {
  const input = c.createGain(), clip = c.createWaveShaper(), dc = c.createBiquadFilter();
  input.gain.value = MASTER_LEVEL; clip.curve = MASTER_CURVE;
  dc.type = "highpass"; dc.frequency.value = 12; dc.Q.value = 0.7;
  input.connect(clip); clip.connect(dc);
  return { input, output: dc };
}
// The playlist. Each track: { file, id (its library id), buf (decoded, or null), decoding (a decode under way),
// bpm, grid (see detectGrid), subs (subtitle lines), sub (subtitle state, see SUB_LABEL), subError }.
let tracks = [], idx = 0, token = 0, paused = false, bpm = 120;
const newTrack = (file, id) => ({ file, id, buf: null, decoding: null, bpm: 0, grid: null, subs: null,
  sub: id === DEMO_ID ? "none" : undefined, subError: "" });   // the demo has no vocals: nothing to transcribe
const beatHz = () => bpm * state.speed / 60;     // beats per second as heard (follows the speed control)
let freqData;

async function setupAudio() {
  ctx = new AudioContext();
  let shifterOk = true;                          // the octave voices' pitch shifter
  try { await ctx.audioWorklet.addModule("./js/worklets/pitch-shifter.js"); }
  catch (err) { shifterOk = false; console.warn("pitch shifter unavailable, no octaves:", err); }
  try {                                          // filter -> bitcrusher -> volume. Passes through untouched when off.
    await ctx.audioWorklet.addModule("./js/worklets/bitcrusher.js");
    crusher = new AudioWorkletNode(ctx, "bitcrusher", { outputChannelCount: [2] });
  } catch (err) {
    crusher = null; console.warn("bitcrusher unavailable:", err);
  }
  filter = ctx.createBiquadFilter(); filter.type = "lowpass"; filter.Q.value = 0.9;   // gentle: no whistling resonance
  gain = ctx.createGain();
  const out = masterStage(ctx); master = out.input;
  analyser = ctx.createAnalyser(); analyser.fftSize = 4096;      // fine bins so the bass bands are distinct
  analyser.smoothingTimeConstant = 0.5; analyser.minDecibels = -90; analyser.maxDecibels = -18;
  freqData = new Uint8Array(analyser.frequencyBinCount);
  dest = ctx.createMediaStreamDestination();
  // filter -> bass boost (flat until held) -> bitcrusher -> volume
  bassShelf = ctx.createBiquadFilter(); bassShelf.type = "lowshelf"; bassShelf.frequency.value = BASS_SHELF_HZ; bassShelf.gain.value = 0;
  bassPunch = ctx.createBiquadFilter(); bassPunch.type = "peaking"; bassPunch.frequency.value = BASS_PUNCH_HZ; bassPunch.Q.value = 1.1; bassPunch.gain.value = 0;
  bassTrim = ctx.createGain();
  bassMud = ctx.createBiquadFilter(); bassMud.type = "peaking"; bassMud.frequency.value = BASS_MUD_HZ; bassMud.Q.value = BASS_MUD_Q; bassMud.gain.value = 0;
  filter.connect(bassTrim); bassTrim.connect(bassShelf); bassShelf.connect(bassPunch); bassPunch.connect(bassMud);
  // grit: bass band only (24 dB/oct) -> saturation -> keep the overtones, drop the fizz -> mixed in (silent until held)
  const lo1 = ctx.createBiquadFilter(), lo2 = ctx.createBiquadFilter(), drive = ctx.createGain(), sat = ctx.createWaveShaper(), tame = ctx.createBiquadFilter();
  for (const f of [lo1, lo2]) { f.type = "lowpass"; f.frequency.value = 140; f.Q.value = 0.7; }
  drive.gain.value = BASS_GRIT_DRIVE;
  sat.curve = softClip(3, 0.8); sat.oversample = "4x";
  tame.type = "lowpass"; tame.frequency.value = 900; tame.Q.value = 0.6;
  bassGrit = ctx.createGain(); bassGrit.gain.value = 0;
  filter.connect(lo1); lo1.connect(lo2); lo2.connect(drive); drive.connect(sat); sat.connect(tame); tame.connect(bassGrit); bassGrit.connect(bassMud);
  if (crusher) { bassMud.connect(crusher); crusher.connect(gain); } else bassMud.connect(gain);
  gain.connect(master);
  songIn = ctx.createGain();                     // where the song (and the beat roll) enter the chain
  songGain = ctx.createGain(); songGain.connect(songIn);   // muted while a beat roll plays over it
  if (shifterOk) try { oct = makeOctaves(); } catch (err) { oct = null; console.warn("octaves unavailable:", err); }
  if (oct) {                                     // the song waits for the octave voices
    const wait = ctx.createDelay(0.2); songDelay = OCT_LATENCY / ctx.sampleRate; wait.delayTime.value = songDelay;
    songIn.connect(wait); wait.connect(filter);
  } else songIn.connect(filter);
  out.output.connect(analyser); out.output.connect(ctx.destination); out.output.connect(dest);

  // dub echo: the song after bass / crush (and the pads) -> send -> delay <-> (band-limited feedback) -> volume.
  // Lowering the send lets tails ring out. (Its return joins the song, so in a take the pads' echo tails move with
  // the song's timing.)
  echoSend = ctx.createGain(); echoSend.gain.value = 0;
  echoDelay = ctx.createDelay(8);
  echoFb = ctx.createGain();                     // feedback: set every frame in applyAudio
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 250;
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3500;
  const wet = ctx.createGain(); wet.gain.value = 0.75;
  (crusher || bassMud).connect(echoSend); echoSend.connect(echoDelay);
  echoDelay.connect(hp); hp.connect(lp); lp.connect(echoFb); echoFb.connect(echoDelay);
  lp.connect(wet); wet.connect(gain);

  // drum pads: bypass the hand filter and volume, but feed the echo too
  padBus = ctx.createGain(); padBus.gain.value = 1.2;
  padBus.connect(master); padBus.connect(echoSend);
  // siren bus: dry + its own tempo-synced echo (band-limited feedback, like a tape / spring unit), straight to master
  sirenBus = ctx.createGain(); sirenBus.connect(master);
  const sd = ctx.createDelay(4), sfb = ctx.createGain(), shp = ctx.createBiquadFilter(), slp = ctx.createBiquadFilter(), swet = ctx.createGain();
  sfb.gain.value = SIREN_ECHO_FB; swet.gain.value = SIREN_ECHO_WET;
  shp.type = "highpass"; shp.frequency.value = 300; slp.type = "lowpass"; slp.frequency.value = 2800;
  sirenBus.connect(sd); sd.connect(shp); shp.connect(slp); slp.connect(sfb); sfb.connect(sd); slp.connect(swet); swet.connect(master);
  // the jungle loop plays on the song's beat, so it has its own bus: in the recording it goes along with the song
  jungleBus = ctx.createGain(); jungleBus.gain.value = 1.2; jungleBus.connect(master); jungleBus.connect(echoSend);
  // The recording keeps two stems of what goes into the master (the same signals the speakers get):
  // the song (with everything done to it, and the jungle loop) and the sounds your hands set off (pads, gunshot,
  // siren, whoosh). That way the song's timing can be set after the take without moving those sounds off their gestures.
  recStemIn = { song: [gain, jungleBus], fx: [padBus, sirenBus, swet] };
  sirenEcho = sd;
  noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const setSiren = b => { sirenBuf = b; sirenLoopBuf = loopable(b, ...SIREN_LOOP, SIREN_LOOP_XF); };
  setSiren(synthSiren());                        // replaced by your recording once it has loaded
  const media = await localMedia;
  const load = (file, done) => file && fetch(file).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b)).then(done)
    .catch(err => console.warn(`${file} failed to load:`, err));
  if (media.jungle) { jungleOwn = media.jungle; load(media.jungle.file, b => { jungleBuf = b; }); }
  load(media.pistolShot, b => { gunshotBuf = b; });
  load(media.pistolCock, b => { cockBuf = b; });
  load(media.siren, setSiren);
}
// A two-tone air-raid siren with the recording's layout (see SIREN_LOOP): rotor-like tones that wind up to a steady
// wail, hold, and wind down from SIREN_TAIL_AT.
function synthSiren() {
  const sr = ctx.sampleRate, len = SIREN_TAIL_AT + SIREN_TAIL + 0.5, buf = ctx.createBuffer(1, Math.ceil(len * sr), sr);
  const d = buf.getChannelData(0), TOP = 560, up = SIREN_LOOP[0];
  let ph = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const f = t < up ? 90 + (TOP - 90) * (1 - Math.exp(-1.6 * t)) / (1 - Math.exp(-1.6 * up))
            : t < SIREN_TAIL_AT ? TOP : TOP * Math.exp(-0.45 * (t - SIREN_TAIL_AT));
    const env = Math.min(1, t / 0.3) * (t < SIREN_TAIL_AT ? 0.6 + 0.4 * f / TOP : Math.max(0, 1 - (t - SIREN_TAIL_AT) / SIREN_TAIL));
    ph += 2 * Math.PI * f / sr;
    const rotor = p => Math.sin(p) + 0.45 * Math.sin(2 * p) + 0.25 * Math.sin(3 * p) + 0.12 * Math.sin(4 * p);
    d[i] = 0.28 * env * (rotor(ph) + 0.7 * rotor(ph * 1.19));   // two rotors a minor third apart
  }
  return buf;
}

// Decoded songs (~10 MB per minute) are kept only for the playing track and its neighbours. A decode already under
// way is shared, so the player and the background preparation never decode the same song twice.
function decode(i) {
  const t = tracks[i];                           // the track itself, not its index: the playlist can change meanwhile
  if (t.buf) return Promise.resolve(t.buf);
  return t.decoding ||= t.file.arrayBuffer().then(b => ctx.decodeAudioData(b))
    .then(b => (t.buf = b), err => { throw new Error(`can't decode ${t.file.name}: ${err.message}`); })
    .finally(() => { t.decoding = null; });
}
// tempo and beat grid of a track, worked out once (and ahead of time for the neighbours, see prepareNeighbours)
function analyse(i, buf) {
  const t = tracks[i];
  if (!t.bpm) t.bpm = detectBPM(buf);
  if (!t.grid) t.grid = detectGrid(buf, t.bpm);
}
// Where the beats are: the loudness jumps of the whole track, folded over one beat of its tempo, give the beat's
// phase; the first beat is the first grid point at the first real hit (so a switch skips silence at the start).
// onset strength: the rises in log loudness, one value per hop of samples in [from, to)
function onsetEnvelope(ch, from, to, hop) {
  const out = new Float32Array(Math.max(0, Math.floor((to - from) / hop))); let prev = 0;
  for (let k = 0; k < out.length; k++) {
    let e = 0; for (let j = from + k * hop; j < from + (k + 1) * hop; j++) e += ch[j] * ch[j];
    const l = Math.log1p(100 * e); out[k] = k ? Math.max(0, l - prev) : 0; prev = l;
  }
  return out;
}
function detectGrid(buf, tempo) {
  const sr = buf.sampleRate, ch = buf.getChannelData(0), hop = 256, fps = sr / hop, beat = 60 / tempo, lag = beat * fps;
  const onset = onsetEnvelope(ch, 0, ch.length, hop), top = onset.reduce((a, v) => Math.max(a, v), 0);
  const bins = Math.max(1, Math.round(lag)), fold = new Float32Array(bins);
  for (let k = 0; k < onset.length; k++) fold[Math.floor((k % lag) / lag * bins) % bins] += onset[k];
  let pb = 0; for (let b = 1; b < bins; b++) if (fold[b] + 0.5 * (fold[b - 1] + fold[(b + 1) % bins]) > fold[pb] + 0.5 * (fold[(pb - 1 + bins) % bins] + fold[(pb + 1) % bins])) pb = b;
  const phase = pb / bins * beat;
  let firstHit = 0; for (let k = 0; k < onset.length; k++) if (onset[k] > 0.3 * top) { firstHit = k / fps; break; }
  const first = phase + Math.max(0, Math.ceil((firstHit - phase - beat * 0.25) / beat)) * beat;
  return { phase, first: Math.min(first, Math.max(0, buf.duration - 1)) };
}
// after a track starts: decode and analyse the next and previous ones in the background, so switching is instant
function prepareNeighbours() {
  const my = token, near = new Set([idx, idx + 1, idx - 1].map(j => (j + tracks.length) % tracks.length));
  tracks.forEach((t, j) => { if (!near.has(j)) t.buf = null; });   // free songs we've moved away from
  setTimeout(async () => {
    for (const j of near) {
      if (my !== token) return;                  // switched again meanwhile: that switch prepares its own neighbours
      if (j !== idx) { try { analyse(j, await decode(j)); } catch { /* a bad file: it reports when it's played */ } }
    }
  }, 1500);
}

// Tempo from onset-strength autocorrelation over ~60 s from the middle of the track.
function detectBPM(buf) {
  const sr = buf.sampleRate, ch = buf.getChannelData(0), hop = 512, fps = sr / hop;
  const start = Math.floor(Math.max(0, buf.duration / 2 - 30) * sr), end = Math.min(ch.length, start + 60 * sr);
  const onset = onsetEnvelope(ch, start, end, hop);
  const at = x => { const i = Math.floor(x), f = x - i; return onset[i] * (1 - f) + (onset[i + 1] || 0) * f; };
  let best = 120, bestScore = -Infinity;
  for (let b = 70; b <= 180; b += 0.5) {
    const lag = 60 / b * fps; let s = 0, n = 0;
    for (let i = 0; i + 2 * lag + 1 < onset.length; i++) { s += onset[i] * (at(i + lag) + 0.5 * at(i + 2 * lag)); n++; }
    const score = (s / Math.max(1, n)) * Math.exp(-0.5 * (Math.log2(b / 120) / 1.2) ** 2);
    if (score > bestScore) { bestScore = score; best = b; }
  }
  if (best < 85) best *= 2;                      // candidates run 70-180: a slow reading is half time
  return Math.round(best);
}

// ramp an AudioParam from its value now (or `from`) to `to` over `dur` seconds, cancelling what was scheduled
function ramp(param, to, dur, from = param.value, t = ctx.currentTime) {
  param.cancelScheduledValues(t); param.setValueAtTime(from, t); param.linearRampToValueAtTime(to, t + dur);
}

// ---------------------------------------------------------------- drum pads (synthesized)
function hitEnvelope(node, t, peak, attack, decay) {
  node.gain.setValueAtTime(0.0001, t);
  node.gain.exponentialRampToValueAtTime(peak, t + attack);
  node.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}
function tone(type, f0, f1, t, dur, peak, out = padBus) {
  const o = ctx.createOscillator(), a = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  hitEnvelope(a, t, peak, 0.003, dur); o.connect(a); a.connect(out); o.start(t); o.stop(t + dur + 0.05);
  o.onended = () => a.disconnect();
  return o;
}
function hiss(type, freq, t, dur, peak, q = 0.8, out = padBus) {
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), a = ctx.createGain();
  s.buffer = noise; f.type = type; f.frequency.value = freq; f.Q.value = q;
  s.loopStart = 0; s.loop = true;                  // long tails (open hat, crash) never run out of noise
  hitEnvelope(a, t, peak, 0.002, dur); s.connect(f); f.connect(a); a.connect(out); s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
  s.onended = () => a.disconnect();
}
const SOUNDS = {
  "HI-HAT": t => hiss("highpass", 7500, t, 0.07, 0.6),
  // pistol cock right after each shot (recording; nothing until it has loaded)
  RELOAD: t => { if (cockBuf) playSample(cockBuf, t, PISTOL_COCK_LEVEL); },
  GUNSHOT: t => {
    if (gunshotBuf) { playSample(gunshotBuf, t, PISTOL_SHOT_LEVEL); return; }
    hiss("highpass", 2500, t, 0.035, 1.6, 0.5); hiss("lowpass", 1800, t, 0.18, 1.4, 0.7);   // synth fallback until it loads
    tone("sine", 140, 38, t, 0.25, 1.8); hiss("bandpass", 600, t + 0.01, 0.6, 0.35, 0.6);
  },
};
function playSample(buf, t, level) {                   // a recording, once, into the pads (so the hand echo catches it too)
  const s = ctx.createBufferSource(), a = ctx.createGain();
  s.buffer = buf; a.gain.value = level; s.connect(a); a.connect(padBus); s.start(t); s.onended = () => a.disconnect();
}
const bursts = [];
function shootPistol(k, hand) {
  if (!ctx || paused) return;
  laserPow = 1.2; laserSparks = true;           // the eyes fire with the gun
  SOUNDS.GUNSHOT(ctx.currentTime + 0.005);
  SOUNDS.RELOAD(ctx.currentTime + 0.005 + PISTOL_COCK_AT);
  gunNegUntil = performance.now() / 1000 + 0.12;   // flip the window to negative for a moment
  fireGun(k, hand);
}
// ---------------------------------------------------------------- jungle break
let jungleBuf = null, jungle = null;
const jungleBpm = () => {                        // the song's tempo, or half / double it, whichever is nearest 138
  const b = bpm * state.speed;
  return [b / 2, b, b * 2].sort((x, y) => Math.abs(Math.log(x / jungleOwn.bpm)) - Math.abs(Math.log(y / jungleOwn.bpm)))[0];
};
const jungleRate = () => jungleBpm() / jungleOwn.bpm;
function toggleJungle() {
  if (jungle) { stopJungle(); log("Jungle loop off"); return false; }
  if (!jungleBuf) { log("No jungle loop: add one in assets/local (see assets/local/README.md)"); return false; }
  log(`Jungle loop on: ${Math.round(jungleBpm())} BPM`);
  const t = ctx.currentTime + 0.005, src = ctx.createBufferSource(), amp = ctx.createGain();
  src.buffer = jungleBuf; src.loop = true; src.loopStart = 0; src.loopEnd = jungleLoopLen();
  src.playbackRate.value = jungleRate();
  amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(JUNGLE_LEVEL, t + JUNGLE_FADE);
  src.connect(amp); amp.connect(jungleBus); src.start(t, 0);   // from its downbeat, right on the tap
  jungle = { src, amp, pos: 0, lastT: t };
  return true;
}
function stopJungle() {
  if (!jungle) return;
  const t = ctx.currentTime, { src, amp } = jungle;
  ramp(amp.gain, 0, JUNGLE_FADE);
  src.stop(t + JUNGLE_FADE + 0.01); src.onended = () => amp.disconnect();
  jungle = null;
}
function updateJungle() {                        // per frame: follow the tempo / speed, track the loop position
  if (!jungle) return;
  const t = ctx.currentTime, r = jungle.src.playbackRate;
  if (t > jungle.lastT) { jungle.pos = (jungle.pos + (t - jungle.lastT) * r.value) % jungleLoopLen(); jungle.lastT = t; }
  if (!brake) r.setTargetAtTime(jungleRate(), t, SPEED_GLIDE);   // the record stop drives it itself
}

// ---------------------------------------------------------------- air-raid siren
let siren = null;
const sirenRate = y => SIREN_RATE_LOW * (SIREN_RATE_HIGH / SIREN_RATE_LOW) ** y;   // y 0..1 = hand low..high
const sirenLabel = () => { const st = Math.round(12 * Math.log2(sirenRate(siren.y))); return st ? `${st > 0 ? "+" : ""}${st} st` : "ORIGINAL"; };
// A copy of the recording whose last XF seconds before `end` are blended with the XF seconds before `start`, so a
// loop from start to end continues smoothly instead of jumping.
function loopable(buf, start, end, xf) {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate), sr = buf.sampleRate;
  const a = Math.round(start * sr), b = Math.round(end * sr), n = Math.round(xf * sr);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c), dst = out.getChannelData(c); dst.set(src);
    for (let i = 0; i < n; i++) {
      const w = i / n;                           // equal-power: fade the end out while the bit before the start fades in
      dst[b - n + i] = src[b - n + i] * Math.cos(w * Math.PI / 2) + src[a - n + i] * Math.sin(w * Math.PI / 2);
    }
  }
  return out;
}
function startSiren(y) {
  const t = ctx.currentTime, src = ctx.createBufferSource(), amp = ctx.createGain();
  src.buffer = sirenLoopBuf; src.loop = true; src.loopStart = SIREN_LOOP[0]; src.loopEnd = SIREN_LOOP[1];
  src.playbackRate.value = sirenRate(y);
  amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(SIREN_LEVEL, t + SIREN_IN);
  src.connect(amp); amp.connect(sirenBus); src.start(t, 0);   // from the top: the wind-up
  siren = { src, amp, y, t0: t };
  return true;
}
function updateSiren(y) {                         // per frame while held: pitch from the hand, echo from the tempo
  const t = ctx.currentTime;
  sirenEcho.delayTime.setTargetAtTime(Math.min(3.9, SIREN_ECHO_BEATS / beatHz()), t, 0.05);
  if (siren && y !== null && Math.abs(y - siren.y) > 0.005) { siren.y = y; siren.src.playbackRate.setTargetAtTime(sirenRate(y), t, 0.05); }
}
function stopSiren() {
  if (!siren) return;
  const t = ctx.currentTime, { src, amp } = siren, rate = src.playbackRate.value;
  const wound = (t - siren.t0) * rate > SIREN_LOOP[0];   // past the wind-up: wind down with the recording's own ending
  ramp(amp.gain, 0, wound ? SIREN_SWAP : 0.6);
  src.stop(t + (wound ? SIREN_SWAP : 0.6) + 0.02); src.onended = () => amp.disconnect();
  if (wound) {
    const tail = ctx.createBufferSource(), tg = ctx.createGain();
    tail.buffer = sirenBuf; tail.playbackRate.value = rate;
    ramp(tg.gain, SIREN_LEVEL, SIREN_SWAP, 0); tg.gain.linearRampToValueAtTime(0, t + SIREN_TAIL);
    tail.connect(tg); tg.connect(sirenBus); tail.start(t, SIREN_TAIL_AT); tail.stop(t + SIREN_TAIL + 0.02);
    tail.onended = () => tg.disconnect();
  }
  siren = null;
}

function firePad(k, finger, pos) {
  const name = PADS[k][finger];
  if (!ctx || paused) return;
  SOUNDS[name](ctx.currentTime + 0.005);
  spawnSparks(pos[0], pos[1], 35);
  bursts.push({ x: pos[0], y: pos[1], name, t: performance.now() / 1000 });
}

// ---------------------------------------------------------------- finger pistol
// Finger-gun gesture, fired by snapping the index onto the middle finger: a 3D pistol appears in the hand aimed at the camera and fires a real
// recorded 9 mm shot. Muzzle flash toward the viewer, recoil, ejected casing, smoke, the screen "glass" cracks
// where the bullet hits it, plus camera shake and a white flash.
const guns = [], cracks = [];
let gunKick = 0;
const GUN_LIFE = 0.8;
function gunPose(h) {                          // anchor between palm and index tip; gun scales with the hand
  return { x: h.palm[0] * 0.6 + h.index[0] * 0.4, y: h.palm[1] * 0.6 + h.index[1] * 0.4, size: clamp(h.size * 1.25, 110, 460) };
}
function fireGun(k, hand) {
  const pose = hand ? gunPose(hand) : { x: W / 2, y: CAM_H / 2, size: 260 };
  guns.push({ t: performance.now() / 1000, side: k, ...pose, casing: null, smoke: [], muzzle: null });
  if (guns.length > 4) guns.shift();
  gunKick = 1;
}
function makeCrack(x, y, R) {                  // radial cracks + two rings of cross-cracks, like a bullet in glass
  const rays = [], n = 9 + Math.floor(Math.random() * 5);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.5, len = R * (0.45 + Math.random() * 0.6), pts = [[x, y]];
    for (let d = 0.12; d <= 1.001; d += 0.12) {
      const j = (Math.random() - 0.5) * 0.25;
      pts.push([x + Math.cos(a + j) * len * d, y + Math.sin(a + j) * len * d]);
    }
    rays.push(pts);
  }
  const rings = [0.22, 0.45].map(f => rays.map(r => r[Math.min(r.length - 1, Math.round(f / 0.12))]));
  const gaps = rings.map(r => r.map(() => Math.random() < 0.2));   // a few cross-cracks missing, fixed for this crack
  return { x, y, rays, rings, gaps, t: performance.now() / 1000 };
}
function drawCracks(now) {
  for (let i = cracks.length - 1; i >= 0; i--) {
    const c = cracks[i], age = now - c.t;
    if (age > 2.2) { cracks.splice(i, 1); continue; }
    const k = clamp((2.2 - age) / 0.6, 0, 1), grow = clamp(age / 0.05, 0, 1);
    g.save(); g.globalAlpha = k; g.lineJoin = "round"; g.lineCap = "round";
    for (const [style, w, off] of [["rgba(0,0,0,.45)", 4, 1.5], ["rgba(255,255,255,.9)", 1.6, 0]]) {
      g.strokeStyle = style; g.lineWidth = w; g.beginPath();
      for (const ray of c.rays) {
        const m = Math.max(2, Math.round(ray.length * grow));
        g.moveTo(ray[0][0] + off, ray[0][1] + off);
        for (let j = 1; j < m; j++) g.lineTo(ray[j][0] + off, ray[j][1] + off);
      }
      if (grow >= 1) c.rings.forEach((ring, ri) => ring.forEach((p, j) => {
        if (c.gaps[ri][j]) return;
        const q = ring[(j + 1) % ring.length];
        g.moveTo(p[0] + off, p[1] + off); g.lineTo(q[0] + off, q[1] + off);
      }));
      g.stroke();
    }
    g.fillStyle = "rgba(10,10,12,.85)"; g.beginPath(); g.arc(c.x, c.y, 9, 0, 7); g.fill();           // the hole
    g.strokeStyle = "rgba(255,255,255,.8)"; g.lineWidth = 2; g.beginPath(); g.arc(c.x, c.y, 13, 0, 7); g.stroke();
    g.restore();
  }
}
function drawGuns(now, dt) {
  gunKick = Math.max(0, gunKick - dt * 7);
  for (let i = guns.length - 1; i >= 0; i--) {
    const gun = guns[i], age = now - gun.t;
    if (age > GUN_LIFE + 1.2) { guns.splice(i, 1); continue; }
    const live = alive(gun.side, now);           // follow the hand while it's visible
    if (live && age < GUN_LIFE) Object.assign(gun, gunPose(live));
    const { x, y, size } = gun, S = size * 2.4;

    if (age < GUN_LIFE) {
      // aim at the lens: a hand right of centre turns the barrel left, a high hand tilts it down
      const kick = 0.55 * Math.exp(-age * 9) * Math.min(1, age / 0.012), back = 0.16 * Math.exp(-age * 16);
      const r = renderGun({ yaw: 0.28 - (x / W - 0.5) * 0.9, pitch: 0.12 + (0.5 - y / CAM_H) * 0.5, kick, back });
      if (r) {
        const sc = S / r.size;
        gun.muzzle = [x - S / 2 + r.muzzle[0] * sc, y - S / 2 + r.muzzle[1] * sc];
        g.save(); g.globalAlpha = clamp((GUN_LIFE - age) / 0.2, 0, 1) * clamp(age / 0.03, 0, 1);
        g.drawImage(r.canvas, x - S / 2, y - S / 2, S, S); g.restore();
      } else gun.muzzle ||= [x, y - size * 0.2];   // no WebGL: effects only
    }
    const [mx, my] = gun.muzzle || [x, y];

    if (!gun.casing) {                           // first frame after the shot: casing, smoke, glass crack, sparks
      gun.casing = { x: mx + size * 0.15, y: my, vx: 380 + Math.random() * 200, vy: -620 - Math.random() * 200, rot: 0, vr: 20 + Math.random() * 10 };
      for (let j = 0; j < 8; j++) {
        const a = Math.random() * Math.PI * 2;
        gun.smoke.push({ x: mx, y: my, vx: Math.cos(a) * 70, vy: Math.sin(a) * 70 - 30, r: size * 0.08, d: j * 0.025 });
      }
      cracks.push(makeCrack(mx, my, size * 1.6)); if (cracks.length > 3) cracks.shift();
      spawnSparks(mx, my, 24);
      bursts.push({ x: mx, y: my - size * 0.9, name: "BANG!", t: gun.t, quiet: true });
    }
    for (const p of gun.smoke) {                 // smoke billows out toward the viewer: grows fast, fades
      const a = age - p.d; if (a < 0 || a > 1.4) continue;
      p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= Math.exp(-dt * 2); p.vy -= 25 * dt; p.r += size * 0.35 * dt;
      g.fillStyle = `rgba(205,205,210,${0.3 * (1 - a / 1.4)})`; g.beginPath(); g.arc(p.x, p.y, p.r, 0, 7); g.fill();
    }
    const c = gun.casing;
    if (age < 1) {
      c.vy += 1900 * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.vr * dt;
      const cl = size * 0.11, cw = size * 0.045;
      g.save(); g.translate(c.x, c.y); g.rotate(c.rot);
      const cg = g.createLinearGradient(0, -cw / 2, 0, cw / 2);
      cg.addColorStop(0, "#f6d27a"); cg.addColorStop(0.5, "#c8922c"); cg.addColorStop(1, "#7a5512");
      g.fillStyle = cg; g.fillRect(-cl / 2, -cw / 2, cl, cw);
      g.fillStyle = "#3a2a08"; g.fillRect(-cl / 2, -cw / 2, cl * 0.12, cw);
      g.restore();
    }
    if (age < 0.08) {                            // muzzle flash coming straight at the camera
      const fk = 1 - age / 0.08, R = size * (0.9 + Math.random() * 0.3);
      g.save(); g.globalCompositeOperation = "lighter";
      const rg = g.createRadialGradient(mx, my, 0, mx, my, R * 1.4);
      rg.addColorStop(0, `rgba(255,252,230,${fk})`); rg.addColorStop(0.25, `rgba(255,200,80,${0.85 * fk})`); rg.addColorStop(1, "rgba(255,110,0,0)");
      g.fillStyle = rg; g.beginPath(); g.arc(mx, my, R * 1.4, 0, 7); g.fill();
      g.fillStyle = `rgba(255,240,190,${fk})`; g.beginPath();
      const n = 18;
      for (let j = 0; j <= n * 2; j++) {
        const a = (j / (n * 2)) * Math.PI * 2, rr = j % 2 ? R * 0.18 : R * (0.45 + Math.random() * 0.55);
        g.lineTo(mx + Math.cos(a) * rr, my + Math.sin(a) * rr);
      }
      g.fill(); g.restore();
    }
    if (age < 0.06) { g.fillStyle = `rgba(255,255,255,${0.3 * (1 - age / 0.06)})`; g.fillRect(-40, -40, W + 80, CAM_H + 80); }
  }
  drawCracks(now);
}

// The only way a track changes: playlist click, transport buttons, N/P keys, seek, or the song ending.
// `token` makes rapid clicks safe: only the latest request starts playing.
// Switching tracks like a DJ: while a song plays, the next one comes in on the current song's next beat (so the
// rhythm doesn't break), from its own first beat (not the silence before it), with a short crossfade (no click).
// At most one beat's wait. The song ending, the first Start, and a paused or record-stopped song switch at once.
const SWITCH_FADE = 0.02;                        // s crossfade at the switch
async function play(i, offset = null, { immediate = false } = {}) {
  if (!tracks.length) return;
  const changed = (i + tracks.length) % tracks.length !== idx || !source;
  const prevIdx = idx, prevSrc = source;
  const prev = tracks[prevIdx];                  // (gone if it was just removed from the playlist)
  const quantize = !immediate && prevSrc && !paused && !brake && prev?.grid && prev.bpm;
  idx = (i + tracks.length) % tracks.length;
  const my = ++token;
  if (paused) { paused = false; ctx.resume(); }    // picking a song means "play it"
  renderPlaylist(); updateTransport(0, true);
  let buf;
  try { buf = await decode(idx); }
  catch (err) {                                  // a file that won't decode: say so, keep the current song going
    if (my === token) { log(`Can't play ${tracks[idx].file.name}: ${err.message}`); status(`Can't play ${baseName(tracks[idx].file.name)}.`); }
    return;
  }
  if (my !== token) return;
  if (!tracks[idx].bpm) log(`Tempo: ${(analyse(idx, buf), tracks[idx].bpm)} BPM (echo synced)`); else analyse(idx, buf);
  bpm = tracks[idx].bpm;
  renderPlaylist(); pumpSubs();
  stopRoll(true); brake = null;                  // a new song starts at speed, not inside an old record stop
  // when: now, or on the current song's next beat
  let at = ctx.currentTime + 0.01;
  if (quantize) {
    const g0 = prev.grid, b0 = 60 / prev.bpm, rate = Math.max(0.25, prevSrc.playbackRate.value);
    const pos = songPos + Math.max(0, ctx.currentTime - lastAudioT) * rate;
    let next = g0.phase + Math.ceil((pos - g0.phase) / b0) * b0;
    if ((next - pos) / rate < 0.03) next += b0;    // too close to make it: the beat after
    at = ctx.currentTime + (next - pos) / rate;
  }
  if (offset === null) offset = quantize ? tracks[idx].grid.first : 0;   // a switch comes in on the new song's first beat
  if (prevSrc) {                                  // the old song fades out right at the switch
    const amp = prevSrc.__g;
    prevSrc.onended = () => amp?.disconnect();      // (not "play the next song": this one was replaced)
    if (amp) { amp.gain.setValueAtTime(1, at); amp.gain.linearRampToValueAtTime(0, at + SWITCH_FADE); }
    try { prevSrc.stop(at + SWITCH_FADE + 0.01); } catch {}
  }
  source = ctx.createBufferSource();
  source.buffer = buf;
  source.playbackRate.value = state.speed;
  const sg = ctx.createGain(); sg.gain.setValueAtTime(0, at); sg.gain.linearRampToValueAtTime(1, at + SWITCH_FADE);
  source.connect(sg); sg.connect(songGain); source.__g = sg;
  source.onended = () => { sg.disconnect(); if (my === token) play(idx + 1, 0, { immediate: true }); };   // song finished: on to the next one
  offset = clamp(offset, 0, Math.max(0, buf.duration - 0.05));
  source.start(at, offset);
  songPos = offset; lastAudioT = at;              // the song's clock starts when it really starts
  if (changed) log(`Now playing ${idx + 1}/${tracks.length}: ${tracks[idx].file.name}` + (quantize ? " (on the beat)" : ""));
  updateTransport(0, true);
  prepareNeighbours();
}

// ---------------------------------------------------------------- octaves
// songIn -> (mono) three shifters: octave down / up / two up (tonal part only, exact pitch) -> per-voice EQ + level
// -> stereo (up a hair late on the left, two-up a hair late on the right = width) -> limiter -> volume.
// The up voices also feed a filtered ping-pong echo synced to the tempo. Mono shifters keep the CPU cost down.
function makeOctaves() {
  const mono = ctx.createGain(); mono.channelCount = 1; mono.channelCountMode = "explicit"; songIn.connect(mono);
  const voice = (pitch, hp, lp) => {
    const n = new AudioWorkletNode(ctx, "pitch-shifter", { outputChannelCount: [1], processorOptions: { frame: OCT_FRAME, lookahead: OCT_LOOK } });
    n.parameters.get("pitch").value = pitch; n.parameters.get("formants").value = 0;   // formants bend big shifts off pitch
    n.parameters.get("drums").value = 0;                // tonal part only: no doubled drums
    const h = ctx.createBiquadFilter(); h.type = "highpass"; h.frequency.value = hp; h.Q.value = 0.7;
    const l = ctx.createBiquadFilter(); l.type = "lowpass"; l.frequency.value = lp; l.Q.value = 0.7;
    const amp = ctx.createGain(); amp.gain.value = 0;
    mono.connect(n); n.connect(h); h.connect(l); l.connect(amp);
    return { n, amp };
  };
  const down = voice(0.5, 60, 900), up = voice(2, 350, 9000), up2 = voice(4, 700, 11000);
  const merger = ctx.createChannelMerger(2), haas = ms => { const d = ctx.createDelay(0.05); d.delayTime.value = ms / 1000; return d; };
  down.amp.connect(merger, 0, 0); down.amp.connect(merger, 0, 1);                       // octave down: centre (weight)
  const upL = haas(12); up.amp.connect(upL); upL.connect(merger, 0, 0); up.amp.connect(merger, 0, 1);
  const up2R = haas(9); up2.amp.connect(merger, 0, 0); up2.amp.connect(up2R); up2R.connect(merger, 0, 1);
  // ping-pong echo for the up voices: L delay -> R delay -> back to L, band-limited so repeats stay clean
  const send = ctx.createGain(); send.gain.value = 0; up.amp.connect(send); up2.amp.connect(send);
  const dl = ctx.createDelay(4), dr = ctx.createDelay(4), fb = ctx.createGain(); fb.gain.value = OCT_ECHO_FB;
  const ehp = ctx.createBiquadFilter(); ehp.type = "highpass"; ehp.frequency.value = 500;
  const elp = ctx.createBiquadFilter(); elp.type = "lowpass"; elp.frequency.value = 6000;
  send.connect(ehp); ehp.connect(elp); elp.connect(dl); dl.connect(dr); dr.connect(fb); fb.connect(dl);
  dl.connect(merger, 0, 0); dr.connect(merger, 0, 1);
  const limit = ctx.createDynamicsCompressor(); limit.threshold.value = -12; limit.ratio.value = 6; limit.attack.value = 0.005; limit.release.value = 0.2;
  merger.connect(limit); limit.connect(gain);       // after filter + crush, before the volume
  return { down, up, up2, send, dl, dr };
}

// ---------------------------------------------------------------- record stop
// Constant deceleration like a platter losing power (a linear ramp of the playback rate to 0), then a quick spin-up.
// Everything in the song chain follows the rate, so the pitch falls with it; the song keeps its place.
let brake = null;
function startBrake() {
  if (!source || paused) return;
  stopRoll();
  for (const r of [source.playbackRate, jungle?.src.playbackRate].filter(Boolean)) {   // the break slows down with it
    ramp(r, 0, BRAKE_TIME);
  }
  brake = { up: false };
}
function releaseBrake() {
  const t = ctx.currentTime;
  for (const [r, to] of [[source.playbackRate, state.speed], [jungle?.src.playbackRate, jungleRate()]].filter(p => p[0])) {
    ramp(r, to, SPINUP_TIME);
  }
  brake = { up: true, done: t + SPINUP_TIME };
}

// ---------------------------------------------------------------- laser eyes
// Rare, and only on the beat: now and then (at most once every LASER_GAP s, on average about every LASER_GAP +
// LASER_GAP / 2 s) a kick sets off a burst of LASER_BARS bar(s). During it your eyes glow (a hot red glow with a white
// core and a lens-flare star) and fire laser beams: a full blast on every kick, a smaller shot on every beat, each
// fading out in LASER_DECAY. Outside a burst the eyes look normal. The beams fan out from the eyes, widen with
// distance as if coming at the camera, and follow your head: turn it and they swing. A pistol shot fires them too.
// Toggle with E.
const LASER_DECAY = 0.35, LASER_BEAT = 0.45;      // s for a blast to fade; strength of a plain beat (a kick = 1)
const LASER_GAP = 20, LASER_CHANCE = 0.06, LASER_BARS = 1;   // s between bursts at least; chance per kick after that; bars per burst
const LASER_SPREAD = 0.5, LASER_YAW = 1.6;        // how far the two beams fan apart; how much head turn swings them
let laserOn = true, laserPow = 0, laserUntil = 0, laserLastBurst = -1e9, laserBass = 0, laserKickT = 0, laserBeatIdx = -1, eyesDraw = null;
function laserBeat(now, dt) {                    // per frame: kicks from the analyser's low bins, beats from the song
  laserPow = Math.max(0, laserPow - dt / LASER_DECAY);
  if (!analyser || !source || paused) return;
  const top = Math.max(2, Math.round(140 / (ctx.sampleRate / analyser.fftSize)));
  let b = 0; for (let i = 1; i <= top; i++) b += freqData[i]; b /= top * 255;
  const kick = b > laserBass * 1.3 + 0.04 && b > 0.25 && now - laserKickT > 0.15;
  laserBass += (b - laserBass) * Math.min(1, dt * 3);
  if (kick) {
    laserKickT = now;
    // now and then, a kick starts a burst (only with a face on screen, so it isn't wasted)
    const faceOn = faceNow(now)?.eyes;
    if (now > laserUntil && faceOn && now - laserLastBurst > LASER_GAP && Math.random() < LASER_CHANCE) {
      laserLastBurst = now; laserUntil = now + LASER_BARS * 4 / beatHz();
    }
    if (now < laserUntil) { laserPow = 1; laserSparks = true; }
  }
  if (!brake && now < laserUntil) {
    const bi = Math.floor((songPos - (tracks[idx]?.grid?.phase || 0)) * bpm / 60);   // on the song's own beat grid
    if (bi !== laserBeatIdx) { laserBeatIdx = bi; laserPow = Math.max(laserPow, LASER_BEAT); }
  }
}
let laserSparks = false;
function drawLaserEyes(now, dt) {
  if (!laserOn || !faceNow(now)?.eyes) { eyesDraw = null; laserSparks = false; return; }
  const k = Math.min(1, dt * 18);               // the detector runs ~12x a second: glide between its readings
  eyesDraw = eyesDraw ? eyesDraw.map((e, i) => [e[0] + (face.eyes[i][0] - e[0]) * k, e[1] + (face.eyes[i][1] - e[1]) * k])
                      : face.eyes.map(e => [...e]);
  const [e1, e2] = eyesDraw, ed = Math.max(8, dist(e1, e2)), mid = [(e1[0] + e2[0]) / 2, (e1[1] + e2[1]) / 2];
  const nose = face.nose || [mid[0], mid[1] + ed * 0.6];
  const yaw = (nose[0] - mid[0]) / ed, pitch = (nose[1] - mid[1]) / ed - 0.6;   // ~0, 0 when facing the camera
  const p = laserPow, L = Math.max(W, CAM_H) * 1.6;
  if (p < 0.02) { laserSparks = false; return; }   // no burst: the eyes look normal
  g.save(); g.globalCompositeOperation = "lighter";
  g.globalAlpha = Math.min(1, p * 2);           // the glow comes and goes with the blasts
  for (const e of [e1, e2]) {
    const side = Math.sign(e[0] - mid[0]) || 1;
    let dx = yaw * LASER_YAW + side * LASER_SPREAD, dy = 0.45 + pitch * 1.2;
    const dl = Math.hypot(dx, dy); dx /= dl; dy /= dl;
    const nx = -dy, ny = dx;                     // across the beam
    if (p > 0.04) {                              // the beam: three layers, outer glow -> red -> white-hot core
      const jit = 1 + 0.12 * Math.sin(now * 70 + side * 3);
      const w0 = ed * 0.05 * (0.6 + p), w1 = (ed * 0.12 + ed * 0.75 * p) * jit;
      const ex = e[0] + dx * L, ey = e[1] + dy * L;
      // the red layers are painted over the picture (so they stay red on any background); only the core adds light
      for (const [mul, col, a, op] of [[2.6, "255,0,40", 0.22, "source-over"], [1, "235,10,30", 0.7, "source-over"], [0.32, "255,245,240", 0.95, "lighter"]]) {
        g.globalCompositeOperation = op;
        const gr = g.createLinearGradient(e[0], e[1], ex, ey);
        gr.addColorStop(0, `rgba(${col},${a * p})`); gr.addColorStop(0.6, `rgba(${col},${a * p * 0.6})`); gr.addColorStop(1, `rgba(${col},0)`);
        g.fillStyle = gr; g.beginPath();
        g.moveTo(e[0] + nx * w0 * mul, e[1] + ny * w0 * mul); g.lineTo(ex + nx * w1 * mul, ey + ny * w1 * mul);
        g.lineTo(ex - nx * w1 * mul, ey - ny * w1 * mul); g.lineTo(e[0] - nx * w0 * mul, e[1] - ny * w0 * mul); g.closePath(); g.fill();
      }
      g.globalCompositeOperation = "lighter";
      if (laserSparks) spawnSparks(e[0], e[1], 10, dx, dy, 1.2);
    }
    // the eye itself: retouched into a glowing red orb with a white core, pulsing with the beams
    const r = ed * (0.2 + 0.28 * p);
    const og = g.createRadialGradient(e[0], e[1], 0, e[0], e[1], r * 2.2);
    og.addColorStop(0, "rgba(255,255,255,0.95)"); og.addColorStop(0.18, "rgba(255,120,110,0.9)");
    og.addColorStop(0.45, `rgba(255,20,40,${0.45 + 0.4 * p})`); og.addColorStop(1, "rgba(255,0,40,0)");
    g.fillStyle = og; g.beginPath(); g.arc(e[0], e[1], r * 2.2, 0, 7); g.fill();
    g.save(); g.translate(e[0], e[1]); g.rotate(now * 0.8 * side);   // lens-flare star
    g.fillStyle = `rgba(255,220,220,${0.5 + 0.5 * p})`;
    for (const [lx, ly] of [[ed * (0.7 + 0.9 * p), ed * 0.025], [ed * 0.025, ed * (0.35 + 0.5 * p)]]) g.fillRect(-lx, -ly, lx * 2, ly * 2);
    g.restore();
  }
  laserSparks = false;
  g.restore();
}

// ---------------------------------------------------------------- throw it away
let flight = null, lastQuad = null, lastQuadM = null;
const handTrail = [];                            // recent positions of the two hands' midpoint, for the swing speed
function trackHands(left, right, now) {
  if (!left || !right) return;
  const x = (left.mid[0] + right.mid[0]) / 2, y = (left.mid[1] + right.mid[1]) / 2, last = handTrail[handTrail.length - 1];
  if (last && last.x === x && last.y === y) return;   // a hand kept alive through a missed detection: no new info
  handTrail.push({ t: now, x, y, s: (left.size + right.size) / 2 });
  while (handTrail.length && now - handTrail[0].t > 0.4) handTrail.shift();
}
function swing(now) {                            // hands' velocity over the last THROW_WINDOW (px/s, and hand sizes/s)
  const n = handTrail.length, last = handTrail[n - 1];
  if (n < 2 || now - last.t > 0.2) return null;
  let i = n - 2; while (i > 0 && last.t - handTrail[i].t < THROW_WINDOW) i--;
  const first = handTrail[i], dt = last.t - first.t;
  if (dt < 0.03) return null;
  const vx = (last.x - first.x) / dt, vy = (last.y - first.y) / dt;
  return { vx, vy, speed: Math.hypot(vx, vy) / last.s };
}
// Cut the window out of what was just drawn (device pixels, clipped to its shape) and send it flying.
function throwWindow(v, quad, m) {
  if (!quad) return false;
  const dev = quad.map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
  const xs = dev.map(p => p[0]), ys = dev.map(p => p[1]);
  const bx = Math.floor(Math.min(...xs)) - 4, by = Math.floor(Math.min(...ys)) - 4;
  const bw = Math.ceil(Math.max(...xs)) - bx + 8, bh = Math.ceil(Math.max(...ys)) - by + 8;
  const img = document.createElement("canvas"); img.width = Math.max(1, bw); img.height = Math.max(1, bh);
  const ic = img.getContext("2d");
  ic.beginPath(); dev.forEach(([x, y], i) => i ? ic.lineTo(x - bx, y - by) : ic.moveTo(x - bx, y - by)); ic.closePath(); ic.clip();
  ic.drawImage(canvas, bx, by, bw, bh, 0, 0, bw, bh);
  const k = 1 / Math.hypot(m.a, m.b);             // device px -> canvas units
  const cx = quad.reduce((a, p) => a + p[0], 0) / 4, cy = quad.reduce((a, p) => a + p[1], 0) / 4;
  let vx = v.vx * THROW_BOOST, vy = v.vy * THROW_BOOST;
  const sp = Math.hypot(vx, vy);
  if (sp < THROW_MIN) { const u = sp > 1 ? THROW_MIN / sp : 0; vx = u ? vx * u : (Math.random() < 0.5 ? -1 : 1) * THROW_MIN * 0.7; vy = u ? vy * u : -THROW_MIN * 0.7; }
  const spin = clamp(vx / 350, -THROW_SPIN, THROW_SPIN) + (Math.random() - 0.5) * 3;
  // the picture's centre in its own (device px) frame
  const ox = (m.a * cx + m.c * cy + m.e) - bx, oy = (m.b * cx + m.d * cy + m.f) - by;
  flight = { img, ox, oy, k, x: cx, y: cy, vx, vy, rot: 0, spin, age: 0, trail: [], crashed: false };
  whoosh(ctx.currentTime + 0.005, Math.min(1, sp / 4000));
  spawnSparks(cx, cy, 30, 0, 0, 1.2);
  return true;
}
function drawFlight(dt) {
  if (!flight) return;
  const f = flight;
  f.age += dt; f.vy += THROW_GRAVITY * dt; f.x += f.vx * dt; f.y += f.vy * dt; f.rot += f.spin * dt;
  const sc = 1 + 0.5 * Math.min(f.age / 0.25, 1) - 0.3 * Math.min(f.age, 1);   // pops up as it leaves the hands, then recedes
  f.trail.unshift({ x: f.x, y: f.y, rot: f.rot, sc }); f.trail.length = Math.min(f.trail.length, 6);
  const out = f.x < -300 || f.x > W + 300 || f.y < -400 || f.y > CAM_H + 300;
  if (!f.crashed && (out || f.age > 2.5)) {      // gone: crash where it left the screen
    f.crashed = true;
    const ex = clamp(f.x, 20, W - 20), ey = clamp(f.y, 20, CAM_H - 20);
    crash(ctx.currentTime + 0.005);
    spawnSparks(ex, ey, 90, 0, 0, 2.2);
    bursts.push({ x: clamp(ex, 160, W - 160), y: clamp(ey + 60, 140, CAM_H - 40), name: "GONE", t: performance.now() / 1000 });
    flashUntil = performance.now() / 1000 + FLASH_TIME;
  }
  if (out && f.crashed) { flight = null; return; }
  g.save();
  f.trail.forEach((p, i) => {                     // motion trail: older copies fainter
    g.save(); g.globalAlpha = i ? 0.35 * (1 - i / f.trail.length) : 1;
    g.translate(p.x, p.y); g.rotate(p.rot); g.scale(f.k * p.sc, f.k * p.sc);
    if (!i) { g.shadowColor = "rgba(0,0,0,.5)"; g.shadowBlur = 30; g.shadowOffsetY = 20; }
    g.drawImage(f.img, -f.ox, -f.oy);
    if (!i) { g.shadowColor = "transparent"; g.strokeStyle = "#fff"; g.lineWidth = 3 / (f.k * p.sc); g.strokeRect(-f.ox + 4, -f.oy + 4, f.img.width - 8, f.img.height - 8); }
    g.restore();
  });
  g.restore();
}
let flashUntil = 0;
const FLASH_TIME = 0.12;                         // s of the white hit on a crash
function drawFlash() {                           // a white hit on the crash
  const left = flashUntil - performance.now() / 1000;
  if (left <= 0) return;
  g.save(); g.fillStyle = `rgba(255,255,255,${(left / FLASH_TIME) * 0.5})`; g.fillRect(0, 0, W, CAM_H); g.restore();
}
function whoosh(t, power) {                      // noise swept up through a band-pass: the window flying off
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), a = ctx.createGain();
  s.buffer = noise; f.type = "bandpass"; f.Q.value = 1.4;
  f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(2800 + 2000 * power, t + 0.35);
  a.gain.setValueAtTime(0.0001, t); a.gain.exponentialRampToValueAtTime(0.9 + 0.6 * power, t + 0.12); a.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
  s.connect(f); f.connect(a); a.connect(padBus); s.start(t); s.stop(t + 0.6);
}
function crash(t) {                              // impact: low thump, a burst of noise and a glassy shatter on top
  tone("sine", 120, 32, t, 0.5, 1.6);
  hiss("lowpass", 1400, t, 0.45, 1.3, 0.7);
  hiss("highpass", 5200, t + 0.01, 0.35, 0.7, 0.6);
  for (let i = 0; i < 6; i++) tone("triangle", 2400 + Math.random() * 3000, 1800, t + 0.03 + i * 0.035, 0.08, 0.12);
}

// ---------------------------------------------------------------- beat roll
// A second player loops a slice of the song starting where you are now, while the real song keeps running muted.
// Each slice is copied into its own small buffer with ~2 ms fades at both ends, so the repeats don't click.
// Slices are whole fractions of a beat and each step lasts a whole bar, so every step change lands exactly on a
// repeat boundary (the new, shorter slice starts there) and the repeats stay on the beat.
let roll = null;
const rollSlice = step => ROLL_STEPS[step] * 60 / bpm;   // seconds of song (bpm is the track's own tempo)
function sliceBuffer(buf, start, secs) {
  const sr = buf.sampleRate, a = Math.floor(start * sr), n = Math.max(2, Math.round(secs * sr));
  const out = ctx.createBuffer(buf.numberOfChannels, n, sr), fade = Math.min(Math.round(0.002 * sr), n >> 3);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = out.getChannelData(c); d.set(buf.getChannelData(c).subarray(a, a + n));
    for (let i = 0; i < fade; i++) { const k = 0.5 - 0.5 * Math.cos(Math.PI * i / fade); d[i] *= k; d[n - 1 - i] *= k; }
  }
  return out;
}
function rollPlayer(step, t) {                   // a looping player for one step, starting at ctx time t
  const src = ctx.createBufferSource();
  src.buffer = sliceBuffer(source.buffer, roll.start, rollSlice(step)); src.loop = true;
  src.playbackRate.value = state.speed; src.connect(roll.amp); src.start(t);
  return { src, t, period: src.buffer.duration / state.speed };
}
function startRoll() {
  if (roll || !source || paused) return;
  const t = ctx.currentTime + 0.01, buf = source.buffer, rate = source.playbackRate.value;
  const start = clamp(songPos + (t - lastAudioT) * rate, 0, Math.max(0, buf.duration - rollSlice(0) - 0.01));
  const amp = ctx.createGain(); amp.connect(songIn);
  roll = { amp, start, step: 0, beats: 0, lastT: t };
  roll.p = rollPlayer(0, t);
  ramp(songGain.gain, 0, ROLL_FADE, 1, t);
}
function updateRoll() {                          // per frame: count beats held, shorten the slice every bar
  if (!roll) return;
  const t = ctx.currentTime;
  if (t > roll.lastT) { roll.beats += (t - roll.lastT) * beatHz(); roll.lastT = t; }
  const step = Math.min(Math.floor(roll.beats / ROLL_BEATS_PER_STEP), ROLL_STEPS.length - 1);
  if (step === roll.step) return;
  // switch on the next repeat boundary of the current player (a bar boundary, so at most a frame away)
  const p = roll.p, at = p.t + Math.ceil((t + 0.005 - p.t) / p.period) * p.period;
  p.src.stop(at); roll.step = step; roll.p = rollPlayer(step, at);
}
function stopRoll(immediate) {
  if (!roll) return;
  const t = ctx.currentTime, { amp, p } = roll, fade = immediate ? 0.001 : ROLL_FADE;
  ramp(amp.gain, 0, fade, 1);
  ramp(songGain.gain, 1, fade, 0);
  p.src.stop(t + fade + 0.02); p.src.onended = () => amp.disconnect();
  roll = null;
}
// the roll players follow the speed control like the song does
const rollRate = t => { if (roll) roll.p.src.playbackRate.setTargetAtTime(state.speed, t, SPEED_GLIDE); };

const nextTrack = () => play(idx + 1);
const prevTrack = () => songPos > 3 ? play(idx, 0) : play(idx - 1);   // like any music player
function togglePause() {
  if (!source) return;
  if (brake?.thrown) { releaseBrake(); updateTransport(0, true); return; }   // thrown away: play = bring it back
  paused = !paused; paused ? ctx.suspend() : ctx.resume();
  updateTransport(0, true);
}
const baseName = name => name.replace(/\.[^.]+$/, "");   // "song.mp3" -> "song"
let lastTransport = 0;
function updateTransport(now, force) {
  if (!force && now - lastTransport < 0.2) return;
  lastTransport = now;
  const dur = source?.buffer?.duration || 0, on = started && !!source;
  $("now").textContent = tracks.length && on ? `${paused ? "Paused" : brake?.thrown ? "Thrown away" : "Playing"} ${idx + 1}/${tracks.length}: ${baseName(tracks[idx].file.name)}` : "Nothing playing";
  $("seekfill").style.width = dur ? `${clamp(songPos / dur, 0, 1) * 100}%` : "0";
  $("tcur").textContent = fmtTime(Math.min(songPos, dur)); $("tdur").textContent = fmtTime(dur);
  $("pp").textContent = paused ? "▶" : "⏸";
  $("lcdBpm").textContent = on ? `${Math.round(bpm * state.speed)} BPM` : "";
  for (const id of ["prev", "pp", "next"]) $(id).disabled = !on;
}
$("prev").onclick = e => { e.currentTarget.blur(); prevTrack(); };   // blur: Space must not re-click the button
$("next").onclick = e => { e.currentTarget.blur(); nextTrack(); };
$("pp").onclick = e => { e.currentTarget.blur(); togglePause(); };
$("seek").onclick = e => {
  if (!source) return;
  const f = e.offsetX / e.currentTarget.clientWidth;
  play(idx, f * source.buffer.duration, { immediate: true });   // seeking jumps right away
};

// ---------------------------------------------------------------- subtitles
// Song position in seconds of the original track: integrates the live playback rate, so it stays in sync
// through speed changes and pauses (a suspended AudioContext stops its clock).
let songPos = 0, lastAudioT = 0;
let warnedKeys = false, subsBusy = false;
// Subtitles need the OpenAI key (it both hears the lyrics and translates them).
function keyProblem() {
  const o = openaiKey.get();
  if (!o) return "No OpenAI key: paste one in Settings";
  if (o.startsWith("sk-ant-")) return "That's an Anthropic key: subtitles need an OpenAI key (sk-...)";
  return null;
}
const SUB_LABEL = { transcribing: "transcribing…", translating: "translating…", ready: "中文 + RU ✓", none: "no vocals", error: "subs failed" };

// After Start, every song in the playlist gets subtitles, one at a time: the playing song first, then the rest in order.
function pumpSubs() {
  if (subsBusy || !started || !tracks.length || !$("subs").checked) return;
  const problem = keyProblem();
  if (problem) {
    if (!warnedKeys) { warnedKeys = true; log(`Subtitles: ${problem}`); }
    return;
  }
  const t = [tracks[idx], ...tracks].find(x => !x.sub);
  if (!t) return;
  const file = t.file, cached = cachedSubs(file);
  if (cached) { t.subs = cached; t.sub = cached.length ? "ready" : "none"; renderPlaylist(); pumpSubs(); return; }
  subsBusy = true; t.sub = "transcribing"; renderPlaylist();
  // decode without keeping it in memory unless the player already has it (decoded songs are ~10 MB per minute)
  Promise.resolve().then(() => t.buf || file.arrayBuffer().then(b => ctx.decodeAudioData(b)))   // any error -> "subs failed", queue moves on
    .then(buf => loadSubs(file, buf, { log, onStage: stage => { t.sub = stage; renderPlaylist(); } }))
    .then(subs => { t.subs = subs; t.sub = subs.length ? "ready" : "none"; },
          err => { console.error(err); log(`Subtitles failed: ${err.message}`); t.subError = err.message; t.sub = "error"; })
    .then(() => { subsBusy = false; renderPlaylist(); pumpSubs(); });
}

// a small list button (✕ remove, + add) that doesn't also click its row
function rowButton(cls, text, tip, fn) {
  const b = document.createElement("button");
  b.className = cls; b.textContent = text; b.title = tip; b.setAttribute("aria-label", tip);
  b.onclick = e => { e.stopPropagation(); b.blur(); fn(); };
  return b;
}
const isPlaying = i => started && !!source && i === idx;

function renderPlaylist() {
  $("playlist").replaceChildren(...tracks.map((t, i) => {
    const li = document.createElement("li"), name = document.createElement("span"), sub = document.createElement("span");
    name.className = "name"; name.textContent = `${i + 1}. ${baseName(t.file.name)}`; name.title = t.file.name;
    sub.className = "sub " + (t.sub || ""); sub.textContent = $("subs").checked ? SUB_LABEL[t.sub] || "" : "";
    if (t.sub === "error" && t.subError) sub.title = t.subError;   // hover the "subs failed" tag for the reason
    li.append(name, sub);
    if (!isPlaying(i)) li.append(rowButton("x", "✕", "Remove from the playlist", () => removeTrack(i)));
    if (i === idx && started) li.className = "on";
    li.onclick = () => {
      if (started) play(i);
      else { idx = i; renderPlaylist(); }        // Start will begin from this song
    };
    return li;
  }));
  $("plEmpty").hidden = $("demo").hidden = tracks.length > 0;
  $("plCount").textContent = tracks.length ? `${tracks.length} song${tracks.length === 1 ? "" : "s"}` : "";
  $("start").disabled = !tracks.length || started;
  renderLibrary();
  if (!started) drawIntro();
}

// ---------------------------------------------------------------- song library
// Songs you add are kept in the browser (library.js); the playlist is saved as their ids and comes back next time.
let songs = [];                                  // the library: { id, file }
let libraryOk = true;                            // false: no IndexedDB here, songs last for this session only
const savePlaylist = () => store.set("handdj.playlist", JSON.stringify(tracks.map(t => t.id)));

function addToPlaylist(list) {
  const have = new Set(tracks.map(t => t.id));
  const fresh = list.filter(x => !have.has(x.id) && have.add(x.id));   // (add: a song picked twice goes in once)
  tracks.push(...fresh.map(x => newTrack(x.file, x.id)));
  savePlaylist(); renderPlaylist();
  if (started && fresh.length) { log(`Added ${fresh.length} song${fresh.length === 1 ? "" : "s"} to the playlist`); pumpSubs(); }
  return fresh.length;
}
function removeTrack(i) {
  if (isPlaying(i)) return;                      // the song you hear stays (switch to another one first)
  tracks.splice(i, 1);
  if (i < idx || idx >= tracks.length) idx = Math.max(0, idx - 1);
  savePlaylist(); renderPlaylist();
}
async function deleteSong(song) {
  const i = tracks.findIndex(t => t.id === song.id);
  if (isPlaying(i)) { status("That song is playing: switch to another one first."); return; }
  if (!confirm(`Delete "${baseName(song.file.name)}" from the library?`)) return;
  try { await library.remove(song.id); } catch (err) { status(`Couldn't delete: ${err.message}`); return; }
  songs = songs.filter(x => x !== song);
  if (i >= 0) removeTrack(i); else renderLibrary();
}

function renderLibrary() {
  const q = $("libSearch").value.trim().toLowerCase(), inList = new Set(tracks.map(t => t.id));
  const shown = songs.filter(x => !q || x.file.name.toLowerCase().includes(q));
  $("library").replaceChildren(...shown.map(x => {
    const li = document.createElement("li"), name = document.createElement("span"), on = inList.has(x.id);
    name.className = "name"; name.textContent = baseName(x.file.name); name.title = x.file.name;
    const add = rowButton("add", "+", "Add to the playlist", () => addToPlaylist([x]));
    add.disabled = on;
    li.append(name, add, rowButton("x", "✕", "Delete from the library", () => deleteSong(x)));
    li.className = on ? "in" : "";
    li.onclick = () => addToPlaylist([x]);
    return li;
  }));
  $("libCount").textContent = songs.length ? (q ? `${shown.length} of ${songs.length}` : `${songs.length}`) : "";
  $("libEmpty").hidden = songs.length > 0;
  $("libEmpty").textContent = libraryOk ? "Songs you add stay here, in this browser." : "Can't keep songs in this browser: they last until you close the tab.";
}
$("libSearch").oninput = renderLibrary;

// the demo song (demo.js): made on demand, not stored; a saved playlist with it in makes it again
let demoFile = null;
const demoSong = async () => ({ id: DEMO_ID, file: demoFile ||= await makeDemoSong() });
$("demo").onclick = async e => {
  const b = e.currentTarget; b.blur(); b.disabled = true; b.textContent = "♪ Making the demo...";
  try { addToPlaylist([await demoSong()]); if (!started) status("Demo ready: ▶ Start."); }
  catch (err) { console.error(err); status(`Couldn't make the demo song: ${err.message}`); }
  finally { b.disabled = false; b.textContent = "♪ Try the demo song"; }
};

$("files").onchange = async e => {
  const files = [...e.target.files]; e.target.value = "";   // reset so the same file can be picked again later
  let added = files.map(f => ({ id: songId(f), file: f }));
  if (libraryOk) {
    try { added = await library.add(files); }
    catch (err) { console.warn("library:", err); status("Couldn't keep these songs in the browser (disk full?): they're in the playlist for now."); }
  }
  const known = new Set(songs.map(x => x.id));
  songs.push(...added.filter(x => !known.has(x.id) && known.add(x.id)));   // the library lists each song once
  songs.sort((x, y) => x.file.name.localeCompare(y.file.name, undefined, { numeric: true }));
  const n = addToPlaylist(added);
  if (!started) status(tracks.length ? "Click a song to start from it, then ▶ Start." : "");
  else if (!n) status("Those songs are in the playlist already.");
};

// the library and the last playlist come back from the browser's storage
(async () => {
  try { songs = await library.all(); } catch (err) { libraryOk = false; console.warn("library unavailable:", err); }
  let ids = [];
  try { ids = JSON.parse(store.get("handdj.playlist") || "[]"); } catch { /* a broken entry: start empty */ }
  const byId = new Map(songs.map(x => [x.id, x]));
  if (ids.includes(DEMO_ID)) try { byId.set(DEMO_ID, await demoSong()); } catch (err) { console.warn("demo song:", err); }
  if (!tracks.length) addToPlaylist(ids.map(id => byId.get(id)).filter(Boolean));
  renderPlaylist();
})();

// Before Start: what to do, drawn where the video will be.
function drawIntro() {
  const tall = $("layout").value === "tall";
  canvas.width = tall ? 1080 : 1280; canvas.height = tall ? 1920 : 900;
  const w = canvas.width, h = canvas.height, step = tracks.length ? 2 : 1;
  g.save();
  g.fillStyle = "#0a0a0d"; g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(61,255,134,.07)"; g.lineWidth = 1;   // faint LCD grid
  for (let x = 0; x < w; x += 24) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = 0; y < h; y += 24) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = "bold 96px Menlo, Consolas, monospace"; g.fillStyle = "#e9c46a"; g.shadowColor = "rgba(233,196,106,.5)"; g.shadowBlur = 24;
  g.fillText("AIR DJ", w / 2, h * 0.36);
  g.font = "40px Menlo, Consolas, monospace"; g.shadowColor = "rgba(61,255,134,.6)"; g.shadowBlur = 14;
  [["1", "+ Add songs or ♪ the demo"], ["2", "▶ Start"]].forEach(([n, text], k) => {
    const on = step === k + 1;
    g.fillStyle = on ? "#3dff86" : "#1d7a45";
    g.fillText(`${n} · ${text}${on ? "  ◂" : ""}`, w / 2, h * 0.5 + k * 70);
  });
  g.shadowBlur = 0; g.font = "24px Menlo, Consolas, monospace"; g.fillStyle = "#6b7080";
  g.fillText("then show your hands to the camera", w / 2, h * 0.5 + 170);
  g.restore();
}

function drawSubtitles() {
  if (!$("subs").checked) return;
  // (progress and problems show in the playlist, not here: nothing but the lyrics ends up in the video)
  const heard = songPos - songDelay;            // what you hear lags the source a bit
  const l = lineAt(tracks[idx]?.subs, heard);
  if (!l) return;
  g.save();
  g.globalAlpha = clamp(Math.min(heard - l.s, l.e - heard) / 0.15, 0, 1);   // quick fade in/out
  g.textAlign = "center"; g.textBaseline = "alphabetic"; g.lineJoin = "round";
  const row = (text, y, font, fill, outline) => {
    g.font = font; g.strokeStyle = "rgba(0,0,0,.85)"; g.lineWidth = outline; g.strokeText(text, W / 2, y);
    g.fillStyle = fill; g.fillText(text, W / 2, y);
  };
  const SRC_FONT = "500 26px -apple-system, Helvetica, Arial, sans-serif";
  const ZH_FONT = '700 56px "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
  const RU_FONT = "700 38px -apple-system, Helvetica, Arial, sans-serif";
  // bottom up: original line (small), Russian (medium), Chinese (large)
  g.font = SRC_FONT; const src = wrap(g, l.src, W - 120).slice(0, 2);
  g.font = RU_FONT; const ru = l.ru ? wrap(g, l.ru, W - 100).slice(0, 2) : [];
  g.font = ZH_FONT; const zh = l.zh ? wrap(g, l.zh, W - 100).slice(0, 2) : [];
  let y = CAM_H - 36;
  for (const t of src.reverse()) { row(t, y, SRC_FONT, "rgba(230,230,235,.92)", 5); y -= 34; }
  y -= 14;
  for (const t of ru.reverse()) { row(t, y, RU_FONT, "#ffe9a8", 7); y -= 46; }
  y -= 14;
  for (const t of zh.reverse()) { row(t, y, ZH_FONT, "#fff", 9); y -= 66; }
  g.restore();
}

// state.filterStep is a step index. Neutral = the step where the song plays untouched: top of the low-pass, bottom of the bass cut
const cutoffHz = () => LOWPASS_STEPS[clamp(state.filterStep, 0, FILTER_OPEN)];
const filterLabel = () => state.filterStep === FILTER_OPEN ? "OPEN" : `${cutoffHz()} Hz`;

function applyAudio() {
  if (!source) return;
  const t = ctx.currentTime;
  if (!brake) source.playbackRate.setTargetAtTime(state.speed, t, SPEED_GLIDE);   // the record stop drives it itself
  rollRate(t);
  const bt = state.bassOn ? BASS_IN / 3 : BASS_OUT / 3;   // bass boost swells in / eases out
  bassShelf.gain.setTargetAtTime(state.bassOn ? BASS_SHELF_DB : 0, t, bt);
  bassPunch.gain.setTargetAtTime(state.bassOn ? BASS_PUNCH_DB : 0, t, bt);
  bassTrim.gain.setTargetAtTime(state.bassOn ? BASS_TRIM : 1, t, bt);
  bassMud.gain.setTargetAtTime(state.bassOn ? BASS_MUD_DB : 0, t, bt);
  bassGrit.gain.setTargetAtTime(state.bassOn ? BASS_GRIT : 0, t, bt);
  if (oct) {
    const st = OCT_STEPS[state.oct], on = state.octOn, tc = OCT_FADE / 3;
    for (const [v, ratio, lvl] of [[oct.down, 0.5, st.down], [oct.up, 2, st.up], [oct.up2, 4, st.up2]]) {
      v.n.parameters.get("pitch").setTargetAtTime(ratio, t, 0.02);
      v.amp.gain.setTargetAtTime(on ? lvl : 0, t, tc);
    }
    oct.send.gain.setTargetAtTime(on ? st.echo : 0, t, tc);           // echo tails ring out after release
    const echoT = clamp(OCT_ECHO_BEATS / beatHz(), 0.05, 3.9);
    oct.dl.delayTime.setTargetAtTime(echoT, t, 0.05); oct.dr.delayTime.setTargetAtTime(echoT, t, 0.05);
    songGain.gain.setTargetAtTime(roll ? 0 : on ? st.duck : 1, t, 0.05);
  }
  if (crusher) {
    const c = CRUSH_STEPS[state.crush];
    crusher.parameters.get("bits").setValueAtTime(c.bits, t);
    crusher.parameters.get("rate").setValueAtTime(c.rate, t);
  }
  filter.frequency.setTargetAtTime(cutoffHz(), t, FILTER_GLIDE);
  gain.gain.setTargetAtTime(state.vol / VOL_DEFAULT, t, 0.03);   // the default volume plays the song as it is

  // echo time follows the track tempo *and* the current speed, so repeats stay on the beat
  const beats = +$("echo").value;
  const amt = beats ? state.echo : 0;
  if (beats) echoDelay.delayTime.setTargetAtTime(clamp(beats / beatHz(), 0.02, 7.9), t, 0.08);
  echoSend.gain.setTargetAtTime(amt, t, 0.05);
  echoFb.gain.setTargetAtTime(0.35 + 0.3 * amt, t, 0.05);
}

// ---------------------------------------------------------------- hands
let landmarker;
async function setupHands() {
  const fileset = await FilesetResolver.forVisionTasks("./vendor/wasm");
  const make = delegate => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "./vendor/hand_landmarker.task", delegate },
    runningMode: "VIDEO", numHands: 2,
    // lower thresholds keep the tracker locked on big / partly out-of-frame hands up close
    minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.3, minTrackingConfidence: 0.3,
  });
  try { landmarker = await make("GPU"); } catch { landmarker = await make("CPU"); }
  // face detector for the face-warp scene; optional, the app runs fine without it
  const makeFace = delegate => FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "./vendor/blaze_face_short_range.tflite", delegate }, runningMode: "VIDEO", minDetectionConfidence: 0.5,
  });
  try { faceDetector = await makeFace("GPU"); } catch { faceDetector = await makeFace("CPU").catch(err => (console.warn("face detector failed:", err), null)); }
}
// the detected face in canvas coords, eased so the warp doesn't jitter; null when no face for a moment
const FACE_HOLD = 0.5;                           // s a face counts as still there after it was last detected
const faceNow = now => face && now - faceSeen < FACE_HOLD ? face : null;
let faceDetector, face = null, faceSeen = 0, lastFaceMs = 0;
function updateFace(nowMs) {
  if (!faceDetector || nowMs - lastFaceMs < 80) return;   // ~12 checks a second is plenty
  lastFaceMs = nowMs;
  const det = faceDetector.detectForVideo(video, nowMs).detections?.[0];
  const now = nowMs / 1000;
  if (det) {
    const bb = det.boundingBox, [x, y] = toCanvas({ x: (bb.originX + bb.width / 2) / video.videoWidth, y: (bb.originY + bb.height / 2) / video.videoHeight });
    const r = Math.max(bb.width, bb.height) * crop.s * 0.85;
    if (!face || now - faceSeen > FACE_HOLD) face = { x, y, r };
    else { face.x += (x - face.x) * 0.5; face.y += (y - face.y) * 0.5; face.r += (r - face.r) * 0.3; }
    const kp = det.keypoints;                   // BlazeFace: 0 / 1 eyes, 2 nose tip (normalized to the video)
    if (kp?.length >= 3) { face.eyes = [toCanvas(kp[0]), toCanvas(kp[1])]; face.nose = toCanvas(kp[2]); }
    faceSeen = now;
  } else if (face && now - faceSeen > FACE_HOLD) face = null;
}

let crop = { s: 1, x0: 0, y0: 0 };
function toCanvas(p) {                       // mirrored, cover-cropped
  return [(1 - p.x) * video.videoWidth * crop.s - crop.x0, p.y * video.videoHeight * crop.s - crop.y0];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// Pinch uses MediaPipe's metric 3D world landmarks: independent of distance to camera,
// unaffected by the hand tilting toward the lens, and still valid when the wrist is cropped off.
function handInfo(lm, wl, hd) {
  const thumb = toCanvas(lm[4]), index = toCanvas(lm[8]), palm = toCanvas(lm[9]);
  const size = Math.max(dist(toCanvas(lm[5]), toCanvas(lm[17])), dist(toCanvas(lm[0]), palm)) + 1e-6;  // on-screen hand size
  const palmLen = wl ? d3(wl[0], wl[9]) + 1e-6 : 0;
  const gap = f => wl ? d3(wl[4], wl[f]) / palmLen : dist(thumb, toCanvas(lm[f])) / size;   // thumb tip to fingertip f
  const tipGap = { 8: gap(8), 12: gap(12), 16: gap(16), 20: gap(20) };
  const tips = { 12: toCanvas(lm[12]), 16: toCanvas(lm[16]), 20: toCanvas(lm[20]) };
  // finger pistol grip: middle folded, ring or pinky folded and the other at least loosely (a fingertip nearer the
  // wrist than its middle joint, with some slack: real finger guns rarely clench every finger)
  const D = wl ? (i, j) => d3(wl[i], wl[j]) : (i, j) => dist(toCanvas(lm[i]), toCanvas(lm[j]));
  const fold = (tip, pip, slack) => D(0, tip) < slack * D(0, pip);
  const curled = fold(12, 10, PISTOL_CURL) && fold(16, 14, PISTOL_CURL_LOOSE) && fold(20, 18, PISTOL_CURL_LOOSE)
              && (fold(16, 14, PISTOL_CURL) || fold(20, 18, PISTOL_CURL));
  const reach = D(0, 8) / D(0, 5);               // index tip to wrist / index knuckle to wrist: ~1.9 straight, ~1.1 bent
  const indexOut = reach > PISTOL_OUT && D(0, 8) > 1.05 * D(0, 6);
  // the pose: grip + index out, and the thumb not on the ring / pinky tip (those are drum pads with the others folded)
  const pistol = curled && indexOut && Math.min(tipGap[16], tipGap[20]) > PISTOL_PAD_CLEAR;
  // trigger: index tip onto the folded middle finger (gap relative to the palm), or the index bent down
  const unit = wl ? palmLen : size;
  const trig = Math.min(D(8, 10), D(8, 11), D(8, 12)) / unit;
  const pulled = trig < PISTOL_ON || reach < PISTOL_BENT;
  // fist: every fingertip curled back to the palm (closer to the wrist than its own knuckle). A closed pinch doesn't
  // count: the index points forward, so its tip stays well past the knuckle.
  const fist = [8, 12, 16, 20].every(f => D(0, f) < 1.1 * D(0, f - 3));
  return { thumb, index, palm, size, tipGap, tips, curled, pistol, trig, pulled, indexOut, fist, label: hd?.[0]?.categoryName, labelScore: hd?.[0]?.score ?? 0 };
}

// One Euro filter: heavy smoothing when still (kills jitter), light when moving fast (no lag).
class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1) { Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: null, t: 0 }); }
  filter(v, t) {
    const arr = Array.isArray(v) ? v : [v];
    if (this.x === null) { this.x = arr.slice(); this.dx = arr.map(() => 0); this.t = t; return v; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    const alpha = fc => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
    const ad = alpha(this.dCutoff);
    arr.forEach((a, i) => { this.dx[i] += ad * ((a - this.x[i]) / dt - this.dx[i]); });
    const ax = alpha(this.minCutoff + this.beta * Math.hypot(...this.dx));
    arr.forEach((a, i) => { this.x[i] += ax * (a - this.x[i]); });
    return Array.isArray(v) ? this.x.slice() : this.x[0];
  }
}
const makeFilters = () => ({ thumb: new OneEuro(1.5, 0.007), index: new OneEuro(1.5, 0.007),
                            palm: new OneEuro(1.5, 0.007), size: new OneEuro(1, 0),
                            n: new OneEuro(...PINCH_SMOOTH) });
// the right hand (pitch) has its own, more sensitive range: fully open at a gap people actually reach, and evenly spread,
// so each filter step takes the same small change in thumb-to-index distance
const pinchValue = (k, gap) => k === "R" ? norm(gap, PINCH_CLOSED, R_PINCH_OPEN)
                                         : norm(gap, PINCH_CLOSED, PINCH_OPEN) ** PINCH_CURVE;

const sides = { L: { hand: null, seen: -1, f: null }, R: { hand: null, seen: -1, f: null } };
const alive = (k, now) => sides[k].hand && now - sides[k].seen < LOST_GRACE ? sides[k].hand : null;

// MediaPipe's handedness label assumes a mirrored image; our detector input isn't, so by default its "Left" is
// the user's right hand. Learn the actual mapping whenever both hands are on screen (positions are unambiguous then),
// and remember it between sessions so a camera that already mirrors gets fixed for good.
let flipVote = 0;                              // >0: "Left" label = user's right hand
flipVote = +store.get("handdj.flipVote") || 0;
const sideFromLabel = l => (l === "Left") === (flipVote >= 0) ? "R" : "L";

// A lone hand's side is a running vote, not a per-frame guess: the handedness label wobbles when the hand turns
// sideways or shows its back (common mid-pinch), so one bad frame must never flip speed <-> pitch.
// Evidence: handedness label (weighted by confidence) + a small nudge from which half of the screen the hand is in.
// Range -1 (right) .. +1 (left). The vote is a true running mean for the first SIDE_WINDOW frames (so early noise
// averages out instead of locking in), then a slow moving average; the side flips only past a small hysteresis.
const SIDE_WINDOW = 25, SIDE_HYST = 0.1;
const lone = { side: null, ev: 0, n: 0 };
function frameEvidence(h) {
  let e = 0;
  if (h.label) e += (sideFromLabel(h.label) === "L" ? 1 : -1) * clamp((h.labelScore - 0.5) * 2, 0, 1);
  e += 0.3 * clamp((W / 2 - h.palm[0]) / (W / 2), -1, 1);    // left half of the (mirrored) screen leans "left hand"
  return clamp(e, -1, 1);
}

// Decide which detected hand is left/right. Two hands: by screen position. One hand: continue its existing track,
// otherwise start a new vote from this frame's evidence.
// two readings close enough (within 2.5 hand sizes) to be the same hand
const sameHand = (a, b) => dist(a.palm, b.palm) < 2.5 * Math.max(a.size, b.size);
function assignSides(raw, now) {
  if (raw.length >= 2) {
    raw.sort((p, q) => p.palm[0] - q.palm[0]);
    const a = raw[0], b = raw[raw.length - 1];
    if (a.label && b.label && a.label !== b.label) {
      const was = flipVote;
      flipVote = clamp(flipVote + (a.label === "Right" ? 1 : -1), -30, 30);
      if (flipVote !== was) store.set("handdj.flipVote", String(flipVote));   // only when it changed
    }
    lone.side = null;
    return { L: a, R: b };
  }
  if (!raw.length) { lone.side = null; return {}; }
  const h = raw[0], pl = alive("L", now), pr = alive("R", now), e = frameEvidence(h);
  const near = p => p && sameHand(p, h);
  // which existing track (if any) is this hand?
  const cont = near(pl) && near(pr) ? (dist(pl.palm, h.palm) <= dist(pr.palm, h.palm) ? "L" : "R")
             : near(pl) ? "L" : near(pr) ? "R" : null;
  if (cont && lone.side === cont) {                                          // same lone hand: keep voting
    lone.n++; lone.ev += (e - lone.ev) / Math.min(lone.n, SIDE_WINDOW);
  } else if (cont) { lone.side = cont; lone.ev = cont === "L" ? 0.6 : -0.6; lone.n = SIDE_WINDOW; }   // other hand just left: trust the 2-hand split
  else { lone.side = e >= 0 ? "L" : "R"; lone.ev = e; lone.n = 1; }          // brand-new hand
  const thr = lone.n < 5 ? 0 : SIDE_HYST;
  if (lone.side === "L" && lone.ev < -thr) lone.side = "R";
  else if (lone.side === "R" && lone.ev > thr) lone.side = "L";
  const k = lone.side, other = k === "L" ? "R" : "L", o = sides[other].hand;
  if (o && sameHand(o, h)) sides[other].hand = null;   // no ghost of it on the other side
  return { [k]: h };
}

function updateSide(k, h, now) {
  if (!h) return;
  const s = sides[k];
  if (!s.f || now - s.seen > LOST_GRACE) { s.f = makeFilters(); s.pad = null; s.held = undefined; s.fistN = 0; s.freeze = 0; }   // a returning hand starts fresh
  // finger pistol (right hand only): armed while the finger-gun pose is held (and a grace period, since pulling the
  // trigger bends the index out of the pose). Fires when the trigger is pulled (index bent down or onto the middle
  // finger); noise can't fire it because the pull has to last PISTOL_FRAMES frames, the other fingers must stay folded,
  // and the index must straighten again (past PISTOL_OFF) before the next shot.
  // With both hands on screen only the right one shoots. A hand alone on screen always can: which side a lone hand
  // is gets guessed from the tracker's handedness label, and that label is unreliable for a finger gun (the hand is
  // turned sideways), so a lone right hand is often taken for the left.
  const gunHand = k === "R" || lone.side === k;
  const ps = s.pistol ||= { armedUntil: 0, last: 0, low: 0, cocked: false };
  if (gunHand && h.pistol) { ps.armedUntil = now + PISTOL_ARM; if (h.trig > PISTOL_OFF) ps.cocked = true; }
  const armed = gunHand && now < ps.armedUntil && h.curled;
  ps.low = armed && h.pulled ? ps.low + 1 : 0;
  if (armed && ps.cocked && ps.low >= PISTOL_FRAMES && now - ps.last > PISTOL_COOLDOWN) {
    ps.cocked = false; ps.last = now; shootPistol(k, h);
  }
  if (armed) s.freeze = now + FREEZE_TIME;            // the trigger pull moves the index: don't let it shift key/pitch

  // drum pads: thumb touching middle/ring/pinky tip (and clearly closer to it than to the index tip)
  const pads = Object.keys(PADS[k]).map(Number);
  if (s.pad && h.tipGap[s.pad] > PAD_OFF_F[s.pad]) s.pad = null;
  // the thumb has to be clearly nearer this fingertip than the other pad fingertips: on its way to the ring finger it
  // brushes past the middle one, and that must not count as a middle-finger hit
  const clearest = f => pads.every(o => o === f || h.tipGap[f] < PAD_CLEAR * h.tipGap[o]);
  if (s.pad && HOLD_PADS.has(PADS[k][s.pad]) && now - s.padT < PAD_SWITCH) {   // a hold that just started: if the
    const better = pads.find(f => f !== s.pad && h.tipGap[f] < PAD_ON_F[f] && clearest(f));   // thumb slid on to another
    if (better) { s.pad = better; s.padT = now; if (!HOLD_PADS.has(PADS[k][better])) firePad(k, better, h.tips[better]); }
  }
  s.fistN = h.fist ? (s.fistN || 0) + 1 : 0;
  if (h.fist) s.freeze = now + FREEZE_TIME;            // a fist moves every finger: hold key / filter / crush still
  if (!s.pad && !armed && !h.fist) {
    const hit = pads.filter(f => h.tipGap[f] < PAD_ON_F[f] && h.tipGap[8] > 1.8 * h.tipGap[f] && clearest(f))
                    .sort((a, b) => h.tipGap[a] - h.tipGap[b])[0];
    if (hit) { s.pad = hit; s.padT = now; if (!HOLD_PADS.has(PADS[k][hit])) firePad(k, hit, h.tips[hit]); }   // holds: see frame()
  }
  // hold speed/pitch steady while the thumb is reaching for a pad, so drumming doesn't wreck the mix
  if (s.pad || pads.some(f => h.tipGap[f] < 0.6 && h.tipGap[8] > 1.5 * h.tipGap[f])) s.freeze = now + FREEZE_TIME;
  const frozen = s.hand && now < (s.freeze || 0);

  // backlash deadband: the value only moves once the pinch has moved more than DEADBAND, then follows without a jump
  const fn = clamp(s.f.n.filter(pinchValue(k, h.tipGap[8]), now), 0, 1);
  if (s.held === undefined || !s.hand) s.held = fn;
  else if (Math.abs(fn - s.held) > DEADBAND) s.held = fn - Math.sign(fn - s.held) * DEADBAND;
  if (fn <= 0.005 || fn >= 0.995) s.held = fn;                     // still reach the very ends
  const thumb = s.f.thumb.filter(h.thumb, now), index = s.f.index.filter(h.index, now);
  s.hand = { thumb, index, palm: s.f.palm.filter(h.palm, now), size: s.f.size.filter(h.size, now),
             n: frozen ? s.hand.n : s.held,
             tips: h.tips, gaps: h.tipGap, pad: s.pad, side: k,
             mid: [(thumb[0] + index[0]) / 2, (thumb[1] + index[1]) / 2] };
  s.seen = now;
}

// ---------------------------------------------------------------- drawing

// The bass level that drives the window's visuals: the lowest four of 36 log-spaced bands from 40 Hz (40-77 Hz),
// each jumping up fast and falling slowly.
const SPEC_BANDS = 36, SPEC_LO = 40, SPEC_HI = 14000, BASS_BANDS = 4;
const bassBands = new Float32Array(BASS_BANDS);
let bassEdges;
function bassLevel(dt) {
  const binHz = ctx.sampleRate / analyser.fftSize;
  bassEdges ||= Array.from({ length: BASS_BANDS + 1 }, (_, i) => Math.round(SPEC_LO * Math.pow(SPEC_HI / SPEC_LO, i / SPEC_BANDS) / binHz));
  for (let i = 0; i < BASS_BANDS; i++) {
    const lo = bassEdges[i], hi = Math.max(lo + 1, bassEdges[i + 1]);
    let m = 0; for (let j = lo; j < hi; j++) m = Math.max(m, freqData[j]);
    const v = clamp(Math.pow(m / 255, 1.6) * (0.85 + 0.3 * i / SPEC_BANDS), 0, 1);
    bassBands[i] = v > bassBands[i] ? bassBands[i] + (v - bassBands[i]) * 0.7 : Math.max(v, bassBands[i] - dt * 1.6);
  }
  return bassBands.reduce((a, v) => a + v, 0) / BASS_BANDS;
}

// ---------------------------------------------------------------- visuals
// Between the hands: a window that redraws the camera as heat-camera pixel-art symbols, hard-cutting on the beat (see drawWindow).
// Sparks fly from drum pads and the pistol.
const SPARK_MAX = 700;
const sparks = [];
let bassAvg = 0, lastHit = 0;
const QUAD_MIN = 14;                           // half-height in px the window keeps when a pinch is closed
function spawnSparks(x, y, count, nx = 0, ny = 0, power = 1) {
  for (let i = 0; i < count && sparks.length < SPARK_MAX; i++) {
    const ang = Math.random() * Math.PI * 2, sp = (150 + Math.random() * 650) * power;
    const side = Math.random() < 0.5 ? -1 : 1, dir = nx || ny;   // with a normal, fling mostly sideways off the line
    const dx = dir ? nx * side + Math.cos(ang) * 0.5 : Math.cos(ang), dy = dir ? ny * side + Math.sin(ang) * 0.5 : Math.sin(ang);
    const life = 0.35 + Math.random() * 0.7;
    sparks.push({ x, y, vx: dx * sp, vy: dy * sp, life, max: life, h: Math.random() * 90 });
  }
}
function drawSparks(dt) {
  g.save(); g.globalCompositeOperation = "lighter"; g.lineCap = "round";
  for (let i = sparks.length - 1; i >= 0; i--) {
    const p = sparks[i];
    if ((p.life -= dt) <= 0) { sparks.splice(i, 1); continue; }
    const drag = Math.exp(-dt * 1.8);
    p.vx *= drag; p.vy = p.vy * drag + 700 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    const k = p.life / p.max;
    g.strokeStyle = `hsla(${p.h},100%,${55 + 40 * k}%,${k})`; g.lineWidth = 1 + 3 * k;
    g.beginPath(); g.moveTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035); g.lineTo(p.x, p.y); g.stroke();
  }
  g.restore();
}

// Heat-camera pixel-art window: the four fingertips (left thumb, left index, right index, right thumb) frame a window.
// Inside, the camera image under it is redrawn like a thermal camera: brightness becomes "heat" and is coloured with
// a heat palette. The window is cut into cells, and each cell becomes a tiny 5x5-pixel symbol (dark -> empty or a dot,
// bright -> stars, hearts, solid blocks) in its heat colour. Bass makes everything denser and hotter.
// Like a real thermal camera it auto-ranges: the coldest spot in the window is always the cold end of the palette and
// the hottest spot the hot end, so the whole palette is always in use, even in a dim room. The palettes start at a
// deep colour, not black, and the soft blurry heat image always fills the window behind the symbols.
// On every kick (or every 1-2 beats when nothing hits) it hard-cuts to a new heat palette, symbol set and symbol style:
//   lift: symbols a few steps hotter than the heat behind them    carve: a few steps colder    swap: the opposite end
// Sometimes the heat is flipped (cold <-> hot). A gunshot flips it for a moment.
const HEAT_PALETTES = [
  [[0, "#2b0b8f"], [0.25, "#7a1fa2"], [0.45, "#d6286e"], [0.65, "#ff5a1f"], [0.85, "#ffb300"], [1, "#fff6c2"]],                 // ironbow
  [[0, "#2a2aff"], [0.2, "#00b4ff"], [0.4, "#00f0a0"], [0.55, "#7dff2a"], [0.7, "#ffee00"], [0.85, "#ff6a00"], [1, "#ff1f4f"]], // rainbow
  [[0, "#1a2fb0"], [0.35, "#1f7bff"], [0.6, "#22d3ff"], [0.85, "#a8f4ff"], [1, "#ffffff"]],                                    // arctic
  [[0, "#7a0026"], [0.35, "#d1001f"], [0.6, "#ff4d00"], [0.85, "#ffc400"], [1, "#fff3a0"]],                                    // lava
  [[0, "#4b1391"], [0.3, "#a2208f"], [0.55, "#f0466b"], [0.8, "#ffa15c"], [1, "#fff0b5"]],                                     // magma
].map(stops => {                                // -> 16 colours, from coldest to hottest
  const c = document.createElement("canvas"); c.width = 16; c.height = 1;
  const x = c.getContext("2d", { willReadFrequently: true }), gr = x.createLinearGradient(0, 0, 16, 0);
  for (const [t, col] of stops) gr.addColorStop(t, col);
  x.fillStyle = gr; x.fillRect(0, 0, 16, 1);
  const d = x.getImageData(0, 0, 16, 1).data;
  return Array.from({ length: 16 }, (_, i) => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
});
const HEAT_STYLES = ["lift", "carve", "swap"];
const HEAT_FLIP_CHANCE = 0.25;                  // how often a cut flips cold <-> hot
const PIX = 3;                                  // screen px per art pixel; a cell is 5 art pixels + 1 gap
// symbol sets, each ordered from emptiest to fullest ('#' = pixel on)
const bitmap = s => s.split("|").flatMap((row, y) => [...row].flatMap((ch, x) => ch === "#" ? [[x, y]] : []));
const PIX_SETS = [
  [".....|.....|.....|.....|.....", ".....|.....|..#..|.....|.....", ".....|..#..|.###.|..#..|.....", "..#..|..#..|#####|..#..|..#..",
   "#...#|.#.#.|..#..|.#.#.|#...#", "#.#.#|.###.|#####|.###.|#.#.#", "#####|#####|#####|#####|#####"],                 // crosses and asterisks
  [".....|.....|.....|.....|.....", ".....|.....|..#..|.....|.....", "..#..|.....|#.#.#|.....|..#..", ".....|.#.#.|.....|#...#|.###.",
   "..#..|.###.|#####|.###.|..#..", ".#.#.|#####|#####|.###.|..#..", "#####|#####|#####|#####|#####"],                 // sparkles, smileys, stars, hearts
  [".....|.....|.....|.....|.....", ".....|.....|..#..|.....|.....", ".....|.....|#####|.....|.....", ".....|#####|.....|#####|.....",
   "#.#.#|.#.#.|#.#.#|.#.#.|#.#.#", "#####|#...#|#...#|#...#|#####", "#####|#####|#####|#####|#####"],                 // lines, checkers, boxes
].map(set => set.map(bitmap));
const pixCanvas = document.createElement("canvas"), pixCtx = pixCanvas.getContext("2d", { willReadFrequently: true });
// Scenes take turns, in a shuffled order, every SCENE_CUTS beat cuts (the pixel scene: every PIXEL_SCENE_SECONDS; solid: SOLID_SCENE_CUTS):
//   pixel:  the heat image built from 5x5-pixel symbols, as above
//   solid:  the whole window one flat colour (white, black, red, ...), a different one on every cut (shorter)
//   me:     you as chunky pixels in your real colours; when a face is detected it gets a face effect, a new one on
//           every cut: big-head bulge, pinch, swirl (pumping with the bass), blank (the features melt away into the
//           surrounding skin, right in the pixels), or a pixelated emoji over the face (FACE_EMOJIS)
// plus classic photo-booth style effects:
//   popart: 4-up grid of you, each panel in two loud colours that rotate on every cut
//   xray:   glowing blue negative
//   comic:  punchy, clean poster colours
//   mirror: the left half of the window mirrored onto the right (symmetric face)
// and desktop wallpapers:
//   wallpaper: your pictures from assets/local (media.json) and flat colours, hard-cutting to a different one on
//              every beat cut, so they flick past quickly in time with the music
const SCENES = ["pixel", "popart", "solid", "wallpaper", "xray", "me", "comic", "mirror"];
// How long a scene lasts, in cuts (a cut = a kick, or a beat when nothing hits): fast, hard-hitting music changes
// scenes quickly, calm music slowly. The pixel scene keeps its own pace in seconds.
const SCENE_CUTS = 4, PIXEL_SCENE_SECONDS = 5;
// The solid scene is shorter, and jumps on every cut to another flat colour from SOLID_COLORS (never the same twice
// in a row). The same colours also join the wallpapers, as flat "wallpapers" between the pictures.
const SOLID_SCENE_CUTS = 3;
const SOLID_COLORS = ["#ffffff", "#000000", "#ff1a1a", "#0047ff", "#ffe600", "#00c853", "#ff2d95", "#ff7a00"];   // white, black, red, blue, yellow, green, pink, orange
// Cuts: on every kick (but not closer than CUT_MIN beats), and without kicks on every beat when the music is busy
// (BUSY_ONSETS kicks in the last 2 s) or every other beat when it's calm.
const CUT_MIN = 0.5, BUSY_ONSETS = 3;
const ME_CELL = 10;   // grid sizes in px (smaller = sharper)
const FACE_WARPS = ["bulge", "pinch", "swirl", "blank", "emoji"];
const FACE_EMOJIS = ["😎", "😵", "😉", "😍", "😈"];   // cool with glasses, dead, winking, heart eyes, devil
const POP_COLORS = [["#ff2d95", "#ffe600"], ["#00c2ff", "#ff5a00"], ["#7cff00", "#b100ff"], ["#ffe600", "#0047ff"]];   // [highlights, shadows]
// Scenes come in a random order: a shuffled round of all of them, then a new shuffle (every scene still gets its turn,
// and a new round never starts with the scene that just ended the last one).
let sceneBag = [];
function nextScene() {
  if (!sceneBag.length) {
    sceneBag = [...SCENES];
    for (let i = sceneBag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [sceneBag[i], sceneBag[j]] = [sceneBag[j], sceneBag[i]]; }
    if (sceneBag[0] === scene) sceneBag.push(sceneBag.shift());
  }
  return sceneBag.shift();
}
let scene = "pixel", sceneStart = 0, sceneCuts = 0, onsetTimes = [], solidIdx = 0, faceWarp = "bulge", swirlDir = 1, faceEmoji = "😎", popShift = 0;
const fxCanvas = document.createElement("canvas"), fxCtx = fxCanvas.getContext("2d");
// the window's shadow: mostly translucent black, sometimes a translucent colour from the current palette
let shadowCol = "rgba(0,0,0,0.35)";
const meCanvas = document.createElement("canvas"), meCtx = meCanvas.getContext("2d", { willReadFrequently: true });
let heatPal = 0, heatStyle = "lift", heatFlip = false, heatLo = 0, heatHi = 255, pixSet = 0, lastCut = 0, gunNegUntil = 0;
const pick = (n, cur) => (cur + 1 + Math.floor(Math.random() * (n - 1))) % n;   // random, never the same as cur
// A stock emoji over the face, redrawn as solid pixels on the same grid as the "me" scene: rendered big, shrunk to
// one pixel per cell, edges made fully opaque or fully clear, then scaled back up without smoothing.
const emojiHi = document.createElement("canvas"), emojiHiCtx = emojiHi.getContext("2d");
const emojiLo = document.createElement("canvas"), emojiLoCtx = emojiLo.getContext("2d", { willReadFrequently: true });
emojiHi.width = emojiHi.height = 160;
function drawFaceEmoji(F, bass, cell) {
  const n = Math.max(6, Math.round(F.r * 1.5 * (1 + 0.08 * bass) / cell));   // emoji size in cells
  emojiHiCtx.clearRect(0, 0, 160, 160);
  emojiHiCtx.textAlign = "center"; emojiHiCtx.textBaseline = "middle";
  emojiHiCtx.font = `140px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  emojiHiCtx.fillText(faceEmoji, 80, 88);
  emojiLo.width = emojiLo.height = n;
  emojiLoCtx.imageSmoothingEnabled = true; emojiLoCtx.imageSmoothingQuality = "high";
  emojiLoCtx.drawImage(emojiHi, 0, 0, n, n);
  const img = emojiLoCtx.getImageData(0, 0, n, n), d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] < 110 ? 0 : 255;   // solid pixels: all-or-nothing alpha
  emojiLoCtx.putImageData(img, 0, 0);
  const x = Math.round((F.x - n * cell / 2) / cell) * cell, y = Math.round((F.y - n * cell / 2) / cell) * cell;   // on the grid
  g.save(); g.imageSmoothingEnabled = false; g.drawImage(emojiLo, x, y, n * cell, n * cell); g.restore();
}

// ---- wallpapers: loaded in the background at start; only pictures that finished loading are used
let wallIdx = 0;
let walls = [];
localMedia.then(m => { walls = m.wallpapers.map(f => { const im = new Image(); im.decoding = "async"; im.src = encodeURI(f); return im; }); });
// the pictures that have loaded, plus the flat colours (strings) mixed in between them
const readyWalls = () => [...walls.filter(im => im.complete && im.naturalWidth), ...SOLID_COLORS];
function drawWallpaper(quad) {                  // the current wallpaper, cover-fitted to the window
  const list = readyWalls();
  if (!list.length) return;
  const im = list[wallIdx % list.length];
  const xs = quad.map(p => p[0]), ys = quad.map(p => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), bw = Math.max(...xs) - x0, bh = Math.max(...ys) - y0;
  if (typeof im === "string") { g.fillStyle = im; g.fillRect(x0, y0, bw, bh); return; }   // a flat colour
  const iw = im.naturalWidth, ih = im.naturalHeight, k = Math.max(bw / iw, bh / ih);
  g.save(); g.imageSmoothingEnabled = iw >= 300;   // tiny pictures (icons) stay crisp pixel art when blown up
  g.drawImage(im, x0 + (bw - iw * k) / 2, y0 + (bh - ih * k) / 2, iw * k, ih * k);
  g.restore();
}

// Classic photo-booth style effects on the window. Works in device pixels on a copy of the camera under it.
function drawBoothEffect(kind, quad, m, cv, bass) {
  const xs = quad.map(p => p[0] * m.a + m.e), ys = quad.map(p => p[1] * m.d + m.f);
  const bx = Math.max(0, Math.floor(Math.min(...xs))), by = Math.max(0, Math.floor(Math.min(...ys)));
  const bw = Math.min(cv.width, Math.ceil(Math.max(...xs))) - bx, bh = Math.min(cv.height, Math.ceil(Math.max(...ys))) - by;
  if (bw < 4 || bh < 4) return;
  fxCanvas.width = bw; fxCanvas.height = bh;
  fxCtx.drawImage(cv, bx, by, bw, bh, 0, 0, bw, bh);
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
  const tint = (col, op, x, y, w, h, alpha = 1) => { g.globalCompositeOperation = op; g.globalAlpha = alpha; g.fillStyle = col; g.fillRect(x, y, w, h); g.globalAlpha = 1; g.globalCompositeOperation = "source-over"; };
  if (kind === "popart") {                      // 2x2 grid, each panel a two-colour print of the whole window
    const w = bw / 2, h = bh / 2;
    for (let i = 0; i < 4; i++) {
      const x = bx + (i % 2) * w, y = by + Math.floor(i / 2) * h, [hi, lo] = POP_COLORS[(i + popShift) % POP_COLORS.length];
      g.filter = "grayscale(1) contrast(2.2) brightness(1.15)"; g.drawImage(fxCanvas, x, y, w, h); g.filter = "none";
      tint(hi, "multiply", x, y, w, h); tint(lo, "screen", x, y, w, h, 0.85);
    }
  } else if (kind === "xray") {                 // glowing blue negative
    g.filter = "grayscale(1) invert(1) contrast(1.5)"; g.drawImage(fxCanvas, bx, by);
    tint("#8fd3ff", "multiply", bx, by, bw, bh); tint("#0b2d66", "screen", bx, by, bw, bh);
    g.globalCompositeOperation = "screen"; g.globalAlpha = 0.4 + 0.4 * bass;
    g.filter = `grayscale(1) invert(1) contrast(1.5) blur(${Math.round(8 + 14 * bass)}px)`; g.drawImage(fxCanvas, bx, by);
    g.filter = "none"; g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
  } else if (kind === "comic") {                // punchy, clean poster colours
    g.filter = "saturate(2.4) contrast(1.6) brightness(1.12)"; g.drawImage(fxCanvas, bx, by); g.filter = "none";
  } else if (kind === "mirror") {               // left half mirrored onto the right half
    const half = Math.floor(bw / 2);
    g.filter = "saturate(1.3)";
    g.setTransform(-1, 0, 0, 1, 2 * (bx + half), 0);
    g.drawImage(fxCanvas, 0, 0, half, bh, bx, by, half, bh);
    g.filter = "none";
  }
  g.restore();
}

let windowSeen = false;
function drawWindow(L, R, vol, dt, now) {
  if (!windowSeen) {                            // the very first time the window appears: always the heat camera,
    windowSeen = true;                          // for its full turn, counted from now; then the shuffled scenes
    scene = "pixel"; sceneStart = now; sceneCuts = 0; sceneBag = [];
  }
  const a = L.mid, b = R.mid;
  const vx = b[0] - a[0], vy = b[1] - a[1], len = Math.hypot(vx, vy) + 1e-6;
  const halfOf = (h, flipTo) => {               // pinch midpoint -> index tip (the thumb sits at minus that)
    let hx = (h.index[0] - h.thumb[0]) / 2, hy = (h.index[1] - h.thumb[1]) / 2;
    if (flipTo && hx * flipTo[0] + hy * flipTo[1] < 0) { hx = -hx; hy = -hy; }   // no bowtie
    const l = Math.hypot(hx, hy);
    if (l < QUAD_MIN) { const dx = l > 1e-3 ? hx / l : -vy / len, dy = l > 1e-3 ? hy / l : vx / len; hx = dx * QUAD_MIN; hy = dy * QUAD_MIN; }
    return [hx, hy];
  };
  const lh = halfOf(L), rh = halfOf(R, lh);
  const quad = [[a[0] - lh[0], a[1] - lh[1]], [b[0] - rh[0], b[1] - rh[1]], [b[0] + rh[0], b[1] + rh[1]], [a[0] + lh[0], a[1] + lh[1]]];
  const path = (ox = 0, oy = 0) => { g.beginPath(); g.moveTo(quad[0][0] + ox, quad[0][1] + oy); for (const p of quad.slice(1)) g.lineTo(p[0] + ox, p[1] + oy); g.closePath(); };

  // cut: new palette, symbol set and background on each bass hit, or on the beat when nothing hits
  const bass = bassLevel(dt);
  const onset = bass > bassAvg * 1.35 + 0.05 && bass > 0.3 && now - lastHit > 0.14;
  bassAvg += (bass - bassAvg) * Math.min(1, dt * 3);
  if (onset) { lastHit = now; onsetTimes.push(now); }
  while (onsetTimes.length && now - onsetTimes[0] > 2) onsetTimes.shift();
  const beat = 60 / (bpm || 120) / Math.max(0.25, state.speed);   // s per beat as heard
  const busy = onsetTimes.length >= BUSY_ONSETS;
  if ((onset && now - lastCut > Math.max(0.15, CUT_MIN * beat)) || now - lastCut > (busy ? 1 : 2) * beat) {
    heatPal = pick(HEAT_PALETTES.length, heatPal);
    pixSet = pick(PIX_SETS.length, pixSet);
    heatStyle = HEAT_STYLES[pick(HEAT_STYLES.length, HEAT_STYLES.indexOf(heatStyle))];
    heatFlip = Math.random() < HEAT_FLIP_CHANCE;
    lastCut = now;
    sceneCuts++;
    const sceneLen = scene === "solid" ? SOLID_SCENE_CUTS : SCENE_CUTS;
    if (scene === "pixel" ? now - sceneStart > PIXEL_SCENE_SECONDS : sceneCuts >= sceneLen) {
      scene = nextScene(); sceneStart = now; sceneCuts = 0;
    }
    solidIdx = pick(SOLID_COLORS.length, solidIdx);   // the solid scene: another flat colour on every cut
    faceWarp = FACE_WARPS[pick(FACE_WARPS.length, FACE_WARPS.indexOf(faceWarp))]; swirlDir = Math.random() < 0.5 ? -1 : 1;
    faceEmoji = FACE_EMOJIS[pick(FACE_EMOJIS.length, FACE_EMOJIS.indexOf(faceEmoji))];
    const nw = readyWalls().length;             // next wallpaper on every cut, never the same twice in a row
    if (nw > 1) wallIdx = pick(nw, wallIdx % nw);
    popShift = (popShift + 1) % POP_COLORS.length;
    const pc = HEAT_PALETTES[heatPal][8 + Math.floor(Math.random() * 8)];
    shadowCol = Math.random() < 0.5 ? "rgba(0,0,0,0.35)" : `rgba(${pc.join(",")},0.4)`;
  }
  const flip = heatFlip !== now < gunNegUntil;  // the gunshot flips whatever is showing

  const d = 5 + 10 * vol / VOL_MAX;             // hard shadow, further out with volume (drawn last, see below)
  g.save();

  g.save(); path(); g.clip();
  // shrink the picture under the window to one pixel per cell (grid fixed to the screen so it doesn't swim)
  const m = g.getTransform(), cv = g.canvas, me = scene === "me";
  const cell = me ? ME_CELL : PIX * 6;
  const xs = quad.map(p => p[0]), ys = quad.map(p => p[1]);
  const gx0 = Math.floor(Math.min(...xs) / cell) * cell, gy0 = Math.floor(Math.min(...ys) / cell) * cell;
  const cols = Math.ceil((Math.max(...xs) - gx0) / cell), rows = Math.ceil((Math.max(...ys) - gy0) / cell);
  if (scene === "solid") {                      // one flat colour, the whole window
    g.fillStyle = SOLID_COLORS[solidIdx]; g.fillRect(gx0, gy0, cols * cell, rows * cell);
  } else if (me && cols > 0 && rows > 0 && cols * rows < 30000) {
    // whole camera at one pixel per cell, so a warped cell can pull its colour from anywhere around the face
    const fc = Math.ceil(W / cell), fr = Math.ceil(CAM_H / cell);
    meCanvas.width = fc; meCanvas.height = fr;
    meCtx.filter = "saturate(1.5) contrast(1.15)";
    meCtx.drawImage(cv, m.e, m.f, fc * cell * m.a, fr * cell * m.d, 0, 0, fc, fr);
    const src = meCtx.getImageData(0, 0, fc, fr).data;
    // blank face: a heavily blurred copy of the same grid; inside the face oval the cells take their colour from it,
    // so eyes, nose and mouth melt into the skin around them while light and shading stay natural
    const F0 = faceNow(now);
    let soft = null;
    if (F0 && faceWarp === "blank") {
      meCtx.filter = `blur(${Math.max(1.5, F0.r * 0.4 / cell).toFixed(1)}px)`;
      meCtx.drawImage(meCanvas, 0, 0); meCtx.drawImage(meCanvas, 0, 0);   // two passes: very smooth, no leftover features
      soft = meCtx.getImageData(0, 0, fc, fr).data;
      meCtx.filter = "none";
    }
    const out = pixCtx.createImageData(cols, rows), o = out.data;
    const F = faceNow(now), amt = 0.6 + 0.8 * bass;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      let x = gx0 + (c + 0.5) * cell, y = gy0 + (r + 0.5) * cell;
      if (F) {                                  // warp: pull each cell's colour from a moved spot inside the face circle
        const dx = x - F.x, dy = y - F.y, dd = Math.hypot(dx, dy), u = dd / F.r;
        if (u < 1 && dd > 0) {
          let k = 1;
          if (faceWarp === "bulge") k = Math.pow(u, 0.6 * amt);          // centre magnified: big head
          else if (faceWarp === "pinch") k = Math.pow(u, -0.4 * amt);    // centre shrunk
          if (faceWarp === "swirl") {
            const ang = swirlDir * (1 - u) * (1 - u) * 3 * amt, cs = Math.cos(ang), sn = Math.sin(ang);
            x = F.x + dx * cs - dy * sn; y = F.y + dx * sn + dy * cs;
          } else { x = F.x + dx * Math.min(k, 1 / Math.max(u, 1e-3)); y = F.y + dy * Math.min(k, 1 / Math.max(u, 1e-3)); }
        }
      }
      const sx = clamp(Math.floor(x / cell), 0, fc - 1), sy = clamp(Math.floor(y / cell), 0, fr - 1), si = (sy * fc + sx) * 4, oi = (r * cols + c) * 4;
      o[oi] = src[si]; o[oi + 1] = src[si + 1]; o[oi + 2] = src[si + 2]; o[oi + 3] = 255;
      if (soft) {                               // blend toward the blurred face, fully in the middle, fading at the edge
        const ex = (x - F.x) / (F.r * 0.62), ey = (y - F.y) / (F.r * 0.8), e = Math.hypot(ex, ey);
        const f = clamp((1.1 - e) / 0.55, 0, 1), w = f * f * (3 - 2 * f);   // smoothstep: full inside, long soft fade
        if (w > 0) for (let ch = 0; ch < 3; ch++) o[oi + ch] += (soft[si + ch] - o[oi + ch]) * w;
      }
    }
    pixCanvas.width = cols; pixCanvas.height = rows;
    pixCtx.putImageData(out, 0, 0);
    g.save(); g.imageSmoothingEnabled = false;  // crisp, chunky pixels
    g.drawImage(pixCanvas, gx0, gy0, cols * cell, rows * cell);
    g.restore();
    if (F && faceWarp === "emoji") drawFaceEmoji(F, bass, cell);
  } else if (scene === "wallpaper") {
    drawWallpaper(quad);
  } else if (["popart", "xray", "comic", "mirror"].includes(scene)) {
    drawBoothEffect(scene, quad, m, cv, bass);
  } else if (cols > 0 && rows > 0 && cols * rows < 30000) {
    pixCanvas.width = cols; pixCanvas.height = rows;
    pixCtx.filter = `grayscale(1)${flip ? " invert(1)" : ""}`;
    pixCtx.drawImage(cv, gx0 * m.a + m.e, gy0 * m.d + m.f, cols * cell * m.a, rows * cell * m.d, 0, 0, cols, rows);
    const img = pixCtx.getImageData(0, 0, cols, rows), px = img.data;
    const pal = HEAT_PALETTES[heatPal], pump = 0.8 + 0.6 * bass;
    // auto-range like a thermal camera: 5th..95th percentile of the window -> full palette, eased so it doesn't flicker
    const N = cols * rows, hist = new Uint32Array(256);
    for (let n = 0; n < N; n++) hist[px[n * 4]]++;
    let lo = 0, hi = 255;
    for (let acc = 0; lo < 255 && (acc += hist[lo]) < N * 0.05; lo++);
    for (let acc = 0; hi > 0 && (acc += hist[hi]) < N * 0.05; hi--);
    const ease = Math.min(1, dt * 5);
    heatLo += (lo - heatLo) * ease; heatHi += (Math.max(hi, lo + 40) - heatHi) * ease;
    const heat = new Uint8Array(N);             // 0..15, coldest to hottest
    for (let n = 0; n < N; n++) {
      const v = clamp((px[n * 4] - heatLo) / (heatHi - heatLo) * pump, 0, 1);
      heat[n] = Math.min(15, Math.floor(v * 16));
      [px[n * 4], px[n * 4 + 1], px[n * 4 + 2]] = pal[heat[n]];
    }
    // background: the soft, blurry heat image (like a real low-res thermal camera) always fills the window
    pixCtx.putImageData(img, 0, 0);
    g.save(); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(pixCanvas, gx0, gy0, cols * cell, rows * cell);
    g.restore();
    // symbols: one path per heat colour, fuller where it's hotter
    const set = PIX_SETS[pixSet], inks = Array.from({ length: 16 }, () => new Path2D());
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const h = heat[r * cols + c], sym = set[Math.min(set.length - 1, Math.floor(h / 16 * set.length))];
      if (!sym.length) continue;
      const x0 = gx0 + c * cell + PIX / 2, y0 = gy0 + r * cell + PIX / 2;
      for (const [x, y] of sym) inks[h].rect(x0 + x * PIX, y0 + y * PIX, PIX, PIX);
    }
    inks.forEach((ink, h) => {                  // symbols always in a palette colour that stands out from the heat behind
      const k = heatStyle === "lift" ? Math.min(15, h + 6) : heatStyle === "carve" ? Math.max(0, h - 6) : 15 - h;
      g.fillStyle = `rgb(${pal[k].join(",")})`; g.fill(ink);
    });
  }
  g.restore();

  // the shadow comes after the picture, so the window's effects see the camera as it is, and only outside the window
  g.save(); g.beginPath(); g.rect(-1e4, -1e4, 3e4, 3e4);
  g.moveTo(quad[0][0], quad[0][1]); for (const p of quad.slice(1)) g.lineTo(p[0], p[1]); g.closePath();
  g.clip("evenodd"); g.fillStyle = shadowCol; path(d * 0.5, d); g.fill(); g.restore();
  g.lineJoin = "round"; g.lineWidth = 2; g.strokeStyle = "#fff"; path(); g.stroke();
  g.restore();

  lastQuad = quad; lastQuadM = g.getTransform();   // for throwing it away
  return Math.max(30, Math.abs((lh[1] + rh[1]) / 2) + d);   // volume label goes under the window and its shadow
}

function drawHand(h) {
  // pad fingertips: a ring that tightens as the thumb gets near, filled gold while that pad is on
  if (h.tips) for (const f of [12, 16, 20]) {
    const p = h.tips[f], gap = h.gaps[f], on = h.pad === f;
    if (!on && gap > 0.8) continue;
    g.strokeStyle = on ? "#ffd479" : `rgba(255,255,255,${0.9 * (1 - gap / 0.8)})`; g.lineWidth = on ? 4 : 2;
    g.beginPath(); g.arc(p[0], p[1], on ? 18 : 10 + 24 * gap, 0, 7); g.stroke();
    if (on) { g.fillStyle = "rgba(255,212,121,.45)"; g.fill(); }
  }
  g.strokeStyle = "#fff"; g.lineWidth = 3;
  g.beginPath(); g.moveTo(...h.thumb); g.lineTo(...h.index); g.stroke();
  for (const p of [h.thumb, h.index]) {
    g.fillStyle = "#fff"; g.beginPath(); g.arc(p[0], p[1], 11, 0, 7); g.fill();
    g.fillStyle = "#eb5a5a"; g.beginPath(); g.arc(p[0], p[1], 7, 0, 7); g.fill();
  }
}

function label(x, y, title, value, big = 40) {
  g.textAlign = "center"; g.textBaseline = "top";
  g.shadowColor = "rgba(0,0,0,.9)"; g.shadowBlur = 6; g.shadowOffsetY = 2; g.fillStyle = "#fff";
  if (title) { g.font = "600 24px -apple-system, Helvetica, Arial, sans-serif"; g.fillText(title, x, y); }
  g.font = `${big}px -apple-system, Helvetica, Arial, sans-serif`; g.fillText(value, x, y + (title ? 30 : 0));
  g.shadowColor = "transparent"; g.shadowBlur = 0; g.shadowOffsetY = 0;
}

// ---------------------------------------------------------------- main loop
const state = { speed: 1, filterStep: FILTER_OPEN, vol: VOL_DEFAULT, echo: 0, crush: 0, oct: 1, octOn: false, bassOn: false };
let keyOct = false, keyBrake = false, keyBass = false, keySiren = false, keyThrow = false, sirenTried = false, mouseY = 0.5;   // keyboard stand-ins: hold S / H, mouse height = note
let keyRoll = false, keyCrushHeld = false, crushPick = 0;   // keyboard stand-ins: hold B = roll, hold C = crush (mouse height)
const ECHO_NAMES = { 0.5: "1/8", 0.75: "DOTTED 1/8", 1: "1/4", 2: "1/2 BAR" };

function drawBursts(now) {
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i], age = now - b.t;
    if (age > 0.6) { bursts.splice(i, 1); continue; }
    const k = age / 0.6;
    if (!b.quiet) {
      g.strokeStyle = `rgba(255,212,121,${1 - k})`; g.lineWidth = 6 * (1 - k) + 1;
      g.beginPath(); g.arc(b.x, b.y, 20 + 110 * Math.sqrt(k), 0, 7); g.stroke();
    }
    g.globalAlpha = 1 - k; label(b.x, b.y - 90 - 30 * k, "", b.name, b.quiet ? 64 : 34); g.globalAlpha = 1;
  }
}
let leftStep = SPEED_STEPS.indexOf(1);
// pinch (0..1) -> step index. Each step owns an equal slice of the pinch; to leave the current step the pinch has
// to go STEP_HYST past its edge, so a value sitting on a boundary doesn't flicker between two steps.
function pickStep(n, cur, count, hyst = STEP_HYST * count) {
  const z = n * count;
  if (z < cur - hyst || z > cur + 1 + hyst) cur = Math.floor(z);
  return clamp(cur, 0, count - 1);
}
let lastLog = 0, lastVals = "", lastT = 0, lastVideoTime = -1, lastTrackMs = -1e9;
// Hand tracking is the heaviest work per frame. The camera runs at up to 60 fps for a smooth picture, but the hands are
// checked at most TRACK_HZ times a second (the smoothing filters fill the frames in between), which roughly halves the
// load and keeps drawing and recording smooth.
const TRACK_HZ = 30;
const perf = { frames: 0, tracks: 0, t0: 0, fps: 0 };
function updatePerf(nowMs) {                     // frames drawn / hand checks per second, shown under the status
  perf.frames++;
  if (nowMs - perf.t0 < 1000) return;
  const k = 1000 / (nowMs - perf.t0);
  perf.fps = perf.frames * k;
  $("perf").textContent = `${Math.round(perf.fps)} fps · hands ${Math.round(perf.tracks * k)}/s` + (perf.fps < 25 ? " · slow" : "");
  $("perf").classList.toggle("slow", perf.fps < 25);
  $("perf").title = perf.fps < 25 ? "Under 25 fps: close other apps and video calls, plug in the charger, E turns laser eyes off."
                                  : "Frames drawn per second, and hand checks per second.";
  perf.frames = perf.tracks = 0; perf.t0 = nowMs;
}

// Wide: canvas matches the camera's own aspect ratio, so nothing is cropped, with the terminal below it.
// Tall: the original 1080x1920 Instagram frame (camera cover-cropped).
function applyLayout() {
  const wide = $("layout").value === "wide";
  if (wide) { W = WIDE_W; CAM_H = Math.round(W * video.videoHeight / video.videoWidth); H = CAM_H + TERM_H; }
  else { W = 1080; H = 1920; CAM_H = 1060; }
  const CW = W + (wide ? BAR_W : 0);            // W stays the camera width; the spectrum panel sits beyond it
  if (canvas.width !== CW || canvas.height !== H) { canvas.width = CW; canvas.height = H; }
  return wide;
}
if (store.get("handdj.layout")) $("layout").value = store.get("handdj.layout");
$("layout").onchange = e => { store.set("handdj.layout", e.target.value); if (!started) drawIntro(); };

// ---------------------------------------------------------------- spectrum panel (wide layout)
let barLevels = new Float32Array(0), barAvg = new Float32Array(0), barPeakDb = -100, barKick = 0;
function drawSpectrumBar(dt) {
  const x0 = W, top = 60, bottom = H - 60, base = x0 + 48, maxLen = BAR_W - 48 - 36;
  g.fillStyle = "#000"; g.fillRect(x0, 0, BAR_W, H);
  const rows = Math.floor((bottom - top) / BAR_PITCH);
  if (barLevels.length !== rows) { barLevels = new Float32Array(rows); barAvg = new Float32Array(rows); }
  const live = analyser && source && !paused;
  const binHz = ctx.sampleRate / analyser.fftSize, fall = Math.exp(-dt / BAR_RELEASE);
  const avgK = 1 - Math.exp(-dt / BAR_AVG);
  const hz = r => BAR_HZ[0] + (BAR_HZ[1] - BAR_HZ[0]) * (r / rows) ** BAR_SPREAD;
  const toDb = v => analyser.minDecibels + v / 255 * (analyser.maxDecibels - analyser.minDecibels);
  // the scale: full length at BAR_FULL_DB, or at the song's held peak if it's louder (never more gain than that)
  let loudest = -100;
  const db = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let v = 0;
    if (live) {
      const a = hz(r) / binHz, b = hz(r + 1) / binHz;
      if (b - a < 1) v = freqData[Math.round(a)] ?? 0;   // low rows are narrower than a bin: nearest bin
      else for (let j = Math.floor(a); j < Math.ceil(b) && j < freqData.length; j++) v = Math.max(v, freqData[j]);
    }
    const d = v > 0 ? toDb(v) : -200;
    db[r] = d < BAR_GATE_DB ? -200 : d + BAR_TILT * Math.max(0, Math.log2(hz(r) / 200));   // gate before the lift
    loudest = Math.max(loudest, db[r]);
  }
  barPeakDb = Math.max(loudest, barPeakDb - dt * 6 / BAR_PEAK_RELEASE);   // falls ~6 dB per BAR_PEAK_RELEASE
  const full = Math.max(BAR_FULL_DB, barPeakDb);
  const path = new Path2D();
  let kick = 0, kickRows = 0;
  for (let r = 0; r < rows; r++) {
    const level = clamp((db[r] - BAR_GATE_DB) / (full - BAR_GATE_DB), 0, 1);
    const punch = Math.max(0, level - barAvg[r]);         // how far this band just jumped above its recent self
    barAvg[r] += (level - barAvg[r]) * avgK;
    const low = hz(r) < BAR_KICK_HZ;
    if (low) { kick += punch; kickRows++; }
    const v = clamp(BAR_BODY * level ** BAR_BODY_CURVE + (low ? BAR_KICK_PUNCH : hz(r) > BAR_HIGH_HZ ? BAR_HIGH_PUNCH : BAR_PUNCH) * punch, 0, 1);
    barLevels[r] = Math.max(v, barLevels[r] * fall);
    if (barLevels[r] > 0.004) path.rect(base, top + r * BAR_PITCH, barLevels[r] * maxLen, BAR_LINE);
  }
  g.save();
  // the glow flares on each kick (a sudden jump across the bass rows) and settles between beats
  barKick = Math.max(clamp(4 * kick / Math.max(1, kickRows), 0, 1), barKick * Math.exp(-dt / BAR_GLOW_FALL));
  g.fillStyle = BAR_COLOR; g.shadowColor = `rgba(243,198,20,${0.5 + 0.4 * barKick})`;
  g.shadowBlur = BAR_GLOW[0] + (BAR_GLOW[1] - BAR_GLOW[0]) * barKick;
  g.fill(path);
  g.fillRect(base - 4, top, 4, rows * BAR_PITCH);   // baseline
  g.restore();
}

function frame(nowMs) {
  requestAnimationFrame(frame);
  if (!video.videoWidth) return;
  const now = nowMs / 1000, dt = Math.min(0.1, now - lastT); lastT = now;
  if (analyser) analyser.getByteFrequencyData(freqData);   // the spectrum, read once per frame for everything
  if (source) { const at = ctx.currentTime; if (at > lastAudioT) { songPos += (at - lastAudioT) * source.playbackRate.value; lastAudioT = at; } }   // (a switch on the beat starts a moment later)

  // camera, mirrored + cover crop
  const wide = applyLayout();
  const s = wide ? W / video.videoWidth : Math.max(W / video.videoWidth, CAM_H / video.videoHeight);   // wide: whole frame; tall: cover-crop
  crop = { s, x0: (video.videoWidth * s - W) / 2, y0: (video.videoHeight * s - CAM_H) / 2 };
  g.save(); g.beginPath(); g.rect(0, 0, W, CAM_H); g.clip();
  if (gunKick > 0.02) g.translate((Math.random() - 0.5) * 26 * gunKick, (Math.random() - 0.5) * 26 * gunKick);   // gunshot camera shake
  g.save(); g.translate(W, 0); g.scale(-1, 1);
  g.drawImage(video, -crop.x0, -crop.y0, video.videoWidth * s, video.videoHeight * s);
  g.restore();

  updatePerf(nowMs);
  if (landmarker && video.currentTime !== lastVideoTime && nowMs - lastTrackMs >= 1000 / TRACK_HZ - 2) {
    lastVideoTime = video.currentTime; lastTrackMs = nowMs; perf.tracks++;
    const res = landmarker.detectForVideo(video, nowMs);
    if (scene === "me" || laserOn) updateFace(nowMs);
    const raw = [];
    res.landmarks.forEach((lm, i) => {
      const h = handInfo(lm, res.worldLandmarks?.[i], res.handedness?.[i]);
      if (raw.every(o => dist(h.palm, o.palm) > 0.6 * Math.max(h.size, o.size))) raw.push(h);  // drop duplicates
    });
    const { L, R } = assignSides(raw, now);
    recMotion(L, R);                             // raw (unsmoothed) hand positions, only when tracking ran: Auto sync
    updateSide("L", L, now); updateSide("R", R, now);
  }
  const left = alive("L", now), right = alive("R", now);

  // left pinch picks a speed step (a musical ratio); the original sits mid-pinch
  leftStep = left ? pickStep(left.n, leftStep, SPEED_STEPS.length) : NEUTRAL_SPEED;   // left hand gone: back to the original
  state.speed = SPEED_STEPS[leftStep];
  // right pinch picks a filter step the same way (one octave per step)
  state.filterStep = right ? pickStep(right.n, state.filterStep, LOWPASS_STEPS.length, R_STEP_HYST) : FILTER_OPEN;   // hand gone: untouched
  // a hand holding crush / octaves uses its height for that, so it must not also move volume or echo
  state.bassOn = keyBass || (!!left && sides.L.pad === 12);   // bass boost: left thumb held on the middle finger
  const crushHeld = !!left && sides.L.pad === 16;
  const octHeld = !!right && (sides.R.pad === 16 || sides.R.pad === 20);   // octaves or siren: the right hand's height is busy
  const sirenHeld = !!right && sides.R.pad === 20;
  if (!(crushHeld || octHeld))
    state.vol = left && right ? norm(dist(left.mid, right.mid) / W, HANDS_NEAR, HANDS_FAR) * VOL_MAX
                              : VOL_DEFAULT;  // volume needs both hands; otherwise back to normal
  const up = [crushHeld ? null : left, octHeld ? null : right].filter(Boolean);   // echo: how high the free hands are
  if (up.length || !(crushHeld || octHeld))
    state.echo = up.length ? norm(up.reduce((a, h) => a + h.palm[1], 0) / up.length / CAM_H, ECHO_LOW, ECHO_HIGH) : 0;
  // octaves: right thumb held on the ring finger (or H + mouse); hand height picks the step
  const octY = octHeld && !sirenHeld ? right.palm[1] / CAM_H : keyOct ? mouseY : null;
  state.octOn = octY !== null && !!oct;
  if (octY !== null) state.oct = pickStep(norm(octY, HOLD_LOW, HOLD_HIGH), state.oct, OCT_STEPS.length, HOLD_HYST);
  // record stop: both hands in fists for FIST_FRAMES frames (or T held)
  const fists = keyBrake || (!!left && !!right && sides.L.fistN >= FIST_FRAMES && sides.R.fistN >= FIST_FRAMES);
  trackHands(left, right, now);
  if (fists && !brake) startBrake();
  else if (brake?.thrown) {                      // thrown away: stays stopped until two fists come back and open again
    if (!fists) brake.opened = true; else if (brake.opened) brake.thrown = false;
  } else if (!fists && brake && !brake.up) releaseBrake();
  if (brake && brake.up && ctx.currentTime >= brake.done) brake = null;
  // throw it away: a fast swing of both hands while the song is held stopped (or X while T is held)
  const sw = brake && !brake.up && !brake.thrown && !flight ? swing(now) : null;
  const throwNow = brake && !brake.up && !brake.thrown && !flight && (keyThrow || (sw && sw.speed > THROW_SPEED));
  keyThrow = false;
  // crush: left thumb held on the ring finger (or C + mouse height); hand height picks 8 / 6 / 4-bit, off when let go
  const crushY = crushHeld ? left.palm[1] / CAM_H : keyCrushHeld ? mouseY : null;
  if (crushY !== null) crushPick = pickStep(norm(crushY, HOLD_LOW, HOLD_HIGH), crushPick, CRUSH_STEPS.length - 1, HOLD_HYST);
  state.crush = crushY !== null ? 1 + crushPick : 0;
  // beat roll: held while the right thumb stays on the middle fingertip (or B is held)
  const rollOn = keyRoll || (!!right && sides.R.pad === 12);
  updateJungle();
  // air-raid siren: right thumb held on the pinky (or S + mouse); hand height = pitch
  const sirenY = sirenHeld ? norm(right.palm[1] / CAM_H, HOLD_LOW, HOLD_HIGH) : keySiren ? norm(mouseY, HOLD_LOW, HOLD_HIGH) : null;
  if (ctx && sirenY !== null && !siren && !paused && !sirenTried) { sirenTried = true; startSiren(sirenY); }
  else if (sirenY === null) { sirenTried = false; if (ctx && siren) stopSiren(); }
  if (ctx) updateSiren(sirenY);
  if (rollOn && !roll && !brake) startRoll(); else if (!rollOn && roll) stopRoll();
  updateRoll();
  applyAudio();

  updateTransport(now);

  // overlay
  laserBeat(now, dt); drawLaserEyes(now, dt);   // under the window and the hands
  const windowH = left && right && analyser && !brake?.thrown ? drawWindow(left, right, state.vol, dt, now) : 0;
  // the window between the hands; with no hands on screen (keyboard), a strip of the middle of the picture
  const tq = left && right ? [lastQuad, lastQuadM]
           : [[[W * 0.3, CAM_H * 0.44], [W * 0.7, CAM_H * 0.44], [W * 0.7, CAM_H * 0.56], [W * 0.3, CAM_H * 0.56]], g.getTransform()];
  if (throwNow && throwWindow(sw || { vx: 0, vy: 0 }, ...tq)) { brake.thrown = true; brake.opened = false; log("Thrown away: song stopped (two fists again, or Space, to bring it back)"); }
  drawFlight(dt);
  drawFlash();
  drawSparks(dt);
  if (left) drawHand(left);
  if (right) drawHand(right);
  const named = left && SPEED_NAMES[leftStep];
  if (left) label(left.thumb[0], left.thumb[1] + 18, "SPEED", `${+state.speed.toFixed(2)}x`);
  if (named) label(left.thumb[0], left.thumb[1] + 108, "", SPEED_NAMES[leftStep], 24);
  if (right) label(right.thumb[0], right.thumb[1] + 18, "FILTER", filterLabel());
  if (state.bassOn) label(left ? left.thumb[0] : W / 2, (left ? left.thumb[1] : CAM_H * 0.5) + (state.crush ? 190 : 108) + (named ? 42 : 0), "", "BASS BOOST", 40);
  if (state.crush) {                            // under the left hand's SPEED readout
    const cy = left ? left.thumb[1] + (named ? 150 : 108) : CAM_H * 0.5;
    label(left ? left.thumb[0] : W / 2, cy, "CRUSH", CRUSH_STEPS[state.crush].name, 40);
  }
  let ry = right ? right.thumb[1] + 108 : CAM_H * 0.5;
  if (roll) { label(right ? right.thumb[0] : W / 2, ry, "BEAT ROLL", ROLL_NAMES[roll.step], 40); ry += 80; }
  if (state.octOn) { label(right ? right.thumb[0] : W / 2, ry, "OCTAVES", OCT_STEPS[state.oct].name, 40); ry += 80; }
  if (siren) label(right ? right.thumb[0] : W / 2, ry, "AIR RAID", sirenLabel(), 40);
  if (jungle) {                                  // top right: tempo + a 16-step light that runs with the break
    label(W - 230, 28, "JUNGLE", `${Math.round(jungleBpm())} BPM`, 34);
    const cur = Math.floor(jungle.pos / (60 / jungleOwn.bpm / 4)) % 16;   // 16ths of the current bar
    for (let i = 0; i < 16; i++) { g.fillStyle = i === cur ? "#ffd479" : i % 4 ? "rgba(255,255,255,.25)" : "rgba(255,255,255,.5)"; g.fillRect(W - 350 + i * 15, 112, 11, 11); }
  }
  if (brake && !brake.up && !brake.thrown) label(W / 2, CAM_H * 0.42, "", source && source.playbackRate.value < 0.02 ? "STOPPED" : "RECORD STOP", 64);
  if (brake?.thrown && !flight) label(W / 2, CAM_H * 0.42, "two fists to bring it back", "THROWN AWAY", 52);

  if (left && right) {
    const mx = (left.mid[0] + right.mid[0]) / 2, my = (left.mid[1] + right.mid[1]) / 2;
    const vy = my + windowH + 24;                   // volume readout sits just below the spectrum
    label(mx, vy, "VOLUME", `${Math.round(state.vol / VOL_MAX * 100)}%`, 34);
    g.fillStyle = "rgba(40,40,40,.8)"; g.fillRect(mx - 100, vy + 74, 200, 8);
    g.fillStyle = "#fff"; g.fillRect(mx - 100, vy + 74, 200 * state.vol / VOL_MAX, 8);
  }
  const echoOn = +$("echo").value && state.echo > 0.02;
  if (echoOn) {
    label(W / 2, 28, `ECHO ${ECHO_NAMES[$("echo").value]} @ ${Math.round(beatHz() * 60)} BPM`, `${Math.round(state.echo * 100)}%`, 34);
    g.fillStyle = "#282828"; g.fillRect(W / 2 - 100, 112, 200, 10);
    g.fillStyle = "#ffd479"; g.fillRect(W / 2 - 100, 112, 200 * state.echo, 10);
  }
  drawGuns(now, dt);
  drawBursts(now);
  if (counting) label(W / 2, CAM_H * 0.42, "RECORDING IN", String(counting), 180);
  drawSubtitles();
  if (!left && !right) label(W / 2, CAM_H * 0.32, "", "No hands detected - Show one or both hands", 26);
  g.restore();

  // log
  const vals = `Speed: ${+state.speed.toFixed(2)}x | Filter: ${filterLabel()} | Volume: ${Math.round(state.vol / VOL_MAX * 100)}%` +
               (echoOn ? ` | Echo: ${Math.round(state.echo * 100)}%` : "") +
               (state.crush ? ` | Crush: ${CRUSH_STEPS[state.crush].name}` : "") + (roll ? ` | Roll: ${ROLL_NAMES[roll.step]}` : "") +
               (state.octOn ? ` | Octaves: ${OCT_STEPS[state.oct].name}` : "") + (brake?.thrown ? " | Thrown away" : brake && !brake.up ? " | Record stop" : "") + (jungle ? ` | Jungle ${Math.round(jungleBpm())}` : "") + (state.bassOn ? " | Bass boost" : "") + (siren ? ` | Siren ${sirenLabel()}` : "");
  if (now - lastLog > 0.12 && vals !== lastVals && source) { log(`LEVELS | ${vals}`); lastLog = now; lastVals = vals; }
  drawTerminal();
  if (canvas.width > W) drawSpectrumBar(dt);
  trackCamLag();
  recFrame();                                    // a take in progress gets this frame, stamped with the audio clock
}

// ---------------------------------------------------------------- camera
// The camera you pick in Settings is remembered by its id and its name: Chrome can hand out a new id (another USB
// port, cleared site data), and the name still finds it. With nothing picked: the Mac's built-in FaceTime camera.
const CAM_KEY = "handdj.camera";
const savedCam = () => { try { return JSON.parse(store.get(CAM_KEY) || "null"); } catch { return null; } };
const listCams = async () => (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
function fillCamMenu(cams, current) {
  if (!cams.some(d => d.label)) return;          // names are only readable once camera access has been granted
  // built from elements, not HTML text: a device name is untrusted text and must not be able to carry markup
  $("cam").replaceChildren(...cams.map((d, i) => new Option(d.label || `Camera ${i + 1}`, d.deviceId, false, d.deviceId === current)));
}
const openCam = deviceId => navigator.mediaDevices.getUserMedia({
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, audio: false });

// deviceId: the camera just picked in the menu; none: the remembered one, else the default
async function startCamera(deviceId) {
  if (video.srcObject) video.srcObject.getTracks().forEach(t => t.stop());
  const saved = savedCam(), want = deviceId || saved?.id;
  let stream;
  try { stream = await openCam(want); }
  catch (err) {                                  // the remembered camera is unplugged or busy: take the default
    if (!want || err.name === "NotAllowedError") throw err;
    stream = await openCam();
  }
  video.srcObject = stream; await video.play();
  watchCamera();
  const cams = await listCams(), current = stream.getVideoTracks()[0].getSettings().deviceId;
  if (!deviceId) {                               // not a menu pick: is the camera we wanted under a new id?
    const better = cams.find(d => saved?.label && d.label === saved.label) || (!saved && cams.find(d => /facetime/i.test(d.label)));
    if (better && better.deviceId !== current) return startCamera(better.deviceId);
  }
  fillCamMenu(cams, current);
}
$("cam").onchange = e => {
  const opt = e.target.selectedOptions[0];
  store.set(CAM_KEY, JSON.stringify({ id: opt.value, label: opt.text }));
  e.target.blur();
  if (started) startCamera(opt.value).catch(err => status("Camera error: " + err.message));
};
// camera names show before Start when access was granted on an earlier visit
listCams().then(cams => fillCamMenu(cams, savedCam()?.id ?? cams.find(d => /facetime/i.test(d.label))?.deviceId)).catch(() => {});

// ---------------------------------------------------------------- controls

// subtitle controls: the OpenAI key and on / off live in this browser's localStorage. Without a usable key the
// switch stays off; once one is pasted it turns on (unless you turned subtitles off yourself).
$("openaiKey").value = openaiKey.get();
function keyUi() {
  const problem = keyProblem(), had = !$("subs").disabled;
  $("subs").disabled = !!problem;
  if (problem) $("subs").checked = false;
  else if (!had) $("subs").checked = store.get("handdj.subsOn") !== "0";
  $("keyHint").textContent = problem && openaiKey.get() ? problem : "Needed for subtitles. Kept only in this browser.";
  $("keyHint").classList.toggle("bad", !!problem && !!openaiKey.get());
}
$("subs").disabled = true; keyUi();
const subsChanged = () => {                     // a new key / turned back on: retry failed songs
  warnedKeys = false;
  tracks.forEach(t => { if (t.sub === "error") t.sub = undefined; });
  renderPlaylist(); pumpSubs();
};
// save as soon as the key is pasted or typed (change alone only fires when the box loses focus)
$("openaiKey").oninput = e => { openaiKey.set(e.target.value.trim()); keyUi(); };
$("openaiKey").onchange = e => { openaiKey.set(e.target.value.trim()); keyUi(); subsChanged(); };
$("subs").onchange = e => { store.set("handdj.subsOn", e.target.checked ? "1" : "0"); subsChanged(); };

let started = false;
let looping = false;
$("start").onclick = async () => {
  if (started) return; started = true; $("start").disabled = true; $("files").blur();
  try {
    if (!ctx) await setupAudio();               // a retry after an error reuses the audio and the frame loop
    log("Loading playlist...");
    status("Starting camera (allow access when Chrome asks)...");
    await startCamera();
    if (!looping) { looping = true; requestAnimationFrame(frame); }
    status("Loading hand tracking...");
    await setupHands();
    initGun3D();                                 // build the 3D pistol now so the first shot doesn't stall (off if no WebGL)
    log(`Air DJ started: ${tracks.length} track${tracks.length === 1 ? "" : "s"}`);
    await play(idx);
    $("rec").disabled = false; $("start").hidden = true;
    status("Running. Show your hands.");
    pumpSubs();                                   // transcribe + translate the whole playlist in the background
  } catch (err) {
    started = false; $("start").disabled = false; drawIntro();
    status(err.name === "NotAllowedError" ? "Camera blocked: allow it in Chrome's address bar, then ▶ Start." : "Error: " + err.message);
    console.error(err);
  }
};

// Enter: start / stop recording without reaching for the mouse (in the take preview: save)
addEventListener("keydown", e => {
  if (e.key !== "Enter" || e.repeat || !started) return;
  if (!$("syncDlg").hidden) { e.preventDefault(); $("syncSave").click(); return; }   // even with the slider focused
  if (e.target.closest("input, textarea, select")) return;
  e.preventDefault();
  if (!$("rec").disabled) $("rec").click();
});
addEventListener("keydown", e => {
  if (!started || !source || e.repeat || !$("syncDlg").hidden) return;   // the take preview has the keys to itself
  if (e.target.closest("input, textarea, select")) return;   // typing the API key must not switch tracks
  const k = e.key.toLowerCase();
  if (k === "n") nextTrack();
  if (k === "p") prevTrack();
  if (k === "3") firePad("L", 20, [W / 2, CAM_H / 2]);   // hi-hat
  if (k === "4") shootPistol("R");
  if (k === "6" && !paused) toggleJungle();
  if (k === "1") keyBass = true;
  if (k === "h") keyOct = true;
  if (k === "s") keySiren = true;
  if (k === "t") keyBrake = true;
  if (k === "x") keyThrow = true;               // throw it away (works while the song is held stopped: hold T)
  if (k === "e") { laserOn = !laserOn; log(`Laser eyes ${laserOn ? "on" : "off"}`); }
  if (k === "b") keyRoll = true;
  if (k === "c") keyCrushHeld = true;
  if (k === " ") { e.preventDefault(); togglePause(); }
});
addEventListener("keyup", e => { const k = e.key.toLowerCase(); if (k === "b") keyRoll = false; if (k === "c") keyCrushHeld = false; if (k === "1") keyBass = false; if (k === "h") keyOct = false; if (k === "s") keySiren = false; if (k === "t") keyBrake = false; });
addEventListener("blur", () => { keyRoll = keyCrushHeld = keyOct = keyBrake = keyBass = keySiren = false; });   // a held key must not stick on focus loss
canvas.addEventListener("mousemove", e => { const r = canvas.getBoundingClientRect(); mouseY = (e.clientY - r.top) / r.height * canvas.height / CAM_H; });   // mouse height stands in for hand height (keys H / C / S)

// ---------------------------------------------------------------- recording
// Record now, set the sync after. During a take nothing is guessed or shifted: the picture is encoded (H.264, the
// Mac's hardware encoder, via WebCodecs) and stamped with the audio clock, and the sound is kept as two raw stems,
// the song and the sounds your hands set off. On Stop a preview opens with one slider, the song's timing: the camera
// shows you a little late and you move to what you hear, so the song usually needs holding back a bit for your moves
// to land on its beat. The slider moves only the song (the hand sounds stay on their gestures) and plays back at
// once, without re-encoding; Save mixes the stems the way the speakers did, encodes AAC and muxes the MP4
// (vendor/mp4-muxer.mjs). The chosen timing is remembered for the next take. Browsers without WebCodecs fall back
// to MediaRecorder.
const REC_VIDEO_BPS = 12_000_000, REC_AUDIO_BPS = 256_000;   // 12 Mbit/s video, 256 kbit/s audio
const REC_MAX_FPS = 60, REC_KEY_EVERY = 1;       // most frames a second recorded; s between keyframes (for seeking)
const SYNC_MIN = -300, SYNC_MAX = 800;           // ms the slider can move the song (+ = later)
const TAP_SRC = `class RecTap extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.buf = null; this.port.onmessage = e => { this.on = e.data; if (!this.on) this.flush(); }; }
  flush() { if (this.buf && this.n) this.port.postMessage({ frame: this.start, n: this.n, l: this.buf[0], r: this.buf[1] }, [this.buf[0].buffer, this.buf[1].buffer]); this.buf = null; }
  process(inputs) {
    if (!this.on) return true;
    const inp = inputs[0], len = inp[0] ? inp[0].length : 128;
    if (!this.buf) { this.buf = [new Float32Array(4096), new Float32Array(4096)]; this.n = 0; this.start = currentFrame; }
    if (inp[0]) { this.buf[0].set(inp[0], this.n); this.buf[1].set(inp[1] || inp[0], this.n); }   // silence stays zeros
    this.n += len;
    if (this.n >= 4096) this.flush();
    return true;
  }
}
registerProcessor("rec-tap", RecTap);`;
// a first guess for the song's timing before you've set one: the camera's lag plus the audio output latency
let camCapture = null, camLag = 0.1;             // perf-clock ms the newest camera frame was filmed; smoothed lag in s
let watchingCamera = false;
function watchCamera() {                         // one watcher for the whole session (it follows camera changes)
  if (watchingCamera || !video.requestVideoFrameCallback) return;
  watchingCamera = true;
  const f = (now, md) => { if (md.captureTime) camCapture = md.captureTime; video.requestVideoFrameCallback(f); };
  video.requestVideoFrameCallback(f);
}
function trackCamLag() {
  if (camCapture === null) return;
  camLag += (clamp((performance.now() - camCapture) / 1000, 0, 0.5) - camLag) * 0.05;
}
const syncDefault = () => {
  const v = store.get("handdj.syncMs", null); if (v !== null) return +v;
  return Math.round((camLag + (ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000);
};

let rec = null, taps = null;
async function stemTaps() {                      // one tap per stem, fed by the same nodes that feed the master
  if (taps) return taps;
  const url = URL.createObjectURL(new Blob([TAP_SRC], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
  const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);   // keeps them running
  taps = {};
  for (const k of ["song", "fx"]) {
    const t = new AudioWorkletNode(ctx, "rec-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: "explicit" });
    for (const n of recStemIn[k]) n.connect(t);
    t.connect(sink); t.port.onmessage = e => recAudio(k, e.data);
    taps[k] = t;
  }
  return taps;
}
async function pickConfigs(w, h, sr) {
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") return null;
  let vcfg = null;
  for (const codec of ["avc1.640033", "avc1.640028", "avc1.4d0033"]) {
    const c = { codec, width: w, height: h, bitrate: REC_VIDEO_BPS, framerate: REC_MAX_FPS, latencyMode: "quality", avc: { format: "avc" } };
    if ((await VideoEncoder.isConfigSupported(c).catch(() => ({}))).supported) { vcfg = c; break; }
  }
  // AAC only: Opus inside an MP4 plays silent in QuickTime, Finder and on Instagram
  const acfg = { codec: "mp4a.40.2", sampleRate: sr, numberOfChannels: 2, bitrate: REC_AUDIO_BPS, aac: { format: "aac" } };
  const aok = AAC_RATES.includes(sr) && (await AudioEncoder.isConfigSupported(acfg).catch(() => ({}))).supported;
  return vcfg && aok ? { video: vcfg, audio: acfg } : null;
}
async function startRecording() {
  const w = canvas.width & ~1, h = canvas.height & ~1, sr = ctx.sampleRate;
  const cfg = await pickConfigs(w, h, sr);
  if (!cfg) return false;
  await stemTaps();
  const t0 = ctx.currentTime;
  const r = rec = { cfg, w, h, sr, t0, startFrame: Math.round(t0 * sr), stopFrame: Infinity, chunks: [], stems: { song: [], fx: [] },
                    motion: [], lastV: -1, lastKey: -1e9, frames: 0, dropped: 0, error: null, pending: 2 };
  r.venc = new VideoEncoder({ output: (c, m) => r.chunks.push({ c, m }), error: err => { r.error = err; } });
  r.venc.configure(cfg.video);
  for (const t of Object.values(taps)) t.port.postMessage(true);
  return true;
}
function recAudio(k, { frame: at, n, l, r }) {   // keep each stem as 16-bit blocks (half the memory of floats)
  if (!rec) return;
  const from = Math.max(at, rec.startFrame), to = Math.min(at + n, rec.stopFrame);
  if (to > from) {
    const o = from - at, q = to - from, b = new Int16Array(q * 2);
    for (let i = 0; i < q; i++) { b[i] = clamp(l[o + i], -1, 1) * 32767; b[q + i] = clamp(r[o + i], -1, 1) * 32767; }
    rec.stems[k].push({ at: from - rec.startFrame, q, b });
  }
  if (at + n >= rec.stopFrame && !rec["done_" + k]) { rec["done_" + k] = true; if (--rec.pending === 0) rec.audioDone?.(); }
}
function recMotion(left, right) {                // where your hands were seen, per tracked frame of the take: for Auto sync
  if (!rec || rec.stopping) return;
  const h = x => x ? [x.palm[0], x.palm[1], x.size] : null;
  rec.motion.push({ t: ctx.currentTime - rec.t0, L: h(left), R: h(right) });
}
function recFrame() {                            // after a frame is fully drawn: stamp it with the audio clock and encode
  if (!rec || rec.stopping || rec.error) return;
  const t = rec.lastV < 0 ? 0 : ctx.currentTime - rec.t0;   // the first frame opens the take, like the sound
  if (t < rec.lastV + 1 / REC_MAX_FPS - 1e-4) return;   // paused (the clock stands still) or faster than REC_MAX_FPS
  if (rec.venc.encodeQueueSize > 6) { rec.dropped++; return; }   // the encoder can't keep up: skip, don't pile up
  const key = t - rec.lastKey >= REC_KEY_EVERY;
  if (key) rec.lastKey = t;
  const dur = rec.lastV < 0 ? 1 / 30 : Math.min(t - rec.lastV, 1 / 15);   // the muxer wants a duration on every frame
  const vf = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.max(1, Math.round(dur * 1e6)),
                                      visibleRect: { x: 0, y: 0, width: rec.w, height: rec.h } });
  rec.venc.encode(vf, { keyFrame: key }); vf.close();
  rec.lastV = t; rec.frames++;
}
// Stop: wait for the last sound, finish the video, and turn the stems into AudioBuffers (one copy of the sound).
async function stopRecording() {
  const r = rec; r.stopping = true;
  r.stopFrame = Math.round(ctx.currentTime * r.sr);
  await new Promise(res => { r.audioDone = res; setTimeout(res, 800); for (const t of Object.values(taps)) t.port.postMessage(false); });
  await r.venc.flush(); r.venc.close();
  rec = null;
  if (r.error) throw r.error;
  const N = r.stopFrame - r.startFrame;
  if (N < r.sr) throw new Error("the take is too short (was the music paused?)");
  const stem = k => {
    const b = new AudioBuffer({ length: N, numberOfChannels: 2, sampleRate: r.sr }), L = b.getChannelData(0), R = b.getChannelData(1);
    for (const { at, q, b: d } of r.stems[k]) for (let i = 0; i < q && at + i < N; i++) { L[at + i] = d[i] / 32767; R[at + i] = d[q + i] / 32767; }
    r.stems[k] = null;
    return b;
  };
  const song = stem("song"), fx = stem("fx");
  return { cfg: r.cfg, w: r.w, h: r.h, sr: r.sr, N, secs: N / r.sr, frames: r.frames, dropped: r.dropped,
           chunks: r.chunks, motion: r.motion, songBuf: song, fxBuf: fx, song: [song.getChannelData(0), song.getChannelData(1)] };
}
// Auto sync: when you move to music, your sharpest hand moves (a clap, a hit, the turn of a bounce) land on its
// hits. So: how sharply the hands move over time (acceleration, relative to hand size) is lined up against where
// the song's hits are (jumps in its loudness), for every song delay from AUTO_MIN to AUTO_MAX, and the best match
// wins. Beats repeat, so a delay a whole beat off matches too: the search stays in the range real delays have and
// leans towards the first guess (camera lag + audio latency). Returns { ms, sure } or null without enough hand motion.
const AUTO_MIN = 0, AUTO_MAX = 500, AUTO_STEP = 5, AUTO_HOP = 0.01;   // ms range and step; s per analysis step
function autoSync(take, priorMs) {
  const hop = AUTO_HOP, K = Math.floor(take.secs / hop);
  if (K < 300) return null;                     // under 3 s: not enough to go on
  // the song's hits: positive jumps in loudness (log energy per 10 ms)
  const n = Math.round(take.sr * hop), [SL, SR] = take.song, hit = new Float32Array(K);
  let prev = 0;
  for (let k = 0; k < K; k++) {
    let e = 0; for (let i = k * n; i < (k + 1) * n; i++) { const v = SL[i] + SR[i]; e += v * v; }
    const le = Math.log(e / n + 1e-9); hit[k] = k ? Math.max(0, le - prev) : 0; prev = le;
  }
  // the hands' sharpness: |acceleration| / hand size, per frame, spread onto the same 10 ms grid
  const mot = new Float32Array(K), cnt = new Float32Array(K), M = take.motion;
  let frames = 0;
  for (let i = 1; i < M.length - 1; i++) {
    let a = 0, any = false;
    for (const s of ["L", "R"]) {
      const p0 = M[i - 1][s], p1 = M[i][s], p2 = M[i + 1][s];
      if (!p0 || !p1 || !p2) continue;
      const d1 = M[i].t - M[i - 1].t, d2 = M[i + 1].t - M[i].t;
      if (d1 <= 0 || d2 <= 0 || d1 > 0.15 || d2 > 0.15) continue;
      const vx1 = (p1[0] - p0[0]) / d1, vy1 = (p1[1] - p0[1]) / d1, vx2 = (p2[0] - p1[0]) / d2, vy2 = (p2[1] - p1[1]) / d2;
      a += Math.hypot(vx2 - vx1, vy2 - vy1) / ((d1 + d2) / 2) / p1[2]; any = true;
    }
    if (!any) continue;
    frames++;
    const k = Math.round(M[i].t / hop);
    for (let j = Math.max(0, k - 2); j <= Math.min(K - 1, k + 2); j++) { mot[j] += a; cnt[j]++; }
  }
  if (frames < 60) return null;                  // the hands were hardly on screen
  for (let k = 0; k < K; k++) if (cnt[k]) mot[k] /= cnt[k];
  const z = x => { let m = 0, v = 0; for (const y of x) m += y; m /= x.length; for (const y of x) v += (y - m) ** 2; v = Math.sqrt(v / x.length) || 1; return x.map(y => (y - m) / v); };
  const hitZ = z(hit), motZ = z(mot);
  // score each delay: the song (delayed by d) against the hands
  const scores = [];
  for (let ms = AUTO_MIN; ms <= AUTO_MAX; ms += AUTO_STEP) {
    const d = Math.round(ms / 1000 / hop); let sc = 0, c = 0;
    for (let k = d; k < K; k++) { sc += motZ[k] * hitZ[k - d]; c++; }
    scores.push({ ms, sc: sc / Math.max(1, c) });
  }
  const vals = scores.map(x => x.sc), mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
  const prior = ms => Math.exp(-(((ms - priorMs) / 250) ** 2) / 2);
  let best = scores[0];
  for (const x of scores) if ((x.sc - mean) / sd + 0.6 * prior(x.ms) > (best.sc - mean) / sd + 0.6 * prior(best.ms)) best = x;
  // best.sc is the correlation itself: ~0.5 for moves on the beat, ~0.05 for moves unrelated to it
  return { ms: best.ms, sure: best.sc > 0.1 };
}

// The take's sound at a given song timing: the two stems through the same master stage as the speakers, offline.
async function mixTake(take, syncMs) {
  const oc = new OfflineAudioContext({ numberOfChannels: 2, length: take.N, sampleRate: take.sr }), out = masterStage(oc);
  out.output.connect(oc.destination);
  const d = syncMs / 1000, song = oc.createBufferSource(), fx = oc.createBufferSource();
  song.buffer = take.songBuf; fx.buffer = take.fxBuf;
  song.connect(out.input); fx.connect(out.input);
  if (d >= 0) song.start(d); else song.start(0, -d);   // later: starts later; earlier: skips its first moments
  fx.start(0);
  return oc.startRendering();
}
function fileSink() {                            // the MP4 as it's written: appended, plus small patches (box sizes)
  const parts = []; let end = 0;
  return {
    onData(data, pos) {
      for (const p of parts) {
        const a = Math.max(pos, p.pos), b = Math.min(pos + data.length, p.pos + p.bytes.length);
        if (a < b) p.bytes.set(data.subarray(a - pos, b - pos), a - p.pos);
      }
      if (pos + data.length > end) { const from = Math.max(pos, end); parts.push({ pos: from, bytes: data.slice(from - pos) }); end = pos + data.length; }
    },
    blob: type => new Blob(parts.sort((x, y) => x.pos - y.pos).map(p => p.bytes), { type }),
  };
}
// AAC's AudioSpecificConfig (object type 2 = AAC-LC, sample-rate index, 2 channels), in case the encoder doesn't give it
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
const aacConfig = sr => { const i = AAC_RATES.indexOf(sr); return new Uint8Array([(2 << 3) | (i >> 1), ((i & 1) << 7) | (2 << 3)]); };
async function muxTake(take, sound) {            // the recorded picture + a mixed sound (or none, for the preview) -> MP4
  const sink = fileSink();
  const muxer = new Muxer({
    target: new StreamTarget({ onData: (d, p) => sink.onData(d, p), chunked: true, chunkSize: 2 ** 24 }),
    video: { codec: "avc", width: take.w, height: take.h },
    ...(sound ? { audio: { codec: "aac", numberOfChannels: 2, sampleRate: take.sr } } : {}),
    fastStart: false, firstTimestampBehavior: "strict",   // both tracks start at 0 on the same clock
  });
  for (const { c, m } of take.chunks) muxer.addVideoChunk(c, m);
  if (sound) {
    let first = true, err = null;
    const aenc = new AudioEncoder({ output: (c, m) => {
      if (first) { first = false; if (!m?.decoderConfig?.description) m = { decoderConfig: { codec: "mp4a.40.2", sampleRate: take.sr, numberOfChannels: 2, description: aacConfig(take.sr) } }; }
      muxer.addAudioChunk(c, m);
    }, error: e => { err = e; } });
    try {
      aenc.configure(take.cfg.audio);
      const L = sound.getChannelData(0), R = sound.getChannelData(1);
      for (let from = 0; from < take.N; from += 4096) {
        const n = Math.min(4096, take.N - from), data = new Float32Array(n * 2);
        data.set(L.subarray(from, from + n), 0); data.set(R.subarray(from, from + n), n);
        const ad = new AudioData({ format: "f32-planar", sampleRate: take.sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(from / take.sr * 1e6), data });
        aenc.encode(ad); ad.close();
        if (aenc.encodeQueueSize > 50) await new Promise(r => setTimeout(r, 0));
      }
      await aenc.flush();
    } finally { if (aenc.state !== "closed") aenc.close(); }
    if (err) throw err;
  }
  muxer.finalize();
  return sink.blob("video/mp4");
}
function saveTake(blob, ext) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const d = new Date(), two = n => String(n).padStart(2, "0");   // local date and time, e.g. air-dj-2026-11-27-183205
  a.download = `air-dj-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return a.download;
}
const recUi = on => {
  $("rec").classList.toggle("on", on); $("rec").firstChild.textContent = on ? "■ Stop " : "● Rec ";
  $("layout").disabled = $("cam").disabled = on;   // a new layout or camera resizes the canvas: not mid-take
};

// ---- the sync preview: the picture plays in a <video>, the sound is mixed live from the stems, so the slider is instant
let syncTake = null, pv = null, pvIn = null, pvSrcs = [], pvWasPaused = false, saving = false;
async function openSync(take) {
  pvWasPaused = paused;
  if (!paused) { paused = true; await ctx.suspend(); updateTransport(0, true); }   // the live song waits while you watch
  if (!pv) { pv = new AudioContext({ sampleRate: take.sr }); const out = masterStage(pv); out.output.connect(pv.destination); pvIn = out.input; }
  await pv.resume();
  const v = $("syncVid");
  v.src = URL.createObjectURL(await muxTake(take, null));   // picture only; the sound comes from the stems
  syncTake = take;
  $("syncMs").min = SYNC_MIN; $("syncMs").max = SYNC_MAX; $("syncMs").value = clamp(syncDefault(), SYNC_MIN, SYNC_MAX);
  runAutoSync(true);
  $("syncInfo").textContent = `${Math.round(take.secs)} s, ${Math.round(take.frames / take.secs)} fps` + (take.dropped ? `, ${take.dropped} frames skipped (the computer was busy)` : "");
  $("syncDlg").hidden = false;
  v.currentTime = 0; v.play().catch(() => {});
}
function runAutoSync(onOpen) {                   // the Auto sync button (and once by itself when the preview opens)
  const t = syncTake, r = t && autoSync(t, +$("syncMs").value);
  if (!r) {
    showSync();
    $("syncAutoMsg").textContent = onOpen ? "" : "Not enough hand movement in this take to match: move or clap to the beat while recording, or set it by eye.";
    return;
  }
  $("syncMs").value = clamp(r.ms, SYNC_MIN, SYNC_MAX); showSync(); pvSync();
  $("syncAutoMsg").textContent = r.sure ? `Auto sync matched your moves to the song: ${r.ms} ms.` : `Auto sync's best guess: ${r.ms} ms (not sure: check it by eye).`;
}
function showSync() {
  const ms = +$("syncMs").value;
  $("syncVal").textContent = ms === 0 ? "as recorded" : `song ${Math.abs(ms)} ms ${ms > 0 ? "later" : "earlier"}`;
}
function pvStop() { for (const src of pvSrcs) try { src.stop(); } catch {} pvSrcs = []; }
function pvSync() {                              // (re)start the stems in step with the <video>
  pvStop();
  const v = $("syncVid"), t = syncTake;
  if (!t || v.paused || v.ended) return;
  const at = v.currentTime, d = +$("syncMs").value / 1000, when = pv.currentTime + 0.03;
  const go = (b, pos) => {
    if (pos >= b.duration) return;
    const src = pv.createBufferSource(); src.buffer = b; src.playbackRate.value = v.playbackRate; src.connect(pvIn);
    src.start(when + Math.max(0, -pos) / v.playbackRate, Math.max(0, pos)); pvSrcs.push(src);
  };
  go(t.songBuf, at - d); go(t.fxBuf, at);
}
function closeSync() {
  pvStop(); pv?.suspend();
  const v = $("syncVid"); v.pause(); if (v.src) URL.revokeObjectURL(v.src); v.removeAttribute("src"); v.load();
  $("syncDlg").hidden = true; syncTake = null;
  if (!pvWasPaused && paused) { paused = false; ctx.resume(); updateTransport(0, true); }
}
for (const ev of ["play", "seeked", "ratechange"]) $("syncVid").addEventListener(ev, pvSync);
for (const ev of ["pause", "ended", "seeking"]) $("syncVid").addEventListener(ev, pvStop);
$("syncMs").oninput = () => { showSync(); pvSync(); };
$("syncNudge").onclick = e => { const d = +e.target.dataset.d; if (!d) return; $("syncMs").value = clamp(+$("syncMs").value + d, SYNC_MIN, SYNC_MAX); showSync(); pvSync(); };
$("syncDiscard").onclick = () => {
  if (saving || !confirm("Discard this take?")) return;
  closeSync(); status("Take discarded.");
};
addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("syncDlg").hidden) { e.preventDefault(); $("syncDiscard").click(); }
});
$("syncAuto").onclick = () => runAutoSync(false);
$("syncSave").onclick = async () => {
  if (saving || !syncTake) return;
  const t = syncTake, ms = +$("syncMs").value;
  saving = true; $("syncSave").disabled = $("syncDiscard").disabled = true; $("syncSave").textContent = "Saving...";
  try {
    const name = saveTake(await muxTake(t, await mixTake(t, ms)), "mp4");
    store.set("handdj.syncMs", String(ms));
    closeSync();
    status(`Saved ${name} to Downloads (song timing ${ms} ms, remembered for the next take).`);
  } catch (err) { console.error(err); status(`Saving failed: ${err.message}`); }
  finally { saving = false; $("syncSave").disabled = $("syncDiscard").disabled = false; $("syncSave").textContent = "Save video"; }
};

// fallback: MediaRecorder (no WebCodecs / AAC): no sync preview
let recorder, chunks = [];
function startMediaRecorder() {
  const picture = canvas.captureStream().getVideoTracks();
  const stream = new MediaStream([...picture, ...dest.stream.getAudioTracks()]);
  const type = ["video/mp4;codecs=avc1.640033,mp4a.40.2", "video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
                "video/webm;codecs=vp9,opus", "video/webm"].find(t => MediaRecorder.isTypeSupported(t));
  recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: REC_VIDEO_BPS, audioBitsPerSecond: REC_AUDIO_BPS });
  chunks = [];
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    picture.forEach(t => t.stop());              // the canvas capture would keep running otherwise
    const ext = type.startsWith("video/mp4") ? "mp4" : "webm", name = saveTake(new Blob(chunks, { type }), ext);
    chunks = []; recUi(false);
    status(`Saved ${name} to Downloads.` + (ext === "webm" ? " Convert for Instagram: ffmpeg -i file.webm -c:v libx264 -c:a aac out.mp4" : ""));
  };
  recorder.start(1000);
}

// Count-in before a take from the first track: the music stops, a big 3, 2, 1 with a click each second (not
// recorded), then the playlist starts from its first track at the same moment the recording starts.
const COUNT_IN = 3;
let counting = null;
async function countIn() {
  if (paused) { paused = false; await ctx.resume(); }
  if (source) { source.onended = null; try { source.stop(); } catch {} }
  stopRoll(true); brake = null; stopSiren();
  for (let n = COUNT_IN; n >= 1; n--) {
    counting = n;
    tone("sine", n === 1 ? 1760 : 1320, n === 1 ? 1760 : 1320, ctx.currentTime + 0.005, 0.08, 0.5);
    await new Promise(r => setTimeout(r, 1000));
  }
  counting = null;
  bursts.push({ x: W / 2, y: CAM_H * 0.45, name: "REC", t: performance.now() / 1000, quiet: true });
}

let recBusy = false;
$("rec").onclick = async () => {
  if (recBusy || syncTake) return;
  recBusy = true;
  try {
    if (rec) {
      status("Preparing the take...");
      const take = await stopRecording();
      recUi(false);
      await openSync(take);
      status("Set the song's timing in the preview, then Save.");
    } else if (recorder && recorder.state === "recording") {
      recorder.stop();
    } else {
      const top = $("recTop").checked;
      if (top) { await decode(0); await countIn(); }   // 3-2-1, then the first track (decoded already) and the take start together
      if (await startRecording().catch(err => (console.warn("WebCodecs recording unavailable:", err), false))) {
        status("Recording... keep this tab in front: Chrome slows down hidden tabs, and the take would stutter.");
      } else {
        startMediaRecorder();
        status("Recording (fallback mode, no sync preview)... keep this tab in front.");
      }
      if (top) await play(0, 0, { immediate: true });
      recUi(true);
    }
  } catch (err) {
    console.error(err); rec = null; recUi(false); closeSync(); status(`Recording failed: ${err.message}`);
  } finally { recBusy = false; }
};
