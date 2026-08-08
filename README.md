# Roscoe's Wonder Lab

An offline-first, landscape Progressive Web App with eight cause-and-effect Labs designed for a tablet.

## Labs

1. Switch Lab
2. Shape Lab
3. Action Lab
4. Color Lab
5. Art Lab
6. Motion Lab
7. Picture Lab
8. Time Lab

## Companion

Caregiver-facing pictures, saved Art Lab drawings, Wonder Log data, and tablet pairing live in the Wonder Lab Companion:

https://wonderlab-companion.nickspeelman.com/

The tablet pairs with the Companion using an 8-digit code. Once paired, pictures, queued drawings, and Wonder Log observations sync automatically when online. Settings also provides a unified **Sync now** action.

The tablet does not sign directly into Google and does not need Google Drive OAuth credentials.

## Settings

Tap the gear and type `ENTER`.

Settings are grouped into:

- **Audio** — voice responses, sound effects, volume
- **Interaction** — tilt controls
- **Companion** — QR access, pairing, unified sync, Wonder Log collection, local Wonder Log reset
- **About** — app build version read from `sw.js`
- **Reset** — current Lab (when inside a Lab) and all Labs

The Companion QR code appears directly in Settings and again in the pairing dialog.

## Saving drawings

Art Lab includes a child-accessible save button. A saved drawing is stored locally first, then uploaded through the paired backend when internet access is available. Saved drawings can be viewed, downloaded, and deleted from the Companion.

## Wonder Log

Wonder Log records play sessions, Lab entry/exit time, meaningful interactions, and milestones locally and syncs them to the Companion. Raw touch samples remain local and are not uploaded.

Wonder Log sync is attempted:

- at app startup when paired and online
- when connectivity returns
- when returning Home
- periodically while the app remains open
- when **Sync now** is pressed in Settings

The tablet's local Wonder Log history can be cleared independently of already-synced Companion history.

## Offline behavior

Lab state, drawings waiting to sync, pairing information, and Wonder Log observations are stored locally. The app shell is cached for offline use. Core application files use network-first loading when online so a new release cannot leave the service worker and JavaScript on mismatched versions.

## Build version

The displayed build version is derived from the service worker cache name, for example:

```js
const CACHE = 'roscoe-wonder-lab-26.7';
```

The IndexedDB schema has a separate `DB_VERSION` constant in `js/app.js`.

## Deployment

Serve the repository root over HTTPS (for example, GitHub Pages/custom domain). On the tablet, install the site as a PWA or run it in the desired kiosk/full-screen configuration.
