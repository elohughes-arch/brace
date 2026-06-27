# Brace app → native (photos & videos permission)

The web app can only ever show a **one‑off file picker** — browsers (especially iOS
Safari) do not grant a website ongoing access to the photo library. To get the real
**"Allow Brace to access your photos & videos"** permission (and read Meta‑glasses
clips from the Camera Roll), the app must run as a **native app**. The clean way is
to **wrap this exact codebase with Capacitor** — no rewrite.

There are two native approaches. Pick based on the UX you want:

| Approach | Prompt shown | Access | Plugin |
|---|---|---|---|
| **A. Library permission** (what you asked for) | "Allow access to your photos & videos" (All / Selected) | Browse & read the whole library, auto‑detect new clips | `@capacitor-community/media` (or `capacitor-photo-library`) |
| **B. System picker (PHPicker)** | none (privacy‑preserving) | User taps a single clip; app gets only that item | `@capawesome/capacitor-file-picker` (`pickVideos`) |

> iOS note: the modern **PHPicker** (B) deliberately needs **no** permission — that's
> why Apple recommends it. The **"Allow access" grant** (A) is the `PHPhotoLibrary`
> authorization; on iOS 14+ the user can grant **All Photos** or **Limited** (a chosen
> subset). Use A when you want library access/auto‑import; B when a single pick is enough.

---

## 1. Make the web app bundler‑built (Vite)

Capacitor plugins are npm modules, so the app needs a build step. Minimal Vite setup
keeps the same files (`index.html`, `app.js`, `app.css`, `data.js`, `supabase.js`):

```bash
cd app
npm init -y
npm i -D vite
npm i @supabase/supabase-js            # replace the esm.sh import with a real import
npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
npm i @capacitor-community/media        # approach A (library permission)
# or: npm i @capawesome/capacitor-file-picker   # approach B (system picker)
```

In `supabase.js`, swap the CDN import for the package:
```js
import { createClient } from '@supabase/supabase-js';
```
`package.json` scripts:
```json
{ "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" } }
```
`vite build` → `dist/`. (Update the Vercel project's Build Command to `vite build` and
Output to `app/dist`, or keep the static deploy and use `dist` only for the native shell.)

## 2. Add Capacitor

```bash
npx cap init Brace com.braceshooting.app --web-dir dist
npm run build
npx cap add ios
npx cap add android
npx cap sync
```

## 3. Declare the permissions

**iOS** — `ios/App/App/Info.plist`:
```xml
<key>NSPhotoLibraryUsageDescription</key>
<string>Brace reads your shooting footage from your photo library to turn it into your metrics.</string>
<key>NSPhotoLibraryAddUsageDescription</key>
<string>Brace saves processed clips back to your library when you choose to.</string>
<key>NSCameraUsageDescription</key>
<string>Brace can record a session directly through the camera.</string>
```

**Android** — `android/app/src/main/AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
<!-- Android 12 and below: -->
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
```

## 4. Request the grant + pick a clip (in `app.js`)

Replace the body of the clip picker with a native‑aware `pickClip()`:

```js
import { Capacitor } from '@capacitor/core';

async function pickClip() {
  // Native: ask for the photos/videos permission, then read a video
  if (Capacitor?.isNativePlatform?.()) {
    // ── Approach A: library permission grant ──
    const { Media } = await import('@capacitor-community/media');
    const perm = await Media.requestPermissions();        // ← the "Allow access" prompt
    if (perm?.photos !== 'granted' && perm?.photos !== 'limited') {
      throw new Error('Photos access is needed to process your footage.');
    }
    const albums = await Media.getMedias({ types: 'videos', quantity: 50 });
    // present albums[].medias to the user, then fetch the chosen item's file path/blob
    return /* a File/Blob for the selected video */;

    // ── Approach B (no prompt): system picker ──
    // const { FilePicker } = await import('@capawesome/capacitor-file-picker');
    // const res = await FilePicker.pickVideos({ limit: 1 });
    // return res.files[0];   // has .blob / .path
  }

  // Web fallback: the file input (current behaviour)
  return new Promise((resolve) => {
    const input = document.getElementById('clipInput');
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}
```

Then `runProcess(file)` uploads `file` to the private `clips` bucket and writes the
session exactly as it does today — the rest of the app is unchanged.

## 5. Build & run

```bash
npm run build && npx cap sync
npx cap open ios        # Xcode → run on device/simulator (needs a Mac + Apple dev account)
npx cap open android    # Android Studio → run
```

The first time you call `pickClip()` on device, iOS/Android shows the **"Allow access to
your photos & videos"** prompt. Granting it lets Brace read the chosen Meta‑glasses
footage and run it through processing.

---

### What ships where
- **Web (Vercel):** marketing site + web dashboard, file‑picker fallback. No permission grant — by design.
- **iOS / Android (Capacitor):** the real photos/videos permission + library access. Same code.

When you're ready, I can do the Vite + Capacitor conversion and wire `pickClip()` for you;
you'd just run the Xcode/Android Studio build on your machine.
