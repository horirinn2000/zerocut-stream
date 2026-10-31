# Gameplay Recording Specification (External / Regional Player Guide)

This 1-page specification defines the technical and playstyle requirements when recording raw indie game footage (`raw.mp4`) for a ZeroCut Stream compliant channel.

## 1. Audio & Language Settings (Mandatory)
- **Microphone Strictly OFF**: Record **game audio ONLY**. Mute or disconnect all microphones (`0%` mic input). Voice commentary is added separately post-recording.
- **Steam Game Language -> Japanese (`日本語`)**:
  - Before launching the game, right-click the title in your Steam Library -> **Properties** -> **General** -> **Language** -> select **Japanese (`日本語`)** whenever available.
  - If the game does not offer Japanese localization, leave the default English UI as-is.

## 2. Playstyle Direction
- **Blind First Playthrough Only**: Do **not** read walkthroughs, wikis, or speedrun guides prior to recording. Genuine discovery, trial-and-error, surprise traps, and comical failures make the best footage.
- **Bold & Active Exploration**: Do not stall or play overly passively. Keep moving, test suspicious mechanics boldly, and immediately retry upon game-over rather than idling on pause screens.
- **Respect Streaming Guidelines**: Follow any chapter/ending spoiler limits noted in the assignment ticket for that title.

## 3. Technical Recording Requirements
- **Resolution & Frame Rate**: `1920x1080` (`1080p`), `60 fps` progressive.
- **Container & Codecs**: `.mp4` (or `.mkv` remuxed to `.mp4`), video `H.264` (`15–25 Mbps` CBR/CRF 18–20), audio `AAC 48 kHz Stereo` (`192 kbps+`).
- **Clean Screen (Zero Popups)**:
  - Turn **OFF** OS notifications (Windows Focus Assist / macOS Do Not Disturb).
  - Turn **OFF** Steam Friend/Achievement popups, Discord overlays, FPS counters, and personal watermarks.
  - Capture the game window/fullscreen cleanly at native 16:9 aspect ratio without black borders.

## 4. Delivery & Access Isolation
- **Delivery**: Upload the unedited recording file (`raw.mp4`) to the designated **write-only cloud upload folder** linked in your assignment ticket.
- **Strict Role Separation**: Recording contributors only deliver raw gameplay video files. Contributors are never granted access to the YouTube channel, AdSense account, database, Steam key inventory, or settlement ledger.
- **Compensation Basis**: Under the ZeroCut Public Ledger Protocol, play recording compensation is accounted transparently using fixed public standard minutes (`playMinutesPerVideo` in `docs/public_constants.json`) and the published regional hourly rate (`regionalLaborRatesJpyPerHour`) for your region, never exceeding local minimum wage requirements.
