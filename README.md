# Lip Sync

A browser tool that turns dialogue audio into a mouth-shape animation using your own drawn mouths. It runs entirely in the browser (including Safari on iPad); nothing is uploaded anywhere.

## How it works

1. **Characters tab:** create a character and add a transparent PNG for each mouth shape (A–F required; G, H, X optional). Export all shapes from the same canvas size. Files named by letter (`A.png`, `mouth-B.png`) can be added in one go.
2. **Make tab:** pick the character, choose the audio (WAV, MP3, M4A), optionally paste the transcript, choose the frame rate and press Generate.
3. Check the preview, tap any frame to correct its shape, then **Download GIF** and import it into Procreate Dreams.

Characters are stored in the browser on the device you use. Use **Export backup** to keep a copy or move a character to another device. On iPad, add the page to the Home Screen so Safari keeps the stored characters.

## Notes

- Speech analysis is [Rhubarb Lip Sync](https://github.com/DanielSWolf/rhubarb-lip-sync) by Daniel S. Wolf, via the [WebAssembly port](https://github.com/danieloquelis/rhubarb-lip-sync-wasm) by Daniel Oquelis (both MIT). The speech model (~37 MB) downloads on first use and is then cached.
- GIF output uses [gifenc](https://github.com/mattdesl/gifenc) (MIT). GIF transparency is on/off per pixel, so soft antialiased edges are hardened.
- The output GIF has one frame per animation frame at the chosen frame rate.
