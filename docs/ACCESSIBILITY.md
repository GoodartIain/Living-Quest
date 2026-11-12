# Accessibility audit (Milestone 13)

## Automated: WCAG 2.1 A and AA rules (axe-core 4.10.3)

`scripts/a11y-audit.js` opens 18 screens as the GM, a player and a spectator, plus the livestream page, and runs every
WCAG 2.1 A/AA rule axe-core has (contrast, names and labels, roles, landmarks, focusable controls, ARIA validity…).

Result: **no violations on any of the 18 screens**: sign-in, world list, world map, town and inhabitants, wiki page,
character sheet, character creation, 2D scene (GM and spectator), chat panel, Director Mode, downtime (GM and player),
NPCs and editor, quests and adventure editor, world simulation with a preview, account, livestream page.

Found and fixed: the world map was marked as a picture (`role="img"`) while it contains clickable place pins, which
hides the pins from screen readers; it is now a labelled group.

Run it: `PORT=3926 npm start`, then `BASE_URL=http://localhost:3926 node scripts/a11y-audit.js` (needs Playwright with
Chromium; `npm install` brings axe-core).

## Keyboard

Checked by hand and by script:

- Every screen is reachable and usable with Tab, Shift+Tab, Enter and Space; all controls are real buttons, links and
  form fields with visible labels.
- World and town maps: place pins are focusable buttons (Enter opens them).
- 2D board: your own tokens are focusable; **arrow keys move them one square** (added in this audit; the label reads
  the token's name and square, and focus stays on it after each move). Interaction triggers are focusable (Enter uses
  them).
- 3D first person: W A S D or arrow keys move, Q and E turn; the mouse is only needed for looking up and down.
- The live regions (dice results, board readout, trigger results, chat) announce changes to screen readers.

## Known gaps

- **GM board tools need a pointer:** drawing walls, revealing fog, measuring and placing tokens/triggers are drag or
  click gestures on the board (2D or 3D). The same changes can be made through the API but not yet with the keyboard.
- **The 3D views are a canvas:** screen readers get a description of the controls, not the scene. The 2D board shows the
  same information and is the accessible view.
- **Colour:** fog, HP bars and token outlines rely partly on colour; names, numbers and titles carry the same information.
- **Not yet done:** testing with screen readers (NVDA, VoiceOver), with browser zoom at 200%, and in Firefox and Safari;
  captions for voice/video (LiveKit) are not provided.
