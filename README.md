# Roscoe's Wonder Lab — (Version V12|V12)

An offline-first, landscape Progressive Web App for an Android tablet.

## What changed in (Version V12|V12)

(Version V12|V12) adds the complete file-based sound-effects system and an empty audio folder structure ready for custom MP3 files.

- Every ordinary button press plays `audio/ui/click.mp3`.
- Switch Lab controls use `audio/ui/toggle.mp3`.
- Shape Lab pops use `audio/ui/pop.mp3`.
- The broom uses `audio/ui/broom.mp3`.
- Light, Stars, and Rainbow are one-shot switch sounds.
- Rain, Bubbles, Train, Wind, Snow, and Lightning are looping ambient sounds.
- Lightning uses one looping thunder/storm file; there are no separate thunder events.
- Motion Lab supports pickup, drop, collision, bounce, spawn, and remove sounds.
- Motion collisions are thresholded and rate-limited to prevent noisy audio piles.
- Voice is mixed louder than effects. Ambient loops are quietest, automatically balanced when several are active, and ducked while speech plays.
- Missing audio files fail silently, so the app remains fully functional while files are being sourced.

See `audio/README.txt` and each audio subfolder's README for exact filenames.

## Previous V7 changes

V7 introduces the **Roscoe's Wonder Lab** name and uses consistent lab language throughout the interface. It retains V4's restrained spoken-language layer and all V3 Drive and analytics features.

- **Voice responses** and **Sound effects** are now separate parent controls.
- Voice responses use Android/Chrome's built-in speech synthesis; no recorded voice files, microphone access, or cloud speech service is used.
- Spoken phrases are short descriptions of actions, never instructions or tests.
- Examples include `Train on`, `Bubbles off`, `Circle`, `Pop`, `Red`, `Brighter`, `Ball`, `Home`, and `Clean up`.
- Every lab remains fully usable with voice responses off, sound effects off, or both off.
- Existing installs retain their saved lab state, drawings, preferences, and Wonder Log data.

The customizable picture-word lab discussed for a future version is intentionally not included in V7.

## One-time Google setup

These steps should be completed with the Google Workspace account that administers your domain.

1. Open Google Cloud Console and create or select a project for Roscoe's Wonder Lab.
2. Enable **Google Drive API** for that project.
3. Configure the Google Auth platform / OAuth consent screen.
   - Choose **Internal** audience if the tablet account belongs to your Workspace domain.
   - Use a recognizable app name such as `Roscoe's Wonder Lab`.
4. Create an OAuth client:
   - Application type: **Web application**
   - Add the exact site origin under **Authorized JavaScript origins**.
   - Examples:
     - `https://yourname.github.io`
     - `https://wonderlab.yourdomain.com`
   - An origin does not include the repository path or a trailing slash.
5. Copy the client ID into `js/config.js`:

```js
window.ROSCOE_CONFIG = {
  GOOGLE_CLIENT_ID: '1234567890-example.apps.googleusercontent.com',
  DRIVE_FOLDER_ID: '',
  DRIVE_ROOT_FOLDER_NAME: "Roscoe's Wonder Lab",
  DRIVE_DRAWINGS_FOLDER_NAME: 'Drawings'
};
```

Leave `DRIVE_FOLDER_ID` blank to let the app create:

```text
My Drive/
└── Roscoe's Wonder Lab/
    └── Drawings/
```

You may instead paste the ID of an existing Drive folder into `DRIVE_FOLDER_ID`; drawings will be uploaded directly to that folder.

## First tablet authorization

1. Sign the Android tablet into the dedicated Workspace account.
2. Install Roscoe's Wonder Lab from Chrome.
3. Open **Wonder Lab Settings** by tapping the gear and typing `ENTER`.
4. Open the Art Lab and make a test mark.
5. Tap **Save to Drive**.
6. Complete Google's account/permission dialog once.
7. Confirm the PNG appears in Drive.

Google browser access tokens are deliberately short-lived and are not permanently stored by the PWA. The drawing queue is permanent, but a parent may occasionally need to tap **Connect / sync** after a restart or authorization expiration.

## Included labs

- Switch Lab
- Shape Lab
- Action Lab
- Color Lab
- Art Lab
- Motion Lab

## Adult controls

Tap the gear and type `ENTER`.

- Voice responses on/off
- Sound effects on/off
- Shared audio volume
- Tilt on/off
- Turn local usage insights on/off
- View the engagement dashboard
- Export usage history as CSV or JSON
- Save the current drawing to Google Drive
- View queued/sync status and reconnect Drive
- Reset the current lab
- Reset all labs (requires typing `RESET`)

## Spoken responses

The app uses brief, action-linked phrases:

- Switch Lab: `Light on`, `Rain off`, `Train on`, and similar
- Shape Lab: shape names and `Pop`
- Action Lab: `Ball`, `Spin`, `Train`, `Sparkle`, `Confetti`, and `Stomp`
- Color Lab: color on/off, `Brighter`, and `Darker`
- Art Lab: selected paint/tool name
- Motion Lab: `Ball` or `Block` when an object is touched
- Navigation: `Home` and `Clean up`

The browser selects an available English device voice. Speech is deliberately canceled and replaced when a newer action occurs, preventing a long backlog of words after rapid tapping.

## Engagement insights

All usage data stays in IndexedDB on the tablet. The app does not use Google Analytics, advertising identifiers, cloud telemetry, cameras, microphones, contacts, or location.

The parent dashboard includes:

- Play time and session count for the last seven days
- Average session duration
- Activity receiving the most time
- Newest discovered interaction
- Art Labs saved to Drive
- Most-used drawing color
- Time by lab
- Sampled touch heat maps by lab

Parents can disable collection, export CSV/JSON, or erase history by typing `ERASE`.

## Running locally

PWAs and service workers must be served over HTTP rather than opened directly as a file.

```bash
cd roscoes-wonder-lab-v6
python -m http.server 8000
```

Then open `http://localhost:8000`.

Google OAuth will not work from a local origin unless that exact origin is added to the OAuth client's authorized JavaScript origins. For production testing, use the final HTTPS GitHub Pages or custom-domain URL.

## Deploying to GitHub Pages

1. Upload the contents of this folder to the repository root.
2. In **Settings → Pages**, publish from the main branch/root.
3. Add the resulting HTTPS origin to the Google OAuth client.
4. Open the site in Chrome on the Android tablet.
5. Choose **Install app** or **Add to Home screen**.
6. Open the installed app and enable Android screen pinning.

## Storage and failure behavior

- Activity state, analytics, and pending drawing uploads are stored independently in IndexedDB.
- The broom resets only the current lab.
- Clearing the current drawing does not delete copies already queued or uploaded.
- A queued drawing is removed locally only after Google Drive confirms a successful upload.
- Failed uploads remain queued and expose a readable status in Wonder Lab Settings.
- No OAuth access or refresh token is written to IndexedDB.

## Version 12 changes

- Home tiles now fill the full available home-screen grid.
- All nine Switch Lab controls fill the complete lab canvas in a uniform 3 x 3 grid.
- Color Lab reaches full pigment saturation at level 5 for an individual color.
- Motion Lab replaces triangles with rotating sticks. Existing saved Motion Lab triangles migrate to sticks automatically.
- The Clean Up broom is substantially larger and follows the same slow zig-zag sweep.


## V15 fixes
- Train now faces the direction it travels.
- Brightness level is centered and sized like the red/yellow/blue controls.
- Removed synthesized button beeps; only supplied sound files and voice responses remain.
- Motion Lab waits for a valid canvas size before simulating and repairs invalid saved positions from older builds.
- Cleanup stops the old physics loop before restoring default objects.
