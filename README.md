# Babylon Game Starter

A modular, configuration-driven 3D game framework built with **Babylon.js v9**, **TypeScript**, and **Vite**.

Babylon Game Starter provides a complete, ready-to-run foundation for building interactive 3D browser games. It ships with physics-based character movement, an environment system, collectibles, inventory, a behavior trigger system, particle effects, an AudioV2-powered sound engine, and full mobile control support — all driven by configuration files.

---

## Features

- **Modular Manager Architecture** — Dedicated managers for scene, camera, audio, HUD, collectibles, inventory, behaviors, particles, and sky
- **Configuration-Driven Design** — Change characters, environments, items, sounds, and game rules entirely through config files
- **Babylon.js v9 AudioV2** — Background music with crossfading, ambient positional sounds, and sound effects via the modern `CreateSoundAsync` API
- **Physics-Based Movement** — Havok physics integration for character movement, jumping, and boost
- **Environment System** — Multiple switchable 3D worlds with per-environment music, particles, items, and sky
- **Collectibles & Inventory** — Item pickup, inventory management, and temporary effect system
- **Behavior System** — Proximity-triggered actions, credit adjustments, and visual effects
- **HUD System** — Device-adaptive display (desktop / mobile / iPad+keyboard) with individually configurable element visibility
- **Mobile Controls** — Virtual joystick, jump, and boost buttons with touch-optimized layout
- **Playground Export** — Export the entire source to `playground.json` for use in the Babylon.js web editor

---

## Tech Stack

| Package | Version |
|---|---|
| `@babylonjs/core` | ^9.1.0 |
| `@babylonjs/gui` | ^9.1.0 |
| `@babylonjs/havok` | ^1.3.12 |
| `@babylonjs/loaders` | ^9.1.0 |
| `@babylonjs/materials` | ^9.1.0 |
| `vite` | ^5.0.8 |
| `typescript` | ^5.3.3 |

---

## Quick Start

```sh
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the Vite development server |
| `npm run build` | Build for production into `dist/` |
| `npm run preview` | Preview the production build locally |
| `npm run export:playground` | Bundle TypeScript source into `playground.json` for the Babylon.js web editor |

---

## Project Structure

```
src/
  config/           # Game configuration (assets, HUD, input, physics, etc.)
  controllers/      # Character, camera, and animation controllers
  input/            # Mobile touch input manager
  managers/         # Scene, audio, HUD, collectibles, inventory, and other managers
  types/            # TypeScript type definitions
  ui/               # Settings and inventory UI components
  utils/            # Helper utilities (environment switching, notifications, etc.)
  index.ts          # Entry point
  main.ts           # Babylon.js scene bootstrap
  index.html        # App HTML shell
scripts/
  generate-playground-json.mjs  # Playground export script
public/
  playground.json   # Latest playground export
```

---

## Documentation

See [USERS_GUIDE.md](USERS_GUIDE.md) for full documentation including system architecture, configuration reference, and a narrative design guide.
