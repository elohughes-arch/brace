# Viewing the Brace app

**You do NOT need an Apple Developer account or App Store approval to view/test this.**
Approval is only for publishing to the public App Store later.

## Fastest: on your phone with Expo Go (free)

1. Install **Expo Go** — App Store (iPhone) or Play Store (Android).
2. On a computer with this repo:
   ```bash
   cd mobile
   npm install
   npx expo install   # aligns native module versions for SDK 56
   npx expo start      # add --tunnel if your phone isn't on the same Wi-Fi
   ```
3. Scan the QR code (iPhone Camera app / the Expo Go scanner) → the app opens on
   your phone, live, with the real photo picker + permission prompt.

Expo Go supports everything this app uses (navigation, SVG rings, image picker,
media library, video). Edits hot-reload instantly.

## iOS Simulator / Android Emulator (optional, needs a Mac/Android Studio)

```bash
npx expo start  # then press i (iOS simulator) or a (Android emulator)
```
No Apple account needed for the simulator.

## Browser preview (UI only)

`npx expo start --web` runs a web version — useful for a quick look at the screens,
but the native camera-roll permission/import don't work in a browser.

## When you're ready to share / ship

- **TestFlight / internal testing** (share with other people): needs an Apple
  Developer account ($99/yr) and an EAS build (`eas build`), but **no App Store review**.
- **Public App Store / Play Store**: needs review.

## Backend

Auth/data run on the **Brace** Supabase project (already wired). Sign-up sends a
confirmation email by default — toggle "Confirm email" off in Supabase Auth
settings for instant access while testing.
