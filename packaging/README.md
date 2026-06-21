# Packaging

Everything for **distributing and installing Brigade** lives here, kept separate
from the application source in `src/`.

## Layout

```
packaging/
├── install/                 # one-line bootstrap installers (install Node, then Brigade)
│   ├── install.sh           # macOS / Linux  →  curl -fsSL https://brigade.spinabot.com/install.sh | sh
│   └── install.ps1          # Windows        →  irm https://brigade.spinabot.com/install.ps1 | iex
│
│   # Planned — added as each one lands:
├── windows/                 # standalone .exe / Windows installer (Node SEA or Inno Setup)
├── macos/                   # .pkg / .app bundle + notarization
├── linux/                   # .deb / .rpm / AppImage
├── homebrew/                # Homebrew formula   (brew install brigade)
└── winget/                  # winget manifest    (winget install brigade)
```

## Install scripts

`install/install.sh` and `install/install.ps1` detect Node, download the latest
Node LTS from nodejs.org if it's missing or older than 22.12, then run
`npm i -g @spinabot/brigade`. They are served from **brigade.spinabot.com**, which
points at the raw files in this folder — so the published one-liners stay stable
even if this directory is reorganized.

## Adding a new distribution target

1. Create a subfolder here (`windows/`, `homebrew/`, …).
2. Put its build manifest/script plus a short README inside it.
3. Wire the build into a `.github/workflows/` job and reference it from the main
   README's Install section.
