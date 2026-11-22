import { expect, test } from 'claude-code/testing'

import { CLI_UNAVAILABLE, paneFailure, paneReason, timingNote } from './cli.ts'

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

test('ask blames Apple Intelligence only for reasons that are not transport ones', () => {
  expect(paneFailure({ exitCode: CLI_UNAVAILABLE, reason: "SnapCam isn't running." }, 'ask')).toBe(
    'SnapCam для Mac, iPhone или камера недоступны: SnapCam не запущен.')
  expect(paneFailure({ exitCode: CLI_UNAVAILABLE, reason: 'Model not ready.' }, 'ask')).toBe(
    'Apple Intelligence выключен или недоступен: Model not ready.')
})

test('a photo still landing reads in Russian with its file name', () => {
  expect(paneReason('The last photo is still on its way from the iPhone (/a/b/IMG_1.heic). Try again shortly.')).toBe(
    'Фото ещё едет с iPhone (IMG_1.heic). Повтори чуть позже.')
  expect(paneReason('still on its way from the iPhone (/x/IMG_2.jpg). Try again shortly.; broken')).toBe(
    'Фото ещё едет с iPhone (IMG_2.jpg). Повтори чуть позже.; broken')
  expect(paneReason("SnapCam didn't list its photos in time.")).toBe('SnapCam не успел показать фото.')
})
