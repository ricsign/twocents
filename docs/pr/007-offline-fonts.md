# PR #7 — fix: self-host the fonts so nothing depends on venue wifi

## Summary

`next/font/google` fetches from `fonts.googleapis.com` at build time and
serves from Google's CDN at runtime. Both are network dependencies the demo
does not need and cannot control from a hackathon floor.

The three families were already sitting in the design bundle as latin-subset
woff2 files, so they are now extracted into `public/fonts/` and loaded with
`next/font/local`. Nunito and Pixelify Sans are variable fonts — one file
each covers the whole weight range.

Total: 56KB for all three families.

## Also in it

`docs/ARCHITECTURE.md` gains a note that the app must build and run with no
outbound network at all, which is now true: no font fetch, and the model
layer already falls back to canned answers without an API key.

## Verification

`next build` succeeds with no outbound requests. Five routes generated.
