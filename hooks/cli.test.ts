import { expect, test } from 'claude-code/testing'

import { CLI_UNAVAILABLE, paneFailure, paneReason, paneOcrText, recentName, timingNote } from './cli'

test('without timings the note shows the CLI ms or a question mark', () => {
  expect(timingNote({ ms: 812 }, 1500, 0)).toBe('812 ms')
  expect(timingNote({}, 1500, 0)).toBe('? ms')
})

test('full timings list the stages in order', () => {
  const timings = { phoneShutter: 150, phoneProcessed: 900, macReady: 1100, cliTotal: 1200 }
  expect(timingNote({ timings }, 1500, 0)).toBe('shutter 150, processed 900, on Mac 1100, cli 1200, total 1500 ms')
})

test('the countdown is taken out of the CLI and mod totals, never below zero', () => {
  const timings = { phoneShutter: 150, macReady: 1100, cliTotal: 4200 }
  expect(timingNote({ timings }, 4500, 3000)).toBe(
    'shutter 150, on Mac 1100, cli 1200, total 1500 ms after the 3 s delay')
  expect(timingNote({ timings: { cliTotal: 100 } }, 200, 3000)).toBe('cli 0, total 0 ms after the 3 s delay')
})

test('missing stages are skipped', () => {
  expect(timingNote({ timings: { macReady: 700 } }, 900, 0)).toBe('on Mac 700, total 900 ms')
  expect(timingNote({ timings: {} }, 50, 0)).toBe('total 50 ms')
})

test('a reason worded for people is shown alone', () => {
  expect(paneFailure({ exitCode: CLI_UNAVAILABLE, reason: "SnapCam isn't running." })).toBe("SnapCam isn't running.")
  const off = 'Apple Intelligence is off. Turn it on in System Settings > Apple Intelligence & Siri, then try again.'
  expect(paneFailure({ exitCode: CLI_UNAVAILABLE, reason: off })).toBe(off)
  expect(paneFailure({ exitCode: CLI_UNAVAILABLE, reason: "SnapCam didn't start: SnapCam isn't running." })).toBe(
    "SnapCam didn't start: SnapCam isn't running.")
})

test('a raw reason becomes one plain line', () => {
  const cases: [number, string, string][] = [
    [CLI_UNAVAILABLE, 'No paired iPhone nearby. Open SnapCam on the iPhone.', 'No paired iPhone nearby. Open SnapCam on the iPhone.'],
    [CLI_UNAVAILABLE, 'model not ready', "SnapCam for Mac, the iPhone or the camera isn't available."],
    [75, 'The paired iPhone did not connect.', 'The paired iPhone did not connect.'],
    [75, '', "The iPhone didn't connect in time."],
    [64, 'unknown option --source', 'Unexpected arguments. Update SnapCam for Mac.'],
    [1, 'snapcam-cli exit 1', 'The camera or SnapCam reported an error.'],
    [1, '', 'The camera or SnapCam reported an error.'],
    [CLI_UNAVAILABLE, "Couldn't open SnapCam.app: The application cannot be opened.", "Couldn't open SnapCam.app: The application cannot be opened."],
    [CLI_UNAVAILABLE, "SnapCam didn't start: launchd said no", "SnapCam didn't start."],
    [1, 'The on-device model failed: GenerationError -1', 'The on-device model failed.'],
    [1, 'Timed out. Is the camera still on?', 'Timed out. Is the camera still on?'],
  ]
  for (const [exitCode, reason, said] of cases) expect(paneFailure({ exitCode, reason })).toBe(said)
})

test('model and OCR answers that explain themselves drop the exit prefix', () => {
  const none = "No text was found in the photo, so there's nothing to ask about."
  expect(paneFailure({ exitCode: 1, reason: none })).toBe(none)
  expect(paneFailure({ exitCode: 1, reason: 'No photos in /Users/me/Pictures/SnapCam' })).toBe(
    'No photos in /Users/me/Pictures/SnapCam yet.')
  expect(paneReason('unexpected answer')).toBe('SnapCam for Mac answered unexpectedly. Update the app.')
})

test('the pane text names the photo and drops area tags', () => {
  expect(paneOcrText([{ path: '/a/IMG_1.heic', paragraphs: [{ text: 'Milk', area: 'top left' }, { text: ' ' }] }, { path: '/a/b.jpg' }])).toBe(
    'Photo: IMG_1.heic\nMilk\n\nPhoto: b.jpg\n(no text found)')
})

test('gallery copy names are stable and differ for originals that slug alike', () => {
  const names = ['/D/IMG 1.jpg', '/D/IMG-1.jpg', '/D/IMG_1 .jpg', '/E/IMG 1.jpg'].map(recentName)
  expect(new Set(names).size).toBe(4)
  expect(names[0]).toMatch(/^recent-IMG-1-[0-9a-f]{6}\.jpg$/)
  expect(recentName('/D/IMG 1.heic')).toMatch(/^recent-IMG-1-heic-[0-9a-f]{6}\.jpg$/)
  expect(recentName('/D/IMG 1.jpg')).toBe(names[0])
})

test('a photo still landing reads with its file name', () => {
  expect(paneReason('The last photo is still on its way from the iPhone (/a/b/IMG_1.heic). Try again shortly.')).toBe(
    'The photo is still on its way from the iPhone (IMG_1.heic). Try again shortly.')
  expect(paneReason('still on its way from the iPhone (/x/IMG_2.jpg). Try again shortly.; broken')).toBe(
    'The photo is still on its way from the iPhone (IMG_2.jpg). Try again shortly.; broken')
  expect(paneReason("SnapCam didn't list its photos in time.")).toBe("SnapCam didn't list its photos in time.")
})
