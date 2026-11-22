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

test('only a known model reason names Apple Intelligence, alone and in Russian', () => {
  expect(paneFailure({ exitCode: CLI_UNAVAILABLE, reason: "SnapCam isn't running." })).toBe(
    'SnapCam для Mac, iPhone или камера недоступны: SnapCam не запущен.')
  expect(
    paneFailure({ exitCode: CLI_UNAVAILABLE, reason: 'Apple Intelligence is off. Turn it on in System Settings > Apple Intelligence & Siri, then try again.' }),
  ).toBe('Apple Intelligence выключен. Включи его в Системных настройках › Apple Intelligence и Siri и попробуй снова.')
  expect(paneFailure({ exitCode: CLI_UNAVAILABLE, reason: "SnapCam didn't start: SnapCam isn't running." })).toBe(
    'SnapCam для Mac, iPhone или камера недоступны: SnapCam не запустился: SnapCam не запущен.')
  expect(paneFailure({ exitCode: CLI_UNAVAILABLE, reason: 'Model not ready.' })).toBe(
    'SnapCam для Mac, iPhone или камера недоступны: Model not ready.')
})

test('model and OCR answers that explain themselves drop the exit prefix', () => {
  expect(paneFailure({ exitCode: 1, reason: "No text was found in the photo, so there's nothing to ask about." })).toBe(
    'На фото не найден текст — спрашивать не о чем.')
  expect(paneFailure({ exitCode: 1, reason: 'The on-device model declined to answer this. Try rephrasing the question.' })).toBe(
    'Модель на Mac отказалась отвечать. Попробуй спросить иначе.')
  expect(paneFailure({ exitCode: 1, reason: 'No photos in /Users/me/Pictures/SnapCam' })).toBe(
    'В папке /Users/me/Pictures/SnapCam ещё нет фото.')
  expect(paneReason("The camera didn't deliver the photo in time. It may still appear in SnapCam's history.")).toBe(
    'Камера не отдала фото вовремя. Оно ещё может появиться в истории SnapCam.')
  expect(paneReason('unexpected answer')).toBe('SnapCam для Mac ответил неожиданно — обнови приложение.')
})

test('the pane text names the photo and drops area tags', () => {
  expect(paneOcrText([{ path: '/a/IMG_1.heic', paragraphs: [{ text: 'Milk', area: 'top left' }, { text: ' ' }] }, { path: '/a/b.jpg' }])).toBe(
    'Фото: IMG_1.heic\nMilk\n\nФото: b.jpg\n(текст не найден)')
})

test('gallery copy names are stable and differ for originals that slug alike', () => {
  const names = ['/D/IMG 1.jpg', '/D/IMG-1.jpg', '/D/IMG_1 .jpg', '/E/IMG 1.jpg'].map(recentName)
  expect(new Set(names).size).toBe(4)
  expect(names[0]).toMatch(/^recent-IMG-1-[0-9a-f]{6}\.jpg$/)
  expect(recentName('/D/IMG 1.heic')).toMatch(/^recent-IMG-1-heic-[0-9a-f]{6}\.jpg$/)
  expect(recentName('/D/IMG 1.jpg')).toBe(names[0])
})

test('a photo still landing reads in Russian with its file name', () => {
  expect(paneReason('The last photo is still on its way from the iPhone (/a/b/IMG_1.heic). Try again shortly.')).toBe(
    'Фото ещё едет с iPhone (IMG_1.heic). Повтори чуть позже.')
  expect(paneReason('still on its way from the iPhone (/x/IMG_2.jpg). Try again shortly.; broken')).toBe(
    'Фото ещё едет с iPhone (IMG_2.jpg). Повтори чуть позже.; broken')
  expect(paneReason("SnapCam didn't list its photos in time.")).toBe('SnapCam не успел показать фото.')
})
